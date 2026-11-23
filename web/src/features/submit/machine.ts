/**
 * 送出的狀態機：草稿、三道鎖、上次沒送出去的那一句、`@子代理` 標記的取用與放回。不依賴 React：外面包一層薄 hook
 * （`use-submit.ts`），測試直接打 {@link createSubmitMachine}。
 *
 * 獨立頁面與嵌入版共用同一份；嵌入版的差異全由 {@link SubmitOptions} 表達（不給 `commands` 就不認命令、不給
 * `attachments` 就沒有附件、`mode` 固定、多帶 `context` 與 `hostTools`），不另寫第二條路。
 *
 * @module
 */
import type { SubmitGesture } from '@/features/composer';
import { retainedSuffix, toMention } from '@/features/composer';
import type { MentionAgent } from '@/features/composer';
import { FEEDBACK_COMMAND_LINE, commandToken } from '@/shared/connection/command-line';
import type { PendingRequest, Sentence } from '@/shared/connection/request-id';
import { requestIdFor } from '@/shared/connection/request-id';
import type {
  Adjudication,
  Conversation,
  SendRejected,
} from '@/shared/connection/use-conversation';

import type { SubmitReport } from './report';

type SendArgs = Parameters<Conversation['send']>;

/** 附件準備的結果；形狀同 `features/attachments` 的 `prepareAttachments`。 */
export type PreparedAttachments =
  | { readonly kind: 'ok'; readonly attachments: NonNullable<SendArgs[2]> }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'cancelled' };

/** 草稿附件那一端：送出時取、上傳、結算。不給就沒有附件這一段。 */
export interface AttachmentSource<A extends { readonly id: string }> {
  /** 現在草稿裡的附件；功能沒開就回空陣列。 */
  readonly items: () => readonly A[];
  /** 上傳與編碼這一批；上傳的進度與取消跟著這一句（`uploads.begin()`）。 */
  readonly prepare: (items: readonly A[]) => Promise<PreparedAttachments>;
  /** 這一句沒送成：還在上傳或已上傳的卡回到未上傳；沒給原因是上傳都成功、伺服器沒收下。 */
  readonly onRefused: (reason?: 'cancelled' | 'failed') => void;
  /** 伺服器收下了：這一批離開草稿，送出期間才加進來的留著。 */
  readonly onAccepted: (ids: readonly string[]) => void;
}

/** 開頭像命令的那一行怎麼認。不給就一律是一句話。 */
export interface CommandSource {
  /** 等命令清單認這一行（{@link Adjudication}）。 */
  readonly adjudicate: (line: string) => Promise<Adjudication>;
  /** 照目前手上的清單，這一行開頭是不是命令（沒經過認的那一條路用）。 */
  readonly names: (line: string) => boolean;
}

export interface SubmitOptions<A extends { readonly id: string } = { readonly id: string }> {
  readonly send: Conversation['send'];
  /** 這一行現在送得出去嗎（連線、一輪的狀態、命令的規矩）；不含鎖與 {@link SubmitOptions.enabled}。 */
  readonly allowed: (line: string) => boolean;
  /** 整個輸入框停用（封存的會話）。只擋送出，不擋 {@link SubmitMachine.runCommand}。 */
  readonly enabled: boolean;
  /** 這一下手勢要排隊還是插話；按下去那一刻就定。 */
  readonly mode: (gesture: SubmitGesture) => NonNullable<SendArgs[1]>;
  /** 沒送成時講一聲；一句新的送出去時以 `undefined` 叫一次，讓畫法清掉上一句的訊息。 */
  readonly report: (report: SubmitReport | undefined) => void;
  /**
   * 先攔一行（`/model`，屬於 `seats`）：不是它要的回 `undefined`（走一般流程）；打不開、找不到那顆回 `false`
   * （那一行留在草稿）；其餘回 `true`。
   */
  readonly intercept?: (line: string) => boolean | undefined;
  readonly commands?: CommandSource;
  readonly attachments?: AttachmentSource<A>;
  /** 嵌入版：每一句 `run.start` 附上的畫面情境與宿主頁工具。 */
  readonly context?: SendArgs[6];
  readonly hostTools?: SendArgs[7];
}

export interface SubmitSnapshot {
  readonly draft: string;
  /** `@子代理` 標記：這一輪委派給誰。 */
  readonly mentionedAgent: MentionAgent | undefined;
  /** 認命令或命令在途：輸入框整個鎖住（dsh `InputBar.tsx:147` 的 `machineBusy`）。 */
  readonly locked: boolean;
  /** 附件送出中：附件列上的移除不收。 */
  readonly removalLocked: boolean;
}

export interface SubmitMachine {
  readonly getSnapshot: () => SubmitSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setDraft: (draft: string) => void;
  readonly selectAgent: (agent: MentionAgent | undefined) => void;
  /** 送出現在的草稿。`canSend` 為真才該叫，這裡再擋一次：同一個 tick 裡的第二下不會等到重畫。 */
  readonly submit: (gesture: SubmitGesture) => void;
  /**
   * 從選單直接執行一行（不經草稿）：走斜線那一道閘。認命令或命令在途的期間不收（#1941；dsh 那段期間整個 editor 鎖著，
   * 選單沒有入口，`InputBar.tsx:147`、`:154`）。回有沒有收下。
   */
  readonly runCommand: (line: string) => boolean;
}

/** 附件那一批送出失敗但人只是取消時的說明。 */
const CANCELLED_MESSAGE = '附件還在，再按送出會重新上傳。';

type Outcome = SendRejected | { readonly message: string; readonly cancelled: true } | undefined;

/**
 * @param read - 讀「現在」的選項。每次動作時才讀，所以呼叫端可以隨畫面換掉裡面的函式與值。
 */
export function createSubmitMachine<A extends { readonly id: string }>(
  read: () => SubmitOptions<A>,
): SubmitMachine {
  let snapshot: SubmitSnapshot = {
    draft: '',
    mentionedAgent: undefined,
    locked: false,
    removalLocked: false,
  };
  const listeners = new Set<() => void>();
  const patch = (next: Partial<SubmitSnapshot>) => {
    const merged = { ...snapshot, ...next };
    if ((Object.keys(merged) as (keyof SubmitSnapshot)[]).every((k) => merged[k] === snapshot[k])) {
      return;
    }
    snapshot = merged;
    for (const listener of [...listeners]) listener();
  };

  /**
   * 開頭像命令的那一行在等命令清單認（#1929，dsh 送出狀態機的 `adjudicating`）：等的期間不再送任何一行、草稿不動。
   * 前一句晚到的拒收不能在鎖住期間改寫畫面（dsh `draftInitializationBlocked`）。
   */
  let adjudicating = false;
  /**
   * 認出是命令、`slash.run` 還在途（[#1941](https://github.com/DemianLi/nexus-agent/issues/1941)，dsh 送出狀態機的
   * `submitting`，`input/machine.ts:138`）：等的期間不收下一次送出、輸入框鎖住；收下才清草稿，沒收下草稿不動。只管不帶附件的
   * 命令：帶附件的由 `removalLocked` 擋（#733）。
   */
  let submitting = false;
  const syncLocked = () => patch({ locked: adjudicating || submitting });
  // 上次沒送出去的那一句和它的請求編號（#1335）：原樣重送時沿用，伺服器才認得是同一句；收下了就丟掉。
  let pendingRequest: PendingRequest | undefined;

  const setDraftWith = (update: (current: string) => string) =>
    patch({ draft: update(snapshot.draft) });

  const submit = (gesture: SubmitGesture): void => {
    const options = read();
    // 鎖是同步的：同一個 tick 裡的第二下不必等重畫（#1941）。
    if (
      !options.allowed(snapshot.draft) ||
      !options.enabled ||
      snapshot.removalLocked ||
      adjudicating ||
      submitting
    ) {
      return;
    }
    const text = snapshot.draft;
    const modelRan = options.intercept?.(text);
    if (modelRan !== undefined) {
      // 打開座位或換好了就清掉；找不到那顆（`false`）留著讓人改。
      if (modelRan) patch({ draft: '' });
      return;
    }
    // 跑著時 Cmd/Ctrl+Enter 是插話（#710）：這一輪不停，那句下一步送進模型。按下去那一刻就定。
    const mode = options.mode(gesture);
    // 認命令那一段的期間輸入框鎖著，這裡讀到的附件、標記就是畫面上的值。
    const feedbackOnly = text.trim() === FEEDBACK_COMMAND_LINE;
    // 只有功能開著才帶附件；`/` 開頭的命令也帶（#733：命令有宣告收附件才收，其餘伺服器回錯誤、草稿與附件留著），
    // 只有光打 `/feedback`（開回饋框、不送出）不帶，附件留在草稿裡。
    const items =
      options.attachments !== undefined && !feedbackOnly ? options.attachments.items() : [];
    const mentionedAgent = snapshot.mentionedAgent;
    const names = options.commands?.names(text) === true;

    // `route` 是等清單認出來的結果（沒認就是 `undefined`），一路交給 `send`，不再認第二次（#1929）。不認命令的組裝一律是一句話。
    const proceed = (route: 'command' | 'sentence' | undefined, detached = false) => {
      // 開頭是不是命令照送出路由認（#1929）：技能的 `/deploy 今天` 是一句話。
      const isCommand = route === undefined ? names : route === 'command';
      // 沒宣告 input、整行只有 `/名字` 的命令照 dsh 的 detached（`ui-commands/src/client/service.ts:361-365` 先
      // `consumeVia` 再 `runDetached`，`input/machine.ts:155-175` 收到 `'handled'` 就回 plain，#1971）：當場拿掉、
      // 背景執行，不進在途、不鎖輸入框；沒收下由狀態列講（`runSlash`），草稿不放回去。
      if (detached && items.length === 0) {
        patch({ draft: '' });
        pendingRequest = undefined;
        void options.send(text, mode, undefined, undefined, undefined, route);
        return;
      }
      // 有 input 的命令照 dsh 的 `submitting`（`input/machine.ts:138`、`:183-192`，#1941）：在途期間不收下一次送出、
      // 輸入框鎖住、草稿不動；收下（命令成功）才清掉送出的那段，沒收下草稿原樣，原因由狀態列講（`runSlash`），
      // 不另跳 toast。在認命令那一段的回呼裡同步進來，兩段之間沒有空檔。
      if (isCommand && items.length === 0) {
        submitting = true;
        syncLocked();
        pendingRequest = undefined;
        void options
          .send(text, mode, undefined, undefined, undefined, route)
          .then((rejected) => {
            if (rejected === undefined) {
              setDraftWith((current) => retainedSuffix(current, text));
            }
          })
          .finally(() => {
            submitting = false;
            syncLocked();
          });
        return;
      }
      patch({ draft: '' });
      // 命令不帶提及（留著，同附件）；否則這一句送出就用掉它。技能的 `/deploy 今天` 照樣帶。
      const mentioned = isCommand ? undefined : mentionedAgent;
      if (mentioned !== undefined) patch({ mentionedAgent: undefined });
      // 跟上次沒送出去的那一句完全相同才沿用它的編號；改過字、換了點名、增減附件都是新的一句（#1335）。
      const sentence: Sentence = {
        text,
        mention: mentioned?.name,
        attachmentIds: items.map((item) => item.id),
      };
      const requestId = requestIdFor(pendingRequest, sentence);
      pendingRequest = undefined;
      options.report(undefined);
      const sendWith = (attachments: SendArgs[2]) => {
        const mention = mentioned === undefined ? undefined : toMention(mentioned);
        return options.context === undefined && options.hostTools === undefined
          ? options.send(text, mode, attachments, mention, requestId, route)
          : options.send(
              text,
              mode,
              attachments,
              mention,
              requestId,
              route,
              options.context,
              options.hostTools,
            );
      };
      void (async (): Promise<Outcome> => {
        const source = options.attachments;
        if (items.length === 0 || source === undefined) return sendWith(undefined);
        patch({ removalLocked: true });
        try {
          const prepared = await source.prepare(items);
          if (prepared.kind === 'cancelled') {
            source.onRefused('cancelled');
            return { message: CANCELLED_MESSAGE, cancelled: true };
          }
          if (prepared.kind === 'failed') {
            source.onRefused('failed');
            return { message: prepared.message };
          }
          const rejected = await sendWith(prepared.attachments);
          // 收下了才移掉這一批；送出期間才加進來的留著。沒收下就全留著，連同草稿。
          if (rejected === undefined) {
            source.onAccepted(items.map((item) => item.id));
          } else {
            // 上傳都成功了，是伺服器沒收下這一句：卡片沒有哪裡出錯。
            source.onRefused();
          }
          return rejected;
        } finally {
          patch({ removalLocked: false });
        }
      })().then((rejected) => {
        if (rejected === undefined) return;
        // 「沒送出去」可能其實到了、只是回條斷了：留著編號，原樣重送這一句時帶同一個。
        pendingRequest = { id: requestId, sentence };
        // 沒收下（#645 Q4）：草稿放回去——人已經開始打下一句的話不蓋掉——並說出原因。
        setDraftWith((current) => (current === '' ? text : current));
        // 標記不放回鎖住的輸入框：那一行送出時帶的是按 Enter 當下的標記，放回去畫面就跟送出的對不上
        // （dsh `facade.ts:301-304` 的 `draftInitializationBlocked`，#1929）。草稿那一行不用擋：鎖住時草稿一定不是空的。
        if (mentioned !== undefined && !adjudicating && !submitting) {
          if (snapshot.mentionedAgent === undefined) patch({ mentionedAgent: mentioned });
        }
        if ('cancelled' in rejected) {
          options.report({ kind: 'cancelled', message: rejected.message });
        } else if (rejected.uncertain === true) {
          // 斷在網路層：可能其實到了。不說「沒送出去」，說原樣重送是安全的（#1335）。
          options.report({ kind: 'uncertain', message: rejected.message });
        } else {
          options.report({ kind: 'rejected', message: rejected.message });
        }
      });
    };

    // 開頭像命令的那一行先等命令清單認（dsh 的 `adjudicate`）：等的期間 `canSend` 是關的、輸入框整個鎖住（`locked`），
    // Enter 不動作、草稿不動；認完才照命令或一句話送。抓不到清單就說原因，草稿、附件、標記都沒動過。光打
    // `/feedback` 是開對話框，不用認。
    if (options.commands !== undefined) {
      if (commandToken(text) !== undefined && !feedbackOnly) {
        adjudicating = true;
        syncLocked();
        void options.commands.adjudicate(text).then((verdict) => {
          adjudicating = false;
          syncLocked();
          if (verdict.kind === 'released') return;
          if (verdict.kind === 'failed') {
            options.report({ kind: 'rejected', message: verdict.message });
            return;
          }
          proceed(verdict.kind, verdict.kind === 'command' && verdict.detached);
        });
        return;
      }
      proceed(undefined);
      return;
    }
    proceed('sentence');
  };

  const runCommand = (line: string): boolean => {
    const options = read();
    if (adjudicating || submitting || !options.allowed(line)) return false;
    const modelRan = options.intercept?.(line);
    if (modelRan !== undefined) return modelRan;
    void options.send(line);
    return true;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft: (draft) => patch({ draft }),
    selectAgent: (agent) => patch({ mentionedAgent: agent }),
    submit,
    runCommand,
  };
}
