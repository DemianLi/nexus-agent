/**
 * **包自有的運行時不變量**：各 package 自己發布一個配套入口，檢查**自己擁有的跨筆
 * 關係**，違規帶著擁有它的 package 名字報出來。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-invariants`
 * （`references/deepseek-harness/packages/runtime-diagnostics/invariants/src/index.ts`，
 * 對讀日期 2026-08-29，版本 `cd5ef8148158c3a752a658978873241fdf8e2bbc`）：註冊表自己
 * **一條產品檢查都沒有**，`register(packageName, installer)` 保留包名歸屬，過濾器決定
 * 誰真的裝上去，失敗帶 `InvariantError`。
 *
 * **只檢查真的關係，不為了覆蓋而編造斷言。** dsh 那份 README 明說：確認方法存在、
 * 插件名字、注入、純函式的固定結果，全都是型別、載入或單元測試的事，**不是運行時
 * 不變量**。沒有可觀察的事件或可變資料關係時，配套入口就是一個空 installer 加一句
 * `No runtime invariant:` 說明。
 *
 * @see [#101](https://github.com/DemianLi/nexus-agent/issues/101)
 * @module
 */

import type { PluginOrigin } from './plugin.js';
import { formatOrigin } from './plugin.js';
import type { SessionEvent, SessionLog } from './session-log.js';

/** 違規時拋的東西。**帶得出是哪個 package 擁有被違反的關係。** */
export class InvariantError extends Error {
  /** 穩定的機器可讀代碼。 */
  readonly code = 'INVARIANT' as const;
  /** 註冊這條檢查的完整 package 名。 */
  readonly packageName: string;

  /**
   * @param packageName - 擁有這條關係的完整 package 名。
   * @param message - 被違反的約定，不含前綴。
   */
  constructor(packageName: string, message: string) {
    super(`invariant violated by "${packageName}": ${message}`);
    this.name = 'InvariantError';
    this.packageName = packageName;
  }
}

/**
 * 報一次違規。**它會拋**，所以在檢查裡呼叫它之後的程式碼不會跑到。
 *
 * 拋出去的 `InvariantError` 由 runner 接住轉給 `onViolation`——**不會回流到
 * {@link ./session-log.ts | SessionLog}**，見 {@link createInvariantRunner} 的說明。
 */
export type InvariantFailure = (message: string) => never;

/**
 * 一個配套入口觀察得到的東西。
 *
 * **與 dsh 的偏離**：dsh 給的是一個子 Cordis context，配套入口自己
 * `ctx.on('session/event', …)`，而且一次註冊就看得到**所有** session
 * （`ctx.sessions.list()` ＋ `session/created`）。我們沒有 session 服務——日誌是
 * `ThreadPump` 與 CLI 各自 `new SessionLog(...)` 出來的，所以 installer 是
 * **每一份日誌各跑一次**。這件事的後果是好的：trace 可以放在 closure 裡，不需要
 * dsh 那個 `WeakMap<Session, SessionTrace>`。
 */
export interface InvariantSubject {
  /** 這一次要看的日誌。 */
  readonly log: SessionLog;
  /**
   * 觀察後續事件。**訂閱歸 runner 擁有**，配套入口不要自己 `log.subscribe()`——
   * 那樣拋出來的違規會掉進日誌自己的圍堵，變成一行看不出是不變量的 warn。
   *
   * 可以呼叫多次，每一個都會收到；安裝當下日誌裡已經有的事件會先重播一遍。
   *
   * @param listener - 每一筆事件叫一次，違規時呼叫 `fail`。
   */
  observe(listener: (event: SessionEvent) => void): void;
}

/**
 * 裝一個 package 的檢查。
 *
 * @param subject - 這一次要觀察的對象。
 * @param fail - 綁在註冊 package 上的違規回報器。
 */
export type InvariantInstaller = (subject: InvariantSubject, fail: InvariantFailure) => void;

/** 註冊表裡的一筆配套入口。 */
export interface InvariantCompanion {
  /** 擁有這些檢查的完整 package 名。 */
  readonly packageName: string;
  readonly installer: InvariantInstaller;
  /** 是誰註冊的。 */
  readonly origin: PluginOrigin;
}

/**
 * 哪些 package 的檢查要真的裝上去。
 *
 * 三個欄位與 dsh 的 `Config` 同語意：**blocklist 蓋過 allowlist**，pattern 是區分
 * 大小寫的 JavaScript regex 源碼（除非自帶 `^`／`$`，否則不錨定），空白、帶前後空白、
 * 無效或重複的條目**當場拋**而不是被跳過。
 */
export interface InvariantSelection {
  /** 全域開關，省略即 `true`。 */
  readonly enabled?: boolean;
  /** 接納的 package 名 regex 源碼；空陣列即全收。 */
  readonly packageAllowlist?: readonly string[];
  /** allowlist 命中之後再排除的 regex 源碼。 */
  readonly packageBlocklist?: readonly string[];
}

export interface InvariantRunnerOptions {
  /** 要觀察的日誌。 */
  readonly log: SessionLog;
  /** 目前註冊著的配套入口，**安裝當下讀一次**（不像脫敏規則是每次捕獲現讀）。 */
  readonly companions: readonly InvariantCompanion[];
  /** 省略即全開、無過濾。 */
  readonly selection?: InvariantSelection;
  /** 違規往哪裡講。省略即 `console.error`。 */
  readonly onViolation?: (error: InvariantError) => void;
  /** 檢查**自己壞掉**往哪裡講。省略即 `console.warn`。 */
  readonly warn?: (message: string) => void;
}

/**
 * 編一份 package 過濾清單。
 *
 * 有效但當下沒命中任何 package **不算錯**——配套入口是後來才會加的，先寫好的 pattern
 * 不該因為現在還沒有對應的包而讓組裝失敗。（dsh 給的理由是 HMR 的確定性；我們沒有
 * HMR，過濾在所有 plugin 都載完之後才評估，所以理由弱一些：是前向相容，不是重載確定性。）
 */
function compilePatterns(field: string, values: readonly string[]): RegExp[] {
  const seen = new Set<string>();
  return values.map((value) => {
    if (value.length === 0 || value.trim() !== value) {
      throw new Error(`不變量：${field} 的條目不能是空的、也不能帶前後空白`);
    }
    if (seen.has(value)) {
      throw new Error(`不變量：${field} 有重複的 regex ${JSON.stringify(value)}`);
    }
    seen.add(value);
    try {
      return new RegExp(value);
    } catch (cause: unknown) {
      throw new Error(`不變量：${field} 有無效的 regex ${JSON.stringify(value)}`, { cause });
    }
  });
}

/**
 * 把註冊著的配套入口接到一份日誌上。
 *
 * **runner 擁有那唯一一次 `log.subscribe()`，這是 [#101](https://github.com/DemianLi/nexus-agent/issues/101)
 * 第一個決定（選項 b）的整個重點。** dsh 的 `fail()` 是從報告它的 context 拋出去的；
 * 我們這側 `SessionLog.#publish` 會把 listener 的拋錯**吞成一行 warn**（[#99](https://github.com/DemianLi/nexus-agent/pull/99)
 * 刻意的圍堵，理由是 listener 不能課稅到 agent loop）。配套入口若自己訂閱，違規就會
 * 變成靜默的 warn——形狀對了、語意反了。由 runner 訂閱、在 runner 這一格接住
 * `InvariantError`，違規才**看得見**。
 *
 * 代價是**否決不了**：觀察到的時候那一筆已經在日誌裡了。這是選項 (b) 明著換來的，
 * 不是疏漏——(a) 那條 pre-append 縫會把不變量放進熱路徑，而且推翻 #99 才剛定的
 * 「listener 影響不了 append」。
 *
 * 順序是：裝 installer → 收集 observer → **重播日誌裡已經有的事件** → 訂閱後續。
 * 重播對應 dsh 配套入口的 `seedSession`：協調器晚於日誌成立是常態，少了這一段
 * 開頭那幾筆的關係就沒人檢查。
 *
 * @param options - 日誌、配套入口、過濾器與兩個回報去處。
 * @returns 冪等的退訂。過濾之後沒有任何檢查要裝時回傳的 disposer 是 no-op。
 */
export function createInvariantRunner(options: InvariantRunnerOptions): () => void {
  const selection = options.selection ?? {};
  const enabled = selection.enabled ?? true;
  // 過濾器**先編再說**：無效的 regex 要在這裡當場拋，不是等到某一筆事件才發現。
  const allowlist = compilePatterns('packageAllowlist', selection.packageAllowlist ?? []);
  const blocklist = compilePatterns('packageBlocklist', selection.packageBlocklist ?? []);
  const onViolation =
    options.onViolation ??
    ((error: InvariantError) => {
      console.error(error.message);
    });
  const warn =
    options.warn ??
    ((message: string) => {
      console.warn(message);
    });

  const selected = (packageName: string): boolean => {
    if (!enabled) return false;
    if (allowlist.length > 0 && !allowlist.some((pattern) => pattern.test(packageName))) {
      return false;
    }
    return !blocklist.some((pattern) => pattern.test(packageName));
  };

  const observers: { packageName: string; listener: (event: SessionEvent) => void }[] = [];

  for (const companion of options.companions) {
    if (!selected(companion.packageName)) continue;
    const staged: ((event: SessionEvent) => void)[] = [];
    const subject: InvariantSubject = {
      log: options.log,
      observe(listener) {
        staged.push(listener);
      },
    };
    const fail: InvariantFailure = (message) => {
      throw new InvariantError(companion.packageName, message);
    };
    try {
      companion.installer(subject, fail);
    } catch (error: unknown) {
      // **裝到一半失敗就整個不算**：暫存的 observer 一個都不採用，這一份日誌上這個
      // package 就當沒裝過。對應 dsh 的「失敗會原子地 dispose 子級」。
      //
      // 與 dsh 的差別：**註冊表那一層的包名保留仍然在**。dsh 的保留與子 fiber 是同一個
      // effect，一起回滾；我們的 `register()` 早在載入期就完成了，這裡撤不掉它——
      // 也不該撤，那個名字確實有人認領，只是它的檢查在這一份日誌上壞了。
      warn(`不變量：${companion.packageName} 的配套入口安裝失敗——${String(error)}`);
      continue;
    }
    for (const listener of staged) {
      observers.push({ packageName: companion.packageName, listener });
    }
  }

  if (observers.length === 0) {
    return () => {
      // 沒有人要看，沒有東西要退。
    };
  }

  const dispatch = (event: SessionEvent): void => {
    for (const observer of observers) {
      try {
        observer.listener(event);
      } catch (error: unknown) {
        if (error instanceof InvariantError) {
          onViolation(error);
          continue;
        }
        // 檢查自己拋了不是違規，是那條檢查壞了。兩件事分開講——講混了就等於
        // 「日誌破了約定」跟「檢查有 bug」看起來一樣。
        warn(`不變量：${observer.packageName} 的檢查自己拋了——${String(error)}`);
      }
    }
  };

  // **重播裡的違規照報，然後繼續。** 停下來的話，日誌中段一次違規會讓後面全部失明。
  for (const event of options.log.events) dispatch(event);

  // `dispatch` 跑在 `SessionLog` 的 `#publishing` 期間，所以 `onViolation` 與 `warn`
  // **都不能回頭 `append`**——重入護欄會拋，而那個拋會落進上面的 catch，讀起來像是
  // 檢查壞了。要記一筆就排到下一個 tick。
  const unsubscribe = options.log.subscribe(dispatch);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
  };
}

/** 重名時的訊息。註冊表那一層用得到，所以放在這裡跟型別擺一起。 */
export function duplicateCompanionError(
  packageName: string,
  existing: PluginOrigin,
  incoming: PluginOrigin,
): Error {
  return new Error(
    `package "${packageName}" 已經註冊過不變量配套入口：${formatOrigin(existing)} 註冊過，` +
      `${formatOrigin(incoming)} 又註冊一次。一個 package 名只能有一個擁有者——` +
      `保留是為了兩個 plugin 不會靜默認領同一個名字。`,
  );
}
