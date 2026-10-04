import type { Event } from '@nexus/wire';

/**
 * 真的線上形狀的 frame 建構器：測試拿它**折進 `reduceAll`**，不手寫 `entries`（手寫的 fixture 會與折疊器漂移，
 * `@nexus/wire` 的 `conversation.ts` 檔頭講的就是這件事）。形狀照 `conversation.test.ts` 與 `history-ui.test.tsx`。
 *
 * 每個建構器自己領 `seq`（單調遞增），所以同一個 `Script` 建出來的 frame 可以直接丟給 `reduceAll`；
 * 另開一個 `Script` 就是「重新整理之後從頭重放」。
 */
export class Script {
  #seq = 0;

  frame(method: string, data: unknown, namespace: readonly string[] = []): Event {
    const seq = this.#seq++;
    return {
      type: 'event',
      seq,
      event_id: `s:${seq}`,
      method,
      params: { namespace, timestamp: 0, data },
    } as Event;
  }

  running(): Event {
    return this.frame('lifecycle', { event: 'running', graph_name: 'root' });
  }

  completed(): Event {
    return this.frame('lifecycle', { event: 'completed', graph_name: 'root' });
  }

  /** 按了停止收尾（`aborted` 由 pump 補）。 */
  stopped(): Event {
    return this.frame('lifecycle', { event: 'failed', graph_name: 'root', aborted: true });
  }

  /** 一輪撞到輸出上限而收尾（`maxTokens` 由 pump 補）。 */
  cutOff(): Event {
    return this.frame('lifecycle', { event: 'completed', graph_name: 'root', maxTokens: true });
  }

  /** 人的話。 */
  human(id: string, text: string): Event[] {
    return [
      this.frame('messages', { event: 'message-start', role: 'human', id }),
      this.frame('messages', {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text },
        id,
      }),
      this.frame('messages', { event: 'message-finish', reason: 'stop', id }),
    ];
  }

  /** 模型的一則回覆；`text` 與 `reasoning` 都可以省。 */
  ai(
    runId: string,
    {
      text,
      reasoning,
      namespace = ['model_request:x'],
    }: { text?: string; reasoning?: string; namespace?: readonly string[] },
  ): Event[] {
    const events: Event[] = [
      this.frame(
        'messages',
        { event: 'message-start', id: `run-${runId}`, run_id: runId },
        namespace,
      ),
    ];
    if (reasoning !== undefined) {
      events.push(
        this.frame(
          'messages',
          {
            event: 'content-block-delta',
            index: 1,
            delta: { type: 'reasoning-delta', reasoning },
            run_id: runId,
          },
          namespace,
        ),
      );
    }
    if (text !== undefined) {
      events.push(
        this.frame(
          'messages',
          {
            event: 'content-block-delta',
            index: 0,
            delta: { type: 'text-delta', text },
            run_id: runId,
          },
          namespace,
        ),
      );
    }
    events.push(
      this.frame('messages', { event: 'message-finish', reason: 'stop', run_id: runId }, namespace),
    );
    return events;
  }

  /** 還在吐字的一則（沒有 `message-finish`），之後可以用 {@link Script.delta} 續。 */
  openAi(runId: string): Event {
    return this.frame('messages', { event: 'message-start', id: `run-${runId}`, run_id: runId }, [
      'model_request:x',
    ]);
  }

  delta(runId: string, text: string): Event {
    return this.frame(
      'messages',
      {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text },
        run_id: runId,
      },
      ['model_request:x'],
    );
  }

  started(callId: string, name: string, input: unknown): Event {
    return this.frame(
      'tools',
      {
        event: 'tool-started',
        tool_call_id: callId,
        tool_name: name,
        input: typeof input === 'string' ? input : JSON.stringify(input),
      },
      ['tools:a'],
    );
  }

  finished(callId: string, message: string): Event {
    return this.frame('tools', { event: 'tool-finished', tool_call_id: callId, message }, [
      'tools:a',
    ]);
  }

  failed(callId: string, message: string, code?: string): Event {
    return this.frame(
      'tools',
      {
        event: 'tool-finished',
        tool_call_id: callId,
        failed: true,
        message,
        ...(code === undefined ? {} : { code }),
      },
      ['tools:a'],
    );
  }

  /** 停在核准點：一顆核准請求。 */
  approval(interruptId: string, toolName: string): Event {
    return this.frame(
      'input.requested',
      {
        interrupt_id: interruptId,
        payload: {
          actionRequests: [{ name: toolName, args: {} }],
          reviewConfigs: [{ actionName: toolName, allowedDecisions: ['approve', 'reject'] }],
        },
      },
      ['tools:a'],
    );
  }

  /** 停在問答點：兩題。 */
  question(interruptId: string): Event {
    return this.frame(
      'input.requested',
      {
        interrupt_id: interruptId,
        payload: {
          kind: 'question',
          questions: [
            { id: 'day', question: '哪一天？', options: [{ label: '週一' }, { label: '週二' }] },
          ],
        },
      },
      ['tools:a'],
    );
  }

  /** `custom` frame（壓縮、交付、改動紀錄……）。 */
  custom(name: string, payload: unknown): Event {
    return this.frame('custom', { name, payload });
  }
}
