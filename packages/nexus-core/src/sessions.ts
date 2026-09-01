/**
 * `sessions` 通道的詞彙與接線：**哪些 plugin 拿得到這個會話的日誌**。
 *
 * 這是第十四個註冊點，而它補的是一個一直都在的缺口：註冊表的另外十三個通道，沒有一個
 * 的名字說得出「我要讀寫會話日誌」。
 *
 * ## 為什麼不沿用 `invariants`
 *
 * **寫這個通道的時候，技術上沿用得了**——{@link ./invariants.ts | InvariantSubject} 交出的
 * 就是一份完整的、可寫的 {@link ./session-log.ts | SessionLog}，上面有 `append()`。所以
 * 「plugin 拿不到日誌」從來不是真的；真的那件事是**沒有一個通道的名字承認它**。沿用有
 * 兩個代價：
 *
 * 1. **名不副實。** 「誰能寫會話日誌」會永遠藏在一個叫不變量的通道裡，而那個通道的
 *    文件從頭到尾在講「只觀察、否決不了」。
 * 2. **拒絕沒有地方回。** 那條路的 `fail` 型別是 `never`——它只表達得出「約定破了」。
 *    goal 這種域有大量**可預期的拒絕**（`GOAL_STALE_REVISION` 是正常的併發結果，不是
 *    誰的 bug），那些要回給呼叫的人，不是回給違規回報器。
 *
 * **現在連技術上都沿用不了了。** [#127](https://github.com/DemianLi/nexus-agent/issues/127)
 * 把 `InvariantSubject.log` 收窄成 {@link ./session-log.ts | SessionLogView}，那條路上沒有
 * `append()`。那不是後來多長出來的限制，是同一個判斷的另一半：上面第 1 點說那個通道名不
 * 副實，收窄就是把型別改成跟名字一致。**要寫會話日誌的路今天只有這一條。**
 *
 * ## 與 dsh 的偏離
 *
 * dsh 那側對應的是 `ctx.sessions` 服務加 `sessionProjections` 投影註冊表：一次註冊看得到
 * **所有** session（`ctx.sessions.list()` ＋ `session/created`），投影帶 `stateVersion`
 * 與 `wire.view`，由註冊表負責重放與 checkpoint。我們兩樣都沒有——日誌是
 * `ThreadPump` 與 CLI 各自 `new SessionLog(...)` 出來的。退到：installer **每一份日誌
 * 各跑一次**，投影自己持在 closure 裡。同 {@link ./invariants.ts | InvariantSubject}
 * 標過的那一條，代價也一樣。
 *
 * ## 模型工具也走得到這裡
 *
 * **plugin 註冊的工具跟這個通道的參與者活在同一個 `apply` 裡**，所以工具寫得進這份
 * 日誌：`join()` 的閉包扣住 `subject.log`，工具的 handler 直接用它。`load.ts` 一次組裝
 * 呼叫一次 `apply`，而一份 registry 只接一份日誌，所以那一格就是答案（同
 * `@nexus/plugin-goal` 的 `/goal` 用的那一格）。驗收在
 * `apps/harness/src/tool-session-log.test.ts`。
 *
 * **這是 dsh 那條路的一半。** dsh 的模型工具走 `exec.agent.session.append(...)`，而
 * 那個 `agent` 是 agent loop 派發工具時塞進去的
 * （`packages/core/agent-loop/src/tool-calls.ts:78`）—— **那個派發點是 dsh 自己的**，
 * 我們的工具是 LangGraph 的 ToolNode 在跑，插不進去。拿得到的另一半（**這次呼叫是
 * root 還是哪一個 subagent**）今天沒有答案，而且缺的不只是判斷依據：**subagent 跑在
 * 同一次組裝裡，所以就算分得出來也沒有第二份日誌可以寫**。
 * [#134](https://github.com/DemianLi/nexus-agent/issues/134) 追這一件。
 *
 * @see [#126](https://github.com/DemianLi/nexus-agent/issues/126)
 * @module
 */

import { formatOrigin } from './plugin.js';
import type { PluginOrigin } from './plugin.js';
import type { SessionEvent, SessionLog } from './session-log.js';

/**
 * 一個參與者拿到的東西。
 *
 * **`log` 是可寫的，而那正是這個通道存在的理由。** 拿到它的人記得下 `goal/change` 這種
 * 權威 domain 事件——`invariants` 那條路交出的是同一份日誌的
 * {@link ./session-log.ts | SessionLogView}，只看得到；能力歸能力，兩條路一人一半。
 */
export interface SessionSubject {
  /** 這一次要參與的日誌。**寫得動**。 */
  readonly log: SessionLog;
  /**
   * 觀察事件。**訂閱歸接線那一層擁有**，參與者不要自己 `log.subscribe()`——那樣拋出來
   * 的東西會掉進日誌自己的圍堵，變成一行看不出是誰的 warn。
   *
   * 可以呼叫多次，每一個都會收到；**呼叫的當下日誌裡已經有的事件會先重播一遍**，所以
   * 接上一份已經有內容的日誌與接上一份空的，折疊出來的結果一樣。
   *
   * **重播完就立刻開始收後續，不等這位參與者裝完。** 這件事看起來像實作細節，其實是
   * 語意：參與者拿到的日誌寫得動，而一個**安裝當下就記東西**的參與者（例如替一份既有
   * 的會話補一顆初始狀態）必須看得到自己剛寫的那一筆——不然它讀回來的是一份還沒推進
   * 的折疊，而那份折疊會回「什麼都沒有」。
   *
   * @param listener - 每一筆事件叫一次。
   */
  observe(listener: (event: SessionEvent) => void): void;
}

/**
 * 一個參與者的安裝函式。
 *
 * @param subject - 這一次要參與的日誌與它的觀察面。
 * @returns 收掉這一次參與的函式，沒有東西要收就不回。
 */
export type SessionInstaller = (subject: SessionSubject) => (() => void) | void;

/** 接線要的東西。 */
export interface SessionRunnerOptions {
  /** 要參與的日誌。 */
  readonly log: SessionLog;
  /** 目前註冊著的參與者，**安裝當下讀一次**。 */
  readonly installers: readonly {
    readonly value: SessionInstaller;
    readonly origin: PluginOrigin;
  }[];
  /** 參與者自己壞掉往哪裡講。省略即 `console.warn`。 */
  readonly warn?: (message: string) => void;
}

/**
 * 把一份日誌接上註冊著的參與者，**每一個各裝一次**。
 *
 * 三件事與 {@link ./invariants.ts | createInvariantRunner} 一樣，理由也一樣：
 *
 * 1. **裝到一半失敗就整個不算**——那個參與者掛上的觀察者全部拿掉，在這一份日誌上就當
 *    沒裝過，其他參與者照裝。**已經寫進日誌的東西收不回來**：append 是定案的，這一點
 *    與 `invariants` 那條路不同，因為那條路的參與者寫不了東西。
 * 2. **訂閱歸這裡擁有**，一份日誌只掛一個 listener，事件進來再分給每一位。
 * 3. **參與者拋錯被圍堵成一行 warn**——一個參與者壞掉不該餓死其他參與者，也不該扳倒
 *    agent loop。**所以參與者自己要有辦法把壞掉的狀態記下來**：`@nexus/plugin-goal`
 *    的折疊就是這樣做的（第一次重放失敗就把理由扣住，之後每一次讀與每一次變更都拒絕），
 *    不然「折疊壞了」與「什麼都沒發生」在外面看起來一模一樣。
 *
 * **與 `createInvariantRunner` 不同的那一件：`observe()` 當場就生效，不是等這一輪裝完
 * 才一起掛上。** 那邊可以先暫存再一起採用，因為不變量只看不寫；這裡的參與者寫得動日誌，
 * 而暫存的話「安裝期寫進去的那一筆」會落在自己的觀察者掛上之前——寫的人讀回來會看到一份
 * 沒有那一筆的狀態。見 {@link SessionSubject.observe}。
 *
 * `dispatch` 跑在 `SessionLog` 的 `#publishing` 期間，所以 listener **不能回頭
 * `append`**——重入護欄會拋。要記一筆就排到下一個 tick。
 *
 * @param options - 日誌、參與者與 warn 的去處。
 * @returns 收掉這一次接線的冪等函式：先退訂，再倒著跑每一位的 disposer。
 */
export function createSessionRunner(options: SessionRunnerOptions): () => void {
  const warn =
    options.warn ??
    ((message: string) => {
      console.warn(message);
    });

  interface Observer {
    readonly origin: PluginOrigin;
    readonly listener: (event: SessionEvent) => void;
  }

  const observers: Observer[] = [];
  const disposers: { origin: PluginOrigin; dispose: () => void }[] = [];

  const call = (observer: Observer, event: SessionEvent): void => {
    try {
      observer.listener(event);
    } catch (error: unknown) {
      warn(`會話：${formatOrigin(observer.origin)} 的參與者拋了——${String(error)}`);
    }
  };

  // 清單先複製再走：安裝期的 append 會讓某位參與者在 dispatch 途中掛上新的觀察者，
  // 直接走活的陣列的話那一位會收到一筆它還沒準備好接的事件。
  const dispatch = (event: SessionEvent): void => {
    for (const observer of [...observers]) call(observer, event);
  };
  const unsubscribe = options.log.subscribe(dispatch);

  for (const installer of options.installers) {
    const own: Observer[] = [];
    const subject: SessionSubject = {
      log: options.log,
      observe(listener) {
        const observer: Observer = { origin: installer.origin, listener };
        // **先補歷史再收後續。** 兩件事的順序決定了「接得晚」與「一路看著它長大」折出
        // 來的結果一不一樣——反過來的話，重播中途來的事件會被送兩次。
        for (const event of options.log.events) call(observer, event);
        own.push(observer);
        observers.push(observer);
      },
    };
    let dispose: (() => void) | void;
    try {
      dispose = installer.value(subject);
    } catch (error: unknown) {
      for (const observer of own) {
        const at = observers.indexOf(observer);
        if (at >= 0) observers.splice(at, 1);
      }
      warn(`會話：${formatOrigin(installer.origin)} 的參與者安裝失敗——${String(error)}`);
      continue;
    }
    if (typeof dispose === 'function') disposers.push({ origin: installer.origin, dispose });
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    observers.length = 0;
    // 倒著收：後裝的可能依賴先裝的，同 `load.ts` 收 lifecycle disposer 的順序。
    for (const entry of [...disposers].reverse()) {
      try {
        entry.dispose();
      } catch (error: unknown) {
        warn(`會話：${formatOrigin(entry.origin)} 的參與者收拾時拋了——${String(error)}`);
      }
    }
  };
}
