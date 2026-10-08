import type { ConversationState, TrajectoryCall } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RightSidebarToggle } from '@/components/sidebar/right-sidebar';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { tokenParts } from '@/lib/trajectory-view';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import { call, tool, turn, view, withTrajectory } from '@/test/trajectory-fixtures';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const open: SidebarLayout = { open: true, tabs: [{ kind: 'trace' }], active: 'trace' };

type TurnSpec = Parameters<typeof turn>[1];

/** 每輪一次呼叫、一顆工具；`usage` 給的是那次呼叫的用量。 */
function conversation(specs: { turn?: TurnSpec; usage?: TrajectoryCall['usage'] }[]) {
  const script = new Script();
  const frames = [script.running()];
  const turns = specs.map((spec, i) => {
    frames.push(...script.human(`inbox:r${i}`, `第 ${i} 句`));
    frames.push(script.started(`c${i}`, 'echo', {}));
    frames.push(script.finished(`c${i}`, 'ok'));
    return turn(i, {
      calls: [
        call(5 + i * 10, {
          tools: [tool(`c${i}`, { name: 'echo' })],
          ...(spec.usage === undefined ? {} : { usage: spec.usage }),
        }),
      ],
      ...spec.turn,
    });
  });
  frames.push(script.completed());
  return withTrajectory(reduceAll(emptyConversation(), frames), script, view(turns));
}

function mount(state: ConversationState) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(open));
  return render(
    <WithRightSidebar sources={{ conversation: createConversationStore(state) }}>
      <RightSidebarToggle />
    </WithRightSidebar>,
  );
}

/** 展開第一次呼叫，回傳說明內文與收著時那一行。 */
function expandFirstCall() {
  const row = screen
    .getAllByTestId('trace-row')
    .find((candidate) => candidate.getAttribute('data-kind') === 'call')!;
  fireEvent.click(within(row).getByRole('button', { name: /^模型呼叫 #1/ }));
  return {
    details: within(row).getByTestId('trace-call-details').textContent!,
    summary: within(row).getByTestId('trace-time').textContent!,
  };
}

const full = (inputTokens: number): TrajectoryCall['usage'] => ({
  inputTokens,
  outputTokens: 50,
  totalTokens: inputTokens + 50,
  uncachedInputTokens: 200,
  cacheReadTokens: 700,
  cacheWriteTokens: 100,
});

/** 一輪的加總：跟 {@link full} 同一組四桶，只有 `inputTokens` 隨傳入的值變。 */
const turnBuckets = (inputTokens: number): TurnSpec => ({
  inputTokens,
  outputTokens: 50,
  uncachedInputTokens: 200,
  cacheReadTokens: 700,
  cacheWriteTokens: 100,
});

describe('觀測分頁：呼叫與輪的快取命中率（#724）', () => {
  it('新 server：呼叫說明列出未快取輸入、快取讀、快取寫、輸出與命中率，收著那行也寫命中', async () => {
    mount(conversation([{ usage: full(1000) }]));
    await act(async () => {});
    const { details, summary } = expandFirstCall();
    expect(details).toContain('輸入 token200');
    expect(details).toContain('快取讀 token700');
    expect(details).toContain('快取寫 token100');
    expect(details).toContain('輸出 token50');
    expect(details).toContain('快取命中率70.0%');
    expect(summary).toContain('輸入 200／輸出 50 · 快取命中 70.0%');
  });

  it('釘住：span 的 inputTokens 從完整 prompt 改成只算未快取，畫面上的數字一個字都不變', async () => {
    mount(conversation([{ usage: full(1000), turn: turnBuckets(1000) }]));
    await act(async () => {});
    expandFirstCall();
    const before = document.body.textContent;
    cleanup();
    mount(conversation([{ usage: full(200), turn: turnBuckets(200) }]));
    await act(async () => {});
    expandFirstCall();
    expect(document.body.textContent).toBe(before);
    expect(before).toContain('快取命中率70.0%');
  });

  it('只記了一桶：另一桶寫「沒記」，命中率也寫「沒記」，不寫 0%', async () => {
    const { cacheWriteTokens: _unused, ...withoutWrite } = full(1000)!;
    mount(conversation([{ usage: withoutWrite }]));
    await act(async () => {});
    const { details, summary } = expandFirstCall();
    expect(details).toContain('快取讀 token700');
    expect(details).toContain('快取寫 token沒記');
    expect(details).toContain('快取命中率沒記');
    expect(details).not.toContain('0.0%');
    expect(summary).toContain('快取命中 沒記');
  });

  it('兩桶都沒記（供應商不報快取）：兩格寫「沒記」，不畫命中率', async () => {
    mount(
      conversation([
        {
          usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350, uncachedInputTokens: 300 },
        },
      ]),
    );
    await act(async () => {});
    const { details, summary } = expandFirstCall();
    expect(details).toContain('輸入 token300');
    expect(details).toContain('快取讀 token沒記');
    expect(details).toContain('快取寫 token沒記');
    expect(details).not.toContain('快取命中率');
    expect(summary).not.toContain('快取命中');
  });

  it('命中是 0：寫 0.0%，跟「沒記」分開', async () => {
    mount(
      conversation([
        {
          usage: {
            inputTokens: 300,
            outputTokens: 50,
            totalTokens: 350,
            uncachedInputTokens: 300,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      ]),
    );
    await act(async () => {});
    expect(expandFirstCall().details).toContain('快取命中率0.0%');
  });

  it('舊 server（沒有未快取那一格）：照舊讀 inputTokens，不畫快取兩行與命中率', async () => {
    mount(conversation([{}]));
    await act(async () => {});
    const { details, summary } = expandFirstCall();
    expect(details).toContain('輸入 token10');
    expect(details).toContain('輸出 token5');
    expect(details).not.toContain('快取');
    expect(summary).not.toContain('快取');
  });

  it('一輪的標頭：輸入寫未快取、另寫命中率；舊 server 的輪不畫命中率', async () => {
    mount(
      conversation([
        {
          usage: full(1000),
          turn: {
            inputTokens: 1000,
            outputTokens: 50,
            uncachedInputTokens: 200,
            cacheReadTokens: 700,
            cacheWriteTokens: 100,
          },
        },
        {},
      ]),
    );
    await act(async () => {});
    const [first, second] = screen.getAllByTestId('trace-turn-head');
    expect(first!.textContent).toContain('輸入 200／輸出 50');
    expect(within(first!).getByTestId('trace-cache-hit').textContent).toBe('快取命中 70.0%');
    expect(within(second!).queryByTestId('trace-cache-hit')).toBeNull();
    expect(second!.textContent).toContain('輸入 10／輸出 5');
  });

  it('核准後續接併回同一輪：三桶相加再算命中率；只有一段記了就是沒記', async () => {
    const part = (read: number | undefined): TurnSpec => ({
      inputTokens: 100,
      outputTokens: 10,
      uncachedInputTokens: 100,
      ...(read === undefined ? {} : { cacheReadTokens: read, cacheWriteTokens: 0 }),
    });
    mount(
      conversation([
        { turn: part(100) },
        { turn: { ...part(300), kind: 'resume', logical: false } },
      ]),
    );
    await act(async () => {});
    const heads = screen.getAllByTestId('trace-turn-head');
    expect(heads).toHaveLength(1);
    // 未快取 200、快取讀 400、快取寫 0：400 ÷ 600。
    expect(heads[0]!.textContent).toContain('輸入 200／輸出 20');
    expect(within(heads[0]!).getByTestId('trace-cache-hit').textContent).toBe('快取命中 66.7%');
    cleanup();
    mount(
      conversation([
        { turn: part(100) },
        { turn: { ...part(undefined), kind: 'resume', logical: false } },
      ]),
    );
    await act(async () => {});
    // 一段沒記快取：加起來沒有一個完整的分母，不畫百分比數字，也不能拿一段的數字當總數。
    expect(screen.queryByTestId('trace-cache-hit')).toBeNull();
  });
});

describe('tokenParts', () => {
  it('完全沒報用量：輸入與輸出寫「—」，不畫快取', () => {
    expect(tokenParts({})).toEqual({ input: '—', output: '—' });
  });

  it('不讀 inputTokens：未快取那一格有就用它', () => {
    expect(
      tokenParts({
        inputTokens: 9999,
        outputTokens: 1,
        uncachedInputTokens: 10,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
      }),
    ).toEqual({
      input: '10',
      output: '1',
      cache: { read: '30', write: '0' },
      hitRate: '75.0%',
    });
  });
});
