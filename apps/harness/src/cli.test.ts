import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { createEchoPlugin, ECHO_TOOL_NAME } from './echo.fixture.js';
import { describe, expect, it, vi } from 'vitest';

import { HUMAN_MESSAGE_LIMIT_CHARS, SessionLog, SessionRegistry } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { z } from 'zod';
import { createNexusAgent, HEADLESS_APPROVALS } from './agent-factory.js';
import { FIRST_PLUGIN_NAME, SECOND_PLUGIN_NAME } from './cli-collision.fixture.js';
import type { ReplLine } from './cli.js';
import { APPROVAL_DISCLOSURE, exitCodeFor, parseCliArgs, runCli, runRepl, runTurn } from './cli.js';
import { CLI_PROBE_FILE, createCliAgent } from './assembly-root.js';
import { DISPOSE_FAILURE } from './cli-dispose-failure.fixture.js';
import { documentedFixture } from './documented-fixture.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { shippedModelRow, shippedPlugins } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { DEFAULT_LIVE_MODEL_ID } from './live-model.js';
import { liveModelPatch, shippedLiveModelConfig } from './log-derived-history.fixture.js';

const shipped = await shippedPlugins();

/** 收 CLI 印出來的東西，讓斷言看得到順序。 */
function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    printer: {
      log: (line: string) => void out.push(line),
      error: (line: string) => void err.push(line),
    },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

describe('parseCliArgs', () => {
  it('位置參數接成一句話——shell 拆不拆詞不改變語意', () => {
    expect(parseCliArgs(['把這句', '回聲一次']).prompt).toBe('把這句 回聲一次');
    expect(parseCliArgs(['把這句 回聲一次']).prompt).toBe('把這句 回聲一次');
  });

  it('沒有位置參數就是 REPL', () => {
    expect(parseCliArgs([]).prompt).toBeUndefined();
    expect(parseCliArgs(['--live']).prompt).toBeUndefined();
  });

  /** **兩個入口同一個旗標名、同一個預設**，理由見 `CliInvocation.goalDriver`。 */
  it('--goal-driver 預設關，打得開', () => {
    expect(parseCliArgs([]).goalDriver).toBe(false);
    expect(parseCliArgs(['--goal-driver']).goalDriver).toBe(true);
  });

  it('--workspace 收得到，空字串當場報錯', () => {
    expect(parseCliArgs(['--workspace', './ws']).workspace).toBe('./ws');
    expect(parseCliArgs([]).workspace).toBeUndefined();
    expect(() => parseCliArgs(['--workspace', '  '])).toThrow('--workspace');
  });

  it('旗標與那句話同時收得下，順序不拘', () => {
    const invocation = parseCliArgs(['--patch', './p.yml', '說點什麼', '--live']);
    expect(invocation).toMatchObject({
      live: true,
      patches: ['./p.yml'],
      prompt: '說點什麼',
    });
  });

  it('不認得的旗標報錯，訊息接上用法', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow(/--nope[\s\S]*用法/);
  });

  it('--recursion-limit 收正整數，省略即不設（由組裝點用預設）', () => {
    expect(parseCliArgs(['--recursion-limit', '500']).recursionLimit).toBe(500);
    expect(parseCliArgs([])).not.toHaveProperty('recursionLimit');
    // 負數要寫成 `--recursion-limit=-1`：分開寫的話 `parseArgs` 先把 `-1` 當成旗標拒絕。
    for (const raw of ['0', '-1', '1.5', 'abc', ' ']) {
      expect(() => parseCliArgs([`--recursion-limit=${raw}`])).toThrow(
        /--recursion-limit 要給一個正整數[\s\S]*用法/,
      );
    }
  });

  it('--history-source 只收 state、shadow、log，省略即不設（由組裝點照清單那一列）', () => {
    expect(parseCliArgs(['--history-source', 'shadow']).historySource).toBe('shadow');
    expect(parseCliArgs(['--history-source', 'state']).historySource).toBe('state');
    expect(parseCliArgs(['--history-source', 'log']).historySource).toBe('log');
    expect(parseCliArgs([])).not.toHaveProperty('historySource');
    for (const raw of ['Log', 'Shadow', '']) {
      expect(() => parseCliArgs([`--history-source=${raw}`])).toThrow(
        /--history-source 只收 state、shadow、log[\s\S]*用法/,
      );
    }
  });
});

/**
 * [#362](https://github.com/DemianLi/nexus-agent/issues/362)：撞到迴圈上限要跟其他失敗分得開。
 *
 * 判準只認型別化的 `lc_error_code`——同一句散文、沒有那個碼的錯誤仍然是 1。
 */
describe('exitCodeFor', () => {
  it('帶 GRAPH_RECURSION_LIMIT 的是 2，措辭一樣但沒有碼的是 1', () => {
    const limited = Object.assign(new Error('Recursion limit of 8 reached'), {
      lc_error_code: 'GRAPH_RECURSION_LIMIT',
    });
    expect(exitCodeFor(limited)).toBe(2);
    expect(exitCodeFor(new Error('Recursion limit of 8 reached'))).toBe(1);
    expect(exitCodeFor(Object.assign(new Error('x'), { lc_error_code: 'INVALID_UPDATE' }))).toBe(1);
    expect(exitCodeFor('字串')).toBe(1);
    expect(exitCodeFor(undefined)).toBe(1);
  });

  it('runCli 撞到 --recursion-limit 時拋出的錯誤帶著那個碼（沒有被中途換掉）', async () => {
    const { printer } = recorder();
    const failure = await runCli({
      // 明給 loop：`vitest.native.config.ts` 會把沒指定的組裝換成 native，那一條要看的是 langgraph 的碼。
      argv: ['--agent-loop', 'langgraph', '--recursion-limit', '8', '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ lc_error_code: 'GRAPH_RECURSION_LIMIT' });
    // 是**這個旗標的值**撞到的，不是預設那條——旗標真的傳到了 agent。
    expect((failure as Error).message).toMatch(/Recursion limit of 8 reached/);
    expect(exitCodeFor(failure)).toBe(2);
  });

  it('native：步數上限的碼是 AGENT_STEP_LIMIT，退出碼也是 2，訊息沒有接 LangChain 的排錯網址', async () => {
    const limited = Object.assign(new Error('Recursion limit of 8 reached'), {
      lc_error_code: 'AGENT_STEP_LIMIT',
    });
    expect(exitCodeFor(limited)).toBe(2);

    const { printer } = recorder();
    const failure = await runCli({
      argv: ['--agent-loop', 'native', '--recursion-limit', '8', '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: 'GraphRecursionError',
      lc_error_code: 'AGENT_STEP_LIMIT',
    });
    expect((failure as Error).message).toMatch(/^Recursion limit of 8 reached/);
    expect((failure as Error).message).not.toContain('docs.langchain.com');
    expect(exitCodeFor(failure)).toBe(2);
  });
});

describe('一次性模式', () => {
  it('跑一輪就結束，工具的回傳值印得出來', async () => {
    const { printer, stdout } = recorder();

    await runCli({
      argv: ['把這句話回聲一次。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
    });

    expect(stdout()).toContain('假模型（ScriptedChatModel）');
    expect(stdout()).toContain('回聲：CLI 接線測試');
  });

  it('--help 只印用法，不組 agent', async () => {
    const { printer, stdout } = recorder();
    await runCli({
      argv: ['--help'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
    });
    expect(stdout()).toContain('用法：');
    expect(stdout()).not.toContain('模型：');
  });

  it('預設清單是十四顆功能 ＋ 八列 core 設定 ＋ 二十三列 harness 設定 ＋ 八個配套入口', async () => {
    // **這條是絆索，所以它翻面而不是變寬。** 原本是 `toEqual(['echo'])`——一條在守
    // 「不替誰決定該裝什麼」的線。[#120](https://github.com/DemianLi/nexus-agent/issues/120)
    // 讓計劃模式進來，理由寫在 `apps/harness/cordis.yml` 的註解上（命令沒進預設清單就等於
    // 不存在）。**改成 `toHaveLength` 會把這條線整個放掉**，所以名字仍然逐個寫死：
    // 下一個想塞東西進來的人還是得先改這一行，並且說得出理由。
    //
    // **`goal` 這一條翻面了。** 上一張 PR 這裡寫的是 `not.toContain('goal')`，理由是
    // 「域在 `/goal` 落地之前沒有任何人打得到的入口」。`/goal` 落地了，理由就沒了——
    // 而翻面之後這一行守的是同一件事的另一半：域進來的**位置**。它排在計劃模式之後、
    // 所有配套入口之前，因為啟動時印的 `plugin：` 那一行按清單順序走。
    //
    // **`todo` 這一條進來的理由與前兩個不同，所以它值得在這裡多一句**：它是三者裡唯一
    // 真的多一顆面向模型的工具的（每次請求多一份 schema 與描述），而它進得來是因為
    // **它沒有別的入口**——人打不到它，命令也叫不動它。見
    // [#132](https://github.com/DemianLi/nexus-agent/issues/132)。
    //
    // **`feedback` 進來的理由是驗收句本身**：零 plugin 設定的 serve 與 CLI 都要評得到
    // （[#278](https://github.com/DemianLi/nexus-agent/issues/278)）。它不多一顆面向模型的工具，
    // 只多一個命令與一條 wire 用的規則。
    // **`agent-instructions` 進來的理由是它不進來就等於不存在**：`AGENTS.md` 是使用者放在工作區
    // 裡、期待 agent 會讀的東西，而讀它的東西不在出貨清單上的話，產品路徑上的 CLI 與 serve
    // 一個字都看不到（[#388](https://github.com/DemianLi/nexus-agent/issues/388)）。它不多一顆面向
    // 模型的工具，多的是每個 agent 開頭的一則訊息，而且**沒有工作區時它什麼都不加**。
    //
    // **`present` 進來的理由是 dsh 的 standard preset 掛它**（`agent.cordis.yml:261`），而交付卡片讀的
    // 事件只有它寫得出來（[#441](https://github.com/DemianLi/nexus-agent/issues/441)）。它多一顆面向模型的
    // 工具；沒有工作區時工具照樣在、叫了回 `present requires a workspace`，同 dsh。
    const names = shipped.map((entry) => entry.plugin.name);
    expect(names.filter((name) => !name.endsWith('-invariant'))).toEqual([
      'echo',
      'agent-instructions',
      // **`skill-invocation` 進來的理由是人要叫得出只給人叫的技能**（[#1574](https://github.com/DemianLi/nexus-agent/issues/1574)）：
      // 同一個 `agent/pre-step` 接縫，root 的人話裡有 `/名字` 才注入那份技能的正文；不多工具、不多命令。排在 `time-context` 前面，同 dsh。
      'skill-invocation',
      // **`time-context` 進來的理由是模型沒有時鐘**（[#1625](https://github.com/DemianLi/nexus-agent/issues/1625)）：
      // 與 `agent-instructions` 同一個 `agent/pre-step` 接縫，每次 agent 呼叫開頭（同一條 thread 10 分鐘內不重複）追加一則
      // 持久的使用者訊息；不多工具、不多命令、不進系統提示詞。CLI 也掛（偏離 dsh，登記在套件檔頭）。
      'time-context',
      // **`skills` 進來的理由是它本來就在，只是沒有人掛**（[#440](https://github.com/DemianLi/nexus-agent/issues/440)）：
      // 工作區的 `skills/<name>/SKILL.md` 不進清單就永遠看不到。沒有 skill 的時候一個字都不加（組裝點包了一層，
      // 見 `packages/nexus-core/src/skills-middleware.ts`），多的只是啟動時掃一次 `/skills/`。
      'skills',
      'plan-mode',
      'goal',
      'todo',
      'feedback',
      'present',
      // **`ask-user` 與 `submit-record` 進來的理由是它們本來就在產品路徑上，只是藏在程式碼裡**
      // （[#669](https://github.com/DemianLi/nexus-agent/issues/669)）：`--dump-config` 印不出來、patch 關不掉。
      // 它們各多一顆面向模型的工具（`ask_user_question`、`submit_record`），後者帶一道核准閘門。兩個入口照舊都有。
      'ask-user',
      'submit-record',
      // **`trajectory` 進來的理由是 web 的觀測分頁讀它**（[#1027](https://github.com/DemianLi/nexus-agent/issues/1027)）：
      // 不多工具、不改 prompt、不寫日誌，模型那一側零差別；多的是兩個從日誌折出來的投影（#1026 的通道）。
      'trajectory',
      // **`token-meter` 進來的理由同 `trajectory`**（[#1028](https://github.com/DemianLi/nexus-agent/issues/1028)）：web 的觀測分頁讀它的逐輪與子代理用量；
      // 不多工具、不改 prompt、不寫日誌，多的是一個從日誌折出來的投影（root 與每個子代理各一份）。
      'token-meter',
      // **`system-prompt` 進來的理由是模型該知道自己是誰**（[#720](https://github.com/DemianLi/nexus-agent/issues/720)）：
      // 出貨值把「命令列助手」那句寫死在程式碼裡的身分，換成部署方寫得動的一列。它不多一顆工具、不多一個命令，
      // 多的是系統提示詞前後各一段；沒有這一列，模型只剩組裝點那一句指引。
      'system-prompt',
      // **底下這八顆不是第八到第十五個例外**，它們跟上面七個不同類：不多一顆工具、不多一
      // 個命令、不改 prompt。它們只把 core 那幾顆 middleware 的設定從程式碼搬到部署設定裡
      // （[#456](https://github.com/DemianLi/nexus-agent/issues/456)），middleware 本身
      // 一直都在。它們在這份清單上的作用是**讓 `disabled: true` 指得著**。
      // `session-checkpoint-policy` 是後來的（#599），它的 middleware 跟著條目一起進來，但同樣是
      // fold 建、fold 排位，條目只負責「關得掉」。
      //
      // `observation-policy`、`model-usage` 與 `session-checkpoint-policy` 還少一格：它們連設定都沒有，`apply` 是空的，
      // 所以在這裡的作用**只剩**那一件——照 dsh 的 `fs-observation-policy`
      // （it registers no service）。
      //
      // **`approval-gate` 是相反的那一顆**：它在這份清單上的作用是讓 `disabled: true`
      // 指得著**然後當場拋**（`PROTECTED_ENTRY_NAMES`），外加讓核准在 `--dump-config`
      // 裡看得見。沒有它的時候那條 patch 是一行警告、然後靜靜跳過。
      'repeat-reminder',
      'tool-result-pruner',
      'summarization',
      'observation-policy',
      'model-usage',
      'session-checkpoint-policy',
      'approval-gate',
      // **`session-persistence` 跟上面七顆同段不同層**（#529）：擁有者一樣是 `@nexus/core`，
      // 但它的消費點是 `cli.ts` 與 `serve-run.ts` 裡呼叫 `attachSessionPersistence` 的那兩行，
      // 跑在組裝回來之後——那裡一格註冊表都沒有，所以它的 `apply` 是空的、值走
      // `startupSetting`。它跟 `approval-gate` 一樣關不掉，理由卻是相反的那一種：關掉它
      // 不會有任何行為改變，只會讓讀設定的人以為自己改了落盤的節奏。
      'session-persistence',
      // **這八顆跟上面那七顆同類——不裝功能、只講設定——但擁有者住在 `apps/harness`**
      // （[#529](https://github.com/DemianLi/nexus-agent/issues/529)）。它們內部又分兩層，
      // 分界是消費點跑的時刻。
      //
      // **前七列跑在任何 agent 出生之前**（serve 的冷讀清單與內容搜尋、`BrowserAuth` 的建構子、
      // `createWireHandler` 閉包裡的交付方法與工具文字那兩條、交給組裝的那顆 model），那一刻
      // 註冊表還不存在，所以 `apply` 是空的，值由 `settings/startup.ts` 的 `startupSetting` 在
      // 起動期解一次。**CLI 這條路讀其中三列**：`thread-title`（寫退回標題，#647）、`thread-title-llm`
      // 與 `live-model`（建 model 用，#650、#545）——其餘四列的消費者都在 serve 那一側，它們出現在
      // 這份清單上是因為清單只有一份（#454）。
      //
      // **`recursion-limit` 相反，它正是 CLI 在讀的那一個**：消費點是 `agent-factory.ts`，跑在
      // `loadPlugins` 之後，註冊表就在手上，所以它跟上面 core 那三列完全同形——`apply` 把驗過的
      // 值提供成服務，組裝點去讀。三態（旗標 > 條目 > 內建預設）釘在 `agent-factory.test.ts`。
      //
      // **哪幾列在 `PROTECTED_ENTRY_NAMES` 上以那張表為準**（`thread-capacity` 自 #1619 出廠開著起也在上面），這裡不寫顆數；理由分兩種，而且現在是逐列
      // 寫在 `PROTECTED_ENTRY_REASONS` 這張表上的（訊息不再共用一段講核准閘門的文字）。
      // `thread-title-llm` 關得掉：關掉就真的沒有模型產生的標題，同 dsh 的 acp-app 與 sdk-app。`thread-search` 同理（#631）。
      'thread-title',
      'thread-title-llm',
      'thread-search',
      // **`session-reference` 是跨會話引用的四個上限**（[#1573](https://github.com/DemianLi/nexus-agent/issues/1573) N0862）：消費者是 serve 的候選與每條 thread 的 pump，
      // 起動期讀一次；CLI 沒有引用。寫壞整個起不來、也關不掉（理由見 `settings/session-reference.ts`）。
      'session-reference',
      'thread-capacity',
      'memory-gauge',
      'ops-endpoints',
      'embed-login',
      'browser-session',
      'deliverable-files',
      'tool-text',
      'projection-flush',
      'downlink',
      'tool-result-stash',
      'spill-policy',
      'tool-fs-search',
      'tool-fs',
      'background-subagents',
      'subagent-model-selection',
      'live-model',
      'default-model',
      'scripted-model',
      'recursion-limit',
      // **`turn-timeout` 是一輪的時鐘上限**（[#1624](https://github.com/DemianLi/nexus-agent/issues/1624)）：消費者是 serve 的 pump 與背景子代理，
      // 起動期讀一次；CLI 一次性路徑不套（Q-B4 (a)）。關得掉，關掉就是不限。
      'turn-timeout',
      // **`goal-round-cap` 是操作者給續行輪數的上限**（[#1623](https://github.com/DemianLi/nexus-agent/issues/1623)）：消費者是 harness 的
      // 續行排程器，起動期讀一次；續行沒開（CLI 預設）時它安靜地不起作用。關得掉，關掉就只剩目標自己的 `max_goal_rounds`。
      'goal-round-cap',
      'agent-loop',
      // **`history-source` 講模型歷史從哪裡來**（[#2355](https://github.com/DemianLi/nexus-agent/issues/2355)）：消費點在組裝期，出廠 `state` 什麼都不掛。
      'history-source',
      // **`sandbox-policy` 進來的理由是它本來就在產品路徑上，只是藏在組裝點的條件裡**
      // （[#669](https://github.com/DemianLi/nexus-agent/issues/669) 第 3 步）：`--dump-config` 印不出來、patch 關不掉。
      // 不論有沒有 `--workspace` 都掛：有圍堵時註冊升級與 `sandbox/mode`，沒有圍堵時只講一句不宣稱圍堵的政策。
      'sandbox-policy',
      // 權限組合（#437）：`/permission` 是切沙箱與核准的唯一入口，沒有圍堵時什麼都不註冊。
      'permission-presets',
    ]);
    // 八個配套入口裡有 `@nexus/plugin-workspace-changes` 的，**那個功能本身不在這份清單裡**：它要工作區的根，
    // 只由 serve 經 `createCliAgent` 掛（#443），同 dsh 只在 web-app bundle 掛。
    expect(names.filter((name) => name.endsWith('-invariant'))).toHaveLength(8);
  });

  it('**違規印到 stderr 而且帶前綴**——不是靠 runner 預設的 `console.error`', async () => {
    // 這一條是 #107 的 (c) 的端到端驗收，而它必須走 `runCli`：`createCliAgent` 那一層
    // 只證明第四個引數轉得下去，證不了 `runCli` 真的把 `printer.error` 接上去。
    //
    // **前綴是這條的重點**。違規跟 agent 的輸出落在同一個終端機上，沒有前綴就分不出
    // 誰在講話；而它走 `printer.error` 也就順帶證明了它沒有繞過 `Printer`——繞過的話
    // 這裡的 `stderr()` 會是空的，`console.error` 才有東西。
    const { printer, stdout, stderr } = recorder();
    await runCli({
      argv: ['--patch', 'src/cli-invariant-violation.patch.yml', '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
    });

    expect(stderr()).toContain('[不變量] invariant violated by "@nexus/noisy": 看到 turn/start');
    expect(stderr()).toContain('[不變量] invariant violated by "@nexus/noisy": 看到 turn/end');
    // 沒有漏到 stdout——那裡是 agent 講話的地方。
    expect(stdout()).not.toContain('[不變量]');
  });
});

/**
 * banner 說得出這一輪會不會有東西離開這台機器。
 *
 * tracing 開沒開不由 CLI 決定——基座讀到環境變數就自己掛 tracer，我們一行都沒寫。
 * 所以這裡唯一能做的是把狀態講出來；不講的話，「工具參數正在往第三方送」與「什麼都
 * 沒送」在畫面上一模一樣。與 `CLI 遇到核准中斷` 同一型的毛病。
 *
 * 實際上送了什麼在 [`tracing.test.ts`](./tracing.test.ts) 驗；這裡只問「有沒有說」。
 * `env` 從外面傳進來，不動 `process.env`——動了會污染同檔案後面的每一條。
 */
describe('banner 的 tracing 披露', () => {
  it('關著的時候明說關著', async () => {
    const { printer, stdout } = recorder();
    await runCli({
      argv: ['把這句話回聲一次。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
      env: {},
    });
    expect(stdout()).toContain('追蹤：關閉');
  });

  it('開著的時候說出是誰開的、送去哪、送的是原文', async () => {
    const { printer, stdout } = recorder();
    await runCli({
      argv: ['把這句話回聲一次。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
      // 只是給披露看的假設定，不會讓這一輪真的送出任何東西——
      // 真正的開關是 `process.env`，這裡沒碰。
      env: {
        LANGSMITH_TRACING: 'true',
        LANGSMITH_ENDPOINT: 'https://example.invalid',
        LANGSMITH_PROJECT: 'demo',
        LANGSMITH_API_KEY: 'lsv2_pt_不該出現在畫面上',
      },
    });
    const out = stdout();
    expect(out).toContain('追蹤：開啟（LANGSMITH_TRACING）');
    expect(out).toContain('https://example.invalid');
    expect(out).toContain('原文');
    expect(out).not.toContain('lsv2_pt_不該出現在畫面上');
  });
});

/**
 * 一輪真的停下來的時候，畫面上說得出來。
 *
 * 中斷在 `updates` 串流裡是 `{ __interrupt__: [...] }`——值是陣列，不是 `{ messages }`，
 * 所以 `runTurn` 印訊息的那個迴圈碰到它一個字都印不出來。**這一輪於是與正常收工長得
 * 一模一樣**，而工具其實沒跑。這一條守的就是那個相同不再回來。
 *
 * **底下這條刻意自己 `createNexusAgent`，繞過 `createCliAgent`——而那正是它現在不能被
 * 讀成「CLI 還是會停」的原因。** [#113](https://github.com/DemianLi/nexus-agent/issues/113)
 * 之後 CLI 這個入口關掉了核准（見底下的 `CLI 的核准政策`），核准閘門不會再發中斷。
 * 這條測的是 `printInterrupt` 這段程式碼本身還活著：閘門不是唯一 `interrupt()` 得了的
 * 東西，plugin 自己掛的 middleware 也做得到，而那時這一段是唯一分得出「停了」與「收工」
 * 的東西。**綠的意思是那段話還印得出來，不是「CLI 這個入口還會停」。**
 *
 * 核准層本身的行為驗收不在這裡，在 [`interrupt.test.ts`](./interrupt.test.ts)。
 */
describe('停在核准點的那一輪', () => {
  it('印出停在哪、還沒跑的是什麼、以及這個入口按不了核准', async () => {
    const model = new ScriptedChatModel({
      turns: [
        { content: '動手。', toolCalls: [{ name: 'danger', args: {} }] },
        { content: '收工。' },
      ],
    });
    const { agent } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [
        {
          plugin: {
            name: 'gated',
            apply(registry) {
              registry.tools.register(
                tool(() => '跑過了', {
                  name: 'danger',
                  description: '會弄壞東西的工具。',
                  schema: z.object({}),
                }),
              );
              // 理由由 listener 自己給，CLI 印的就是它。**兩位 listener 不再把理由串起來**
              // ——waterfall 是第一個回非 allow 的人說了算，後面那位根本沒被問到。
              registry.approvals.gate((exec, next) =>
                exec.name === 'danger'
                  ? { kind: 'ask', reason: '這個會弄壞東西，而且不可逆' }
                  : next(),
              );
            },
          },
        },
      ],
    });

    const { printer, stdout } = recorder();
    await runTurn(agent, '動手', printer, new SessionLog('t'));

    expect(stdout()).toContain('停在核准點');
    expect(stdout()).toContain('danger');
    expect(stdout()).toContain('這個會弄壞東西，而且不可逆');
    expect(stdout()).toContain('還不能收核准決定');
  });

  it('沒有中斷的那一輪一個字都不多印（上一條的對照組）', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '沒事發生。' }] });
    const { agent } = await createNexusAgent({ model, plugins: [] });

    const { printer, stdout } = recorder();
    await runTurn(agent, '說點什麼', printer, new SessionLog('t'));

    expect(stdout()).toContain('沒事發生。');
    expect(stdout()).not.toContain('核准');
  });
});

describe('runTurn 照 loop 拒收太大的人話（#2415）', () => {
  const tooLarge = 'x'.repeat(HUMAN_MESSAGE_LIMIT_CHARS + 1);

  it('native：寫 turn/start 之前拋，日誌不動；剛好等於上限的照跑', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '收到。' }] });
    const { agent } = await createNexusAgent({ model, plugins: [] });
    const { printer } = recorder();
    const sessionLog = new SessionLog('t');
    await expect(
      runTurn(agent, tooLarge, printer, sessionLog, undefined, 'native'),
    ).rejects.toThrow('message-too-large: 這則訊息有 200,001 字，超過上限 200,000 字');
    expect(sessionLog.events).toEqual([]);
    await runTurn(
      agent,
      'y'.repeat(HUMAN_MESSAGE_LIMIT_CHARS),
      printer,
      sessionLog,
      undefined,
      'native',
    );
    expect(sessionLog.events.map((event) => event.type)).toContain('turn/start');
  });

  it('省略 loop（langgraph）：不拒收，照跑', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '收到。' }] });
    const { agent } = await createNexusAgent({ model, plugins: [] });
    const { printer, stdout } = recorder();
    const sessionLog = new SessionLog('t');
    await runTurn(agent, tooLarge, printer, sessionLog);
    expect(sessionLog.events[0]?.type).toBe('turn/start');
    expect(stdout()).toContain('收到。');
  });
});

/**
 * CLI 收人話的每個入口照 loop 拒收太大的人話（#1827 D234）：REPL 打的那一句、REPL 的 `/plan <message>`、一次性的 prompt。
 * native 下拒收、日誌不開那一輪；langgraph 照收（基座的 `beforeAgent` 照舊搬檔）。
 */
describe('CLI 收人話的入口照 loop 拒收', () => {
  const tooLarge = 'x'.repeat(HUMAN_MESSAGE_LIMIT_CHARS + 1);
  const REJECTION = 'message-too-large: 這則訊息有 200,001 字，超過上限 200,000 字';

  async function repl(line: string, loop: 'native' | 'langgraph') {
    const { agent, commands, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({ turns: [{ content: '收到。' }] }),
      plugins: shipped,
      checkpointer: new MemorySaver(),
    });
    // 接上日誌：`/plan` 要有地方記下模式，才會走到接著送的那句話。
    const sessions = new SessionRegistry('t');
    const detach = attachSession(sessions);
    const { printer, stderr } = recorder();
    const input = new PassThrough();
    input.end(`${line}\n/exit\n`);
    try {
      await runRepl(
        agent,
        { input, output: new PassThrough() },
        printer,
        sessions.root,
        commands,
        undefined,
        undefined,
        undefined,
        undefined,
        loop,
      );
    } finally {
      detach();
      await dispose();
    }
    return { stderr, types: sessions.root.events.map((event) => event.type) };
  }

  it('native：REPL 打的那一句太大，印錯誤、不開那一輪', async () => {
    const { stderr, types } = await repl(tooLarge, 'native');
    expect(stderr()).toContain(REJECTION);
    expect(types).not.toContain('turn/start');
  });

  it('native：REPL 的 /plan <message> 太大，命令落定成 error、計劃模式沒打開、不開那一輪', async () => {
    const { stderr, types } = await repl(`/plan ${tooLarge}`, 'native');
    expect(stderr()).toContain(REJECTION);
    expect(types).toEqual(['command/run', 'command/done']);
  });

  it('langgraph：REPL 打的那一句與 /plan <message> 都照收', async () => {
    expect((await repl(tooLarge, 'langgraph')).types).toContain('turn/start');
    expect((await repl(`/plan ${tooLarge}`, 'langgraph')).types).toContain('turn/start');
  });

  it('native：一次性的 prompt 太大，runCli 拋', async () => {
    const { printer } = recorder();
    await expect(
      runCli({
        argv: ['--agent-loop', 'native', tooLarge],
        input: new PassThrough(),
        output: new PassThrough(),
        printer,
      }),
    ).rejects.toThrow(REJECTION);
  });
});

/**
 * CLI 這個入口沒有人在，所以它不停。
 *
 * [#113](https://github.com/DemianLi/nexus-agent/issues/113) 拍板 (a)：預設關掉、不加旗標。
 * **這一組要證的是「接上了」，不是「閘門會拒絕」**——閘門本身的行為在
 * [`interrupt.test.ts`](./interrupt.test.ts) 與 `@nexus/core` 的 `approval.test.ts` 驗過，
 * 這裡問的是 `runCli` 這條路真的把政策傳了下去。
 *
 * **`serve-run.ts` 那條刻意不一樣**，而那半邊的證據在 [`serve.test.ts`](./serve.test.ts) 的
 * 「核准那份清單」：同一份 fixture、同一個閘門，走 web 那條會停下來、按得下去、接得回來。
 * 兩邊一起看才看得出「入口不同答案不同」是選的不是漏的——只看一邊的話，另一邊悄悄
 * 跟著改了也沒有東西會紅。
 */
describe('CLI 的核准政策', () => {
  it('標了核准的清單也跑得完一整輪——被擋的沒跑，理由是「沒有人被問到」', async () => {
    const { printer, stdout } = recorder();
    await runCli({
      // **fixture 是從 `docs/operations.md` 讀進來的**（#490），跟 `serve.test.ts` 同一份：
      // `echo` 與 `write_file` 都標了要核准，而假模型的腳本兩個都會叫。
      argv: ['--patch', documentedFixture(), '動手'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
      env: {},
    });

    const out = stdout();
    // 跑得完：腳本第三輪（沒有工具呼叫的那一輪）真的講到了。這一句是「整輪作廢」的反面。
    expect(out).toContain('工具回來了，這條線是通的。');
    // 而且不是停下來——`printInterrupt` 一個字都沒印。
    expect(out).not.toContain('停在核准點');
    // 理由分得出「沒有人被問到」與「有人看過並拒絕」——那一格塌掉的話，模型會以為
    // 是人否決了它，然後改用別的辦法去做同一件事。
    expect(out).toContain('是沒有人被問到');
    expect(out).not.toContain('有人看過並拒絕');
    // **工具是真的沒跑**，不是只有措辭變了：沒有回聲，也沒有檔案落下來
    //（跑了的話最後一行會是「虛擬檔案系統：/cli.md」）。
    expect(out).not.toContain('回聲：');
    expect(out).not.toContain(CLI_PROBE_FILE);
  });

  it('沒被擋的工具照跑——關掉核准不是關掉整條工具路徑', async () => {
    // 只擋 `write_file`，`echo` 放行。上一條的 fixture 兩個都擋，所以它證不了這件事：
    // 「閘門把每個工具都拒絕掉」在那條測試底下長得一模一樣。
    const gateWriteFile: PluginEntry = {
      plugin: {
        name: 'gate-write-file',
        apply(registry) {
          registry.approvals.gate((exec, next) =>
            exec.name === 'write_file' ? { kind: 'ask', reason: '寫檔要人看過' } : next(),
          );
        },
      },
    };

    const { agent, dispose, sessionLog } = await createCliAgent(
      { live: false },
      [createEchoPlugin(), gateWriteFile, await shippedModelRow()],
      undefined,
      { approvals: HEADLESS_APPROVALS },
    );
    const { printer, stdout } = recorder();
    try {
      await runTurn(agent, '動手', printer, sessionLog);
    } finally {
      await dispose();
    }

    const out = stdout();
    expect(out).toContain('回聲：CLI 接線測試');
    expect(out).toContain('是沒有人被問到');
    expect(out).not.toContain(CLI_PROBE_FILE);
  });

  it('banner 說得出核准是關的——(a) 不加旗標，換成把它講出來', async () => {
    const { printer, stdout } = recorder();
    await runCli({
      argv: ['把這句話回聲一次。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
      env: {},
    });
    // 不講的話，「這個工具被政策擋掉了」與「模型自己決定不叫它」在畫面上分不出來。
    expect(stdout()).toContain(APPROVAL_DISCLOSURE);
  });
});

/**
 * `--workspace` 換掉的是 **default backend**——組裝點自己的東西，plugin 不得提供
 * （[#28](https://github.com/DemianLi/nexus-agent/issues/28) 決議 3）。
 *
 * 這裡只驗接線：旗標真的把 backend 換成了真實磁碟的那一個。圍堵本身的行為在
 * [`contained-backend.test.ts`](./contained-backend.test.ts)，從 CLI 再測一次只是把同一件事
 * 測兩遍。
 */
describe('--workspace 換成真實磁碟', () => {
  it('給了就寫進那個目錄', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-cli-ws-'));
    const { printer, stdout } = recorder();

    await runCli({
      argv: ['--workspace', root, '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
    });

    expect(stdout()).toContain(root);
    expect(await readFile(join(root, 'cli.md'), 'utf8')).toBe('CLI 寫的');
  });

  it('省略就完全不碰磁碟', async () => {
    const { printer, stdout } = recorder();

    await runCli({
      argv: ['說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
    });

    // 檔案還是寫得出來，只是寫進 state 裡的虛擬 FS——`runTurn` 把它印在最後一行。
    expect(stdout()).toContain('虛擬（不碰磁碟）');
    expect(stdout()).toContain(CLI_PROBE_FILE);
  });
});

/**
 * 收拾與原本的錯誤，誰優先。
 *
 * 這一段守的是一個真的踩過的坑：`runCli` 原本把 `await dispose()` 放在 `finally` 裡，
 * 而 `finally` 裡的 `await` 一拋錯就會把 `try` 裡那個錯誤整個蓋掉——使用者看到「關機
 * 清理失敗」，真正壞掉的那件事無聲消失。
 *
 * 讓那一輪拋錯的方法是給一個會拋的 printer。這不是在模擬某個真實故障，而是**這一段唯一
 * 要問的事就是兩個錯誤誰浮上來**，所以用什麼把第一個錯誤生出來不重要，重要的是它確實
 * 發生在 `dispose()` 之前。
 */
describe('關機清理與原本的錯誤', () => {
  const fixture = fileURLToPath(new URL('./cli-dispose-failure.patch.yml', import.meta.url));

  it('那一輪跑壞時，浮上來的是原本那個錯誤，不是清理失敗', async () => {
    const failure = new Error('那一輪就壞在這裡');
    const printer = {
      log: (line: string) => {
        if (line.startsWith('> ')) throw failure;
      },
      error: () => {},
    };

    await expect(
      runCli({
        argv: ['--patch', fixture, '說點什麼'],
        input: new PassThrough(),
        output: new PassThrough(),
        printer,
      }),
    ).rejects.toThrow(failure.message);
  });

  it('那一輪跑成功時，清理失敗要浮上來——沒收乾淨代表可能還有子行程活著', async () => {
    const { printer } = recorder();

    await expect(
      runCli({
        argv: ['--patch', fixture, '說點什麼'],
        input: new PassThrough(),
        output: new PassThrough(),
        printer,
      }),
    ).rejects.toThrow(DISPOSE_FAILURE);
  });
});

describe('對話的連續性', () => {
  it('第二輪看得到第一輪說過的話——REPL 是一條對話，不是一串互不相干的呼叫', async () => {
    const { printer } = recorder();
    const { agent, model, sessionLog } = await createCliAgent({ live: false }, shipped);

    await runTurn(agent, '第一句：記住「胡桃」這兩個字。', printer, sessionLog);
    await runTurn(agent, '第二句：剛剛那兩個字是什麼？', printer, sessionLog);

    // 送進模型的第二輪 prompt 裡還帶著第一句——狀態在 checkpointer 裡，靠 thread_id 認領。
    const prompt = (model as ScriptedChatModel).lastPrompt
      .map((message) => message.text)
      .join('\n');
    expect(prompt).toContain('胡桃');
    expect(prompt).toContain('剛剛那兩個字是什麼');
  });
});

describe('REPL', () => {
  /** 一輪 echo，腳本就用完——第二句話會撞上「腳本只有 N 輪」。 */
  const ONE_TURN: readonly ScriptedTurn[] = [
    {
      content: '回聲一下。',
      toolCalls: [{ name: ECHO_TOOL_NAME, args: { message: '嗨' } }],
    },
    { content: '好了。' },
  ];

  async function replAgent() {
    const { agent, commands } = await createNexusAgent({
      model: new ScriptedChatModel({ turns: ONE_TURN }),
      plugins: shipped,
    });
    return { agent, commands };
  }

  it('一行一輪，/exit 收工', async () => {
    const { printer, stdout } = recorder();
    const input = new PassThrough();
    input.end('說點什麼\n/exit\n');

    const repl = await replAgent();
    await runRepl(
      repl.agent,
      { input, output: new PassThrough() },
      printer,
      new SessionLog('t'),
      repl.commands,
    );

    expect(stdout()).toContain('回聲：嗨');
  });

  /**
   * **非同步輸出不能弄亂輸入行**（[#1099](https://github.com/DemianLi/nexus-agent/issues/1099)）：組裝之後外掛執行期交出的話
   * （MCP 掉線重連的進度）隨時會來，包括人正在提示字元後面打字的時候。停在提示字元且輸出是 TTY 時，`redraw` 要先清掉這一行、
   * 印訊息、再把提示字元連同已經打的字畫回來；其餘情況（不是 TTY、沒在等輸入）照原樣直接印。
   */
  describe('非同步輸出與輸入行', () => {
    /** 一條假 TTY：`isTTY` 為真，收下 readline 寫進去的所有轉義序列。 */
    function terminal(isTTY: boolean) {
      const output = Object.assign(new PassThrough(), { isTTY });
      let written = '';
      output.on('data', (chunk: Buffer) => void (written += chunk.toString()));
      return { output, written: () => written };
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    async function start(isTTY: boolean) {
      const { output, written } = terminal(isTTY);
      const input = new PassThrough();
      const line: ReplLine = {};
      const repl = await replAgent();
      const done = runRepl(
        repl.agent,
        { input, output },
        recorder().printer,
        new SessionLog('t'),
        repl.commands,
        undefined,
        undefined,
        undefined,
        line,
      );
      await settle();
      return { input, line, written, done };
    }

    it('停在提示字元、輸出是 TTY：清掉這一行、印訊息、把提示字元與已打的字畫回來', async () => {
      const { input, line, written, done } = await start(true);
      input.write('abc'); // 打到一半，沒按 Enter
      await settle();
      const before = written().length;
      const order: string[] = [];
      line.redraw?.(() => {
        order.push(`印訊息時畫面：${JSON.stringify(written().slice(before))}`);
      });
      const after = written().slice(before);
      // 先清行（`ESC[2K`）再移到行首（`ESC[1G`），印訊息之後才重畫提示字元，且帶回 `abc`。
      expect(order[0]).toContain('\\u001b[2K');
      expect(order[0]).toContain('\\u001b[1G');
      expect(after.indexOf('> abc')).toBeGreaterThan(after.indexOf('\u001b[1G'));
      expect(after).toContain('> abc');
      input.end('\n/exit\n');
      await done;
    });

    it('輸出不是 TTY：不碰轉義序列，只呼叫印的那一段', async () => {
      const { input, line, written, done } = await start(false);
      const before = written().length;
      let printed = 0;
      line.redraw?.(() => void (printed += 1));
      expect(printed).toBe(1);
      expect(written().slice(before)).toBe('');
      input.end('/exit\n');
      await done;
    });

    it('跑一輪的期間（沒在等輸入）：直接印，不畫提示字元', async () => {
      const { input, line, written, done } = await start(true);
      input.write('說點什麼\n'); // 送出之後那一輪還在跑，提示字元還沒回來
      const before = written().length;
      let printed = 0;
      line.redraw?.(() => void (printed += 1));
      expect(printed).toBe(1);
      expect(written().slice(before)).not.toContain('> ');
      input.end('/exit\n');
      await done;
    });

    it('REPL 收掉之後 redraw 不再有值', async () => {
      const { input, line, done } = await start(true);
      expect(line.redraw).toBeDefined();
      input.end('/exit\n');
      await done;
      expect(line.redraw).toBeUndefined();
    });
  });

  it('stdin 收掉就結束——沒有 /exit 也不會卡住', async () => {
    const input = new PassThrough();
    input.end('說點什麼\n');

    const repl = await replAgent();
    await expect(
      runRepl(
        repl.agent,
        { input, output: new PassThrough() },
        recorder().printer,
        new SessionLog('t'),
        repl.commands,
      ),
    ).resolves.toBeUndefined();
  });

  it('一輪答壞了印進 stderr 並繼續問下一句，不關掉整個 REPL', async () => {
    const { printer, stdout, stderr } = recorder();
    const input = new PassThrough();
    // 第二句話時腳本已經用完，那一輪會拋。
    input.end('第一句\n第二句\n第三句\n');

    const repl = await replAgent();
    await runRepl(
      repl.agent,
      { input, output: new PassThrough() },
      printer,
      new SessionLog('t'),
      repl.commands,
    );

    expect(stdout()).toContain('回聲：嗨');
    expect(stderr()).toMatch(/腳本只有 2 輪/);
    // 第三句還問得出去——REPL 沒有被那個錯誤帶走。
    expect(stderr().match(/腳本只有 2 輪/g)).toHaveLength(2);
  });
});

/**
 * 端到端，**只此一條**。
 *
 * 驗的是錯誤傳播路徑不被吞掉：衝突規則本身是 `packages/nexus-core` 的單測在管，而從
 * registry 到行程退出碼的路只有一條，所以這裡只需要一個案例。
 *
 * **偏離 dsh 一處**：它的 `built-bin.e2e.ts` 跑的是建構後的 `lib/bin.js` 加原生 `node`，
 * 為的是抓 tsx 會掩蓋的失敗。這個 repo 沒有建構產物（`build` 就是 `tsc --noEmit`、
 * package 的 `main` 直接指向 `src`），所以退到最接近的做法：用 tsx 跑原始碼入口，
 * 但仍然是**另起一個行程**跑真的 argv——這條測試要驗的退出碼與 stderr 只有在那裡才存在。
 */
describe('CLI 行程', () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const fixture = fileURLToPath(new URL('./cli-collision.patch.yml', import.meta.url));
  const harnessDir = fileURLToPath(new URL('../', import.meta.url));

  /** 起一個 CLI 行程，關掉 stdin（否則沒給話的呼叫會停在 REPL 等輸入）。 */
  function runProcess(args: readonly string[]): Promise<{ code: number | null; stderr: string }> {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: harnessDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    child.stdin.end();

    const stderr: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => void stderr.push(chunk));
    // stdout 要讀掉，否則子行程可能塞在寫入上。
    child.stdout.resume();

    return new Promise((settle, fail) => {
      child.once('error', fail);
      child.once('close', (code) => void settle({ code, stderr: stderr.join('') }));
    });
  }

  /**
   * 撞上去的那一列是 `insert` 進來的可少掛列（#751）：照 dsh，它 `apply` 拋錯只讓它自己掉，行程照樣跑完。錯誤沒有被
   * 吞掉——它從 registry 一路傳到行程的 stderr，那段警告指名撞的是哪兩個 plugin。
   */
  it('兩個 plugin 撞同一個工具名：後來的那一列掉了、退出碼是 0，stderr 的警告指名是誰撞了什麼', async () => {
    const { code, stderr } = await runProcess(['--patch', fixture, '說點什麼']);

    expect(code).toBe(0);
    expect(stderr).toMatch(
      new RegExp(`^ {2}${SECOND_PLUGIN_NAME}（file:[^）]+）掛上時失敗：`, 'mu'),
    );
    // **不能只 `toContain(FIRST_PLUGIN_NAME)`**：出貨清單上那顆 echo plugin 的名字，跟它
    // 註冊的那個工具名是同一個字串（`ECHO_TOOL_NAME === 'echo'`），而衝突訊息本來就會講
    // 「已經有名為 echo 的工具」——那半句自己就滿足了斷言，於是「有指名先註冊的是誰」
    // 變成恆真。裸組裝的年代那兩個名字不一樣，所以以前看不出來；換成疊在出貨清單上之後
    // 才重合。實測過：把 `duplicateToolError` 裡的 `formatOrigin(existing)` 換成一句不指名
    // 的話，舊的兩條 `toContain` 照樣綠，底下這一條會紅。
    expect(stderr).toMatch(
      new RegExp(
        `${FIRST_PLUGIN_NAME} \\(${FIRST_PLUGIN_NAME}\\) 註冊過[\\s\\S]*` +
          `${SECOND_PLUGIN_NAME} \\(${SECOND_PLUGIN_NAME}\\) 又註冊一次`,
        'u',
      ),
    );
  }, 90_000);

  /**
   * **起不來的那一次退出碼是 1，不是 2**：組裝失敗不是撞到迴圈上限，兩者要分得開。用必掛的 `browser-session` 寫壞測，
   * 它掉了整個起不來（#751）。
   */
  it('必掛的列寫壞了：起不來、退出碼是 1，stderr 指名那一列', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-cli-required-'));
    try {
      await chmod(dir, 0o700);
      const patch = join(dir, 'bad.yml');
      await writeFile(patch, '- id: browser-session\n  config:\n    maxAgeDays: 0\n', {
        mode: 0o600,
      });
      const { code, stderr } = await runProcess(['--patch', patch, '說點什麼']);
      expect(code).toBe(1);
      expect(stderr).toMatch(/browser-session（#settings\/browser-session）〔必掛〕設定驗不過/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);

  /**
   * 退出碼只存在於行程上，所以分岔要在這裡釘一次（#362）。對照組是同一句話、不帶旗標：
   * 預設腳本兩次工具呼叫就講完，跑得完就是 0——所以 2 來自旗標，不是腳本本身出事。
   */
  it('一次性模式撞到 --recursion-limit 時退出碼是 2；不帶旗標跑得完是 0', async () => {
    const limited = await runProcess(['--recursion-limit', '8', '說點什麼']);
    expect(limited.code).toBe(2);
    expect(limited.stderr).toMatch(/Recursion limit of 8 reached/);

    const control = await runProcess(['說點什麼']);
    expect(control.code).toBe(0);
  }, 120_000);
});

describe('--patch 與工作區（#2162）', () => {
  it('在工作區外：照常起', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'nexus-2162-ws-')));
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'nexus-2162-out-')));
    await writeFile(join(outside, 'p.yml'), '[]\n', { mode: 0o600 });
    const { printer, stdout } = recorder();
    await runCli({
      argv: ['--dump-config', '--workspace', workspace, '--patch', join(outside, 'p.yml')],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
    });
    expect(stdout()).toContain('# == ');
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('在工作區裡：起不來，一輪都沒跑', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'nexus-2162-ws-')));
    await writeFile(join(workspace, 'p.yml'), '[]\n', { mode: 0o600 });
    const { printer, stdout } = recorder();
    await expect(
      runCli({
        argv: ['--workspace', workspace, '--patch', join(workspace, 'p.yml'), '說點什麼'],
        input: new PassThrough(),
        output: new PassThrough(),
        printer,
      }),
    ).rejects.toThrow('不能在 --workspace 底下');
    expect(stdout()).toBe('');
    await expect(
      runCli({
        argv: [
          '--dump-config-schema',
          '--workspace',
          workspace,
          '--patch',
          join(workspace, 'p.yml'),
        ],
        input: new PassThrough(),
        output: new PassThrough(),
        printer,
      }),
    ).rejects.toThrow('不能在 --workspace 底下');
    await rm(workspace, { recursive: true, force: true });
  });
});

/**
 * CLI 單機跑一輪（推理、文字、一顆好的與一顆參數壞掉的工具呼叫，接著收尾的文字）的會話日誌與請求本文，native 與 `langgraph`
 * 各一份，釘成夾具逐位元組比（#2361）。請求本文比對前先拿掉 `stream` 與 `stream_options`。假端點照請求的 `stream` 回一整包 JSON 或 SSE，兩種回的是
 * 同一份內容，所以夾具之間的差異只來自 CLI 送的是哪一種請求。只正規化每次跑都會變的格（見 `normalizedLog`）。
 */
describe('CLI 單機的會話日誌（夾具）', () => {
  const FIXTURE = fileURLToPath(new URL('./fixtures/cli-turn-log/', import.meta.url));

  function reply(body: CliEndpointBody): CliEndpointReply {
    const toolResults = body.messages.filter((message) => message.role === 'tool').length;
    if (body.tools === undefined) return { content: '讀檔' };
    if (toolResults === 0)
      return {
        reasoning: '要讀檔',
        content: '我來讀',
        calls: [
          { id: 'call_read', name: 'read_file', arguments: '{"file_path":"/a.txt"}' },
          { id: 'call_bad', name: 'ls', arguments: '{"path":' },
        ],
      };
    return { reasoning: '讀完', content: '讀完了。' };
  }

  it.each(['native', 'langgraph'] as const)(
    '%s：一輪的日誌與送出的請求本文跟夾具相同',
    async (loop) => {
      vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-cli-native-stream');
      const upstream = await cliEndpoint(reply);
      const home = await mkdtemp(join(tmpdir(), 'nexus-cli-ns-home-'));
      const logs = await mkdtemp(join(tmpdir(), 'nexus-cli-ns-logs-'));
      const cwd = await mkdtemp(join(tmpdir(), 'nexus-cli-ns-cwd-'));
      const patch = join(home, 'patch.yml');
      await writeFile(
        patch,
        liveModelPatch(upstream.baseURL, '- id: thread-title-llm\n  disabled: true\n'),
        {
          mode: 0o600,
        },
      );
      try {
        await runCli({
          argv: [
            '--live',
            '--agent-loop',
            loop,
            '--session-log',
            logs,
            '--patch',
            patch,
            '讀 /a.txt',
          ],
          cwd,
          env: { [HARNESS_HOME_ENV]: home },
          input: new PassThrough(),
          output: new PassThrough(),
          printer: { log: () => undefined, error: () => undefined },
        });
      } finally {
        await upstream.close();
        vi.unstubAllEnvs();
      }
      const log = normalizedLog(await readJsonlTree(logs), [home, logs, cwd]);
      const bodies = upstream.bodies.map((body) => {
        const {
          stream: _stream,
          stream_options: _options,
          ...rest
        } = body as Record<string, unknown>;
        return rest;
      });
      await rm(home, { recursive: true, force: true });
      await rm(logs, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      await expect(log).toMatchFileSnapshot(join(FIXTURE, `session.${loop}.jsonl`));
      // 副檔名用 `.snap` 不用 `.json`：Prettier 會把 `JSON.stringify(…, 2)` 的短陣列併成一行，格式化過的夾具就跟這裡寫出的對不上。
      await expect(`${JSON.stringify(bodies, null, 2)}\n`).toMatchFileSnapshot(
        join(FIXTURE, `request-bodies.${loop}.snap`),
      );
    },
  );
});

/**
 * 字串 content、推理在 `additional_kwargs`、`response_metadata` 帶 `tokenUsage` 與原始 `usage` 的 native 日誌
 * （`session.native.before-stream.jsonl`）續接得回來：送出的請求跟續接一份 v1 形狀的日誌相比，只差在 assistant 的文字是字串還是
 * text 區塊（#2361）。
 */
describe('CLI 單機 native 續接改動前形狀的日誌', () => {
  const BEFORE = fileURLToPath(
    new URL('./fixtures/cli-turn-log/session.native.before-stream.jsonl', import.meta.url),
  );

  function reply(body: CliEndpointBody): CliEndpointReply {
    if (body.tools === undefined) return { content: '讀檔' };
    const humans = body.messages.filter((message) => message.role === 'user').length;
    const toolResults = body.messages.filter((message) => message.role === 'tool').length;
    if (humans > 1) return { content: '還記得。' };
    if (toolResults === 0)
      return {
        reasoning: '要讀檔',
        content: '我來讀',
        calls: [
          { id: 'call_read', name: 'read_file', arguments: '{"file_path":"/a.txt"}' },
          { id: 'call_bad', name: 'ls', arguments: '{"path":' },
        ],
      };
    return { reasoning: '讀完', content: '讀完了。' };
  }

  async function resumedRequest(swapInOldShape: boolean): Promise<unknown> {
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-cli-native-resume');
    const upstream = await cliEndpoint(reply);
    const home = await mkdtemp(join(tmpdir(), 'nexus-cli-nr-home-'));
    const logs = await mkdtemp(join(tmpdir(), 'nexus-cli-nr-logs-'));
    const cwd = await mkdtemp(join(tmpdir(), 'nexus-cli-nr-cwd-'));
    const patch = join(home, 'patch.yml');
    await writeFile(
      patch,
      liveModelPatch(upstream.baseURL, '- id: thread-title-llm\n  disabled: true\n'),
      { mode: 0o600 },
    );
    const cli = (argv: readonly string[], input: PassThrough) =>
      runCli({
        argv: ['--live', '--agent-loop', 'native', '--patch', patch, ...argv],
        cwd,
        env: { [HARNESS_HOME_ENV]: home },
        input,
        output: new PassThrough(),
        printer: { log: () => undefined, error: () => undefined },
      });
    try {
      await cli(['--session-log', logs, '讀 /a.txt'], new PassThrough());
      const [run] = await readdir(logs);
      const runDir = join(logs, run!);
      const [file] = (await readdir(runDir, { recursive: true })).filter((name) =>
        name.endsWith('.jsonl'),
      );
      const path = join(runDir, file!);
      if (swapInOldShape) {
        const old = (await readFile(BEFORE, 'utf8'))
          .split('\n')
          .filter((line) => line.includes('"type":"assistant/message"'));
        const lines = (await readFile(path, 'utf8')).split('\n');
        const swapped = lines.map((line) =>
          line.includes('"type":"assistant/message"') ? old.shift()! : line,
        );
        expect(old).toEqual([]);
        await writeFile(path, swapped.join('\n'));
      }
      upstream.bodies.length = 0;
      const input = new PassThrough();
      input.end('還記得剛剛讀了什麼嗎\n/exit\n');
      await cli(['--resume', runDir], input);
      return upstream.bodies.find((body) => (body as CliEndpointBody).tools !== undefined);
    } finally {
      await upstream.close();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(logs, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  }

  it('舊形狀的兩則 assistant/message 續接得回來：送出的請求只差在 assistant 的文字是字串還是 text 區塊', async () => {
    type Body = { messages: { role: string; content?: unknown }[] };
    const before = (await resumedRequest(true)) as Body;
    const after = (await resumedRequest(false)) as Body;
    const assistants = (body: Body) =>
      body.messages.filter((message) => message.role === 'assistant').map((m) => m.content);
    expect(assistants(before)).toEqual(['我來讀', '讀完了。']);
    expect(assistants(after)).toEqual([
      [{ type: 'text', text: '我來讀' }],
      [{ type: 'text', text: '讀完了。' }],
    ]);
    const asText = (body: Body) => ({
      ...body,
      messages: body.messages.map((message) =>
        message.role === 'assistant' && Array.isArray(message.content)
          ? {
              ...message,
              content: (message.content as { text: string }[]).map((b) => b.text).join(''),
            }
          : message,
      ),
    });
    expect(JSON.stringify(asText(after))).toBe(JSON.stringify(before));
    expect(before.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
      'user',
    ]);
  });
});

interface CliEndpointBody {
  readonly messages: readonly { readonly role: string }[];
  readonly tools?: readonly unknown[];
  readonly stream?: boolean;
}

interface CliEndpointReply {
  readonly reasoning?: string;
  readonly content: string;
  readonly calls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  }[];
}

/** 照請求的 `stream` 回一整包 JSON 或 SSE；兩種的 id、模型、內容、結束原因與用量都相同。 */
async function cliEndpoint(script: (body: CliEndpointBody) => CliEndpointReply) {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CliEndpointBody;
      const id = `chatcmpl-cli-${bodies.length}`;
      bodies.push(body);
      const { reasoning, content, calls = [] } = script(body);
      const finish = calls.length > 0 ? 'tool_calls' : 'stop';
      const usage = {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        completion_tokens_details: { reasoning_tokens: 3 },
      };
      const head = { id, created: 0, model: DEFAULT_LIVE_MODEL_ID };
      const toolCalls = calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ...head,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content,
                  ...(reasoning !== undefined && { reasoning_content: reasoning }),
                  ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
                },
                finish_reason: finish,
              },
            ],
            usage,
          }),
        );
        return;
      }
      const frame = (payload: Record<string, unknown>) =>
        `data: ${JSON.stringify({ ...head, object: 'chat.completion.chunk', ...payload })}\n\n`;
      const delta = (value: Record<string, unknown>, finishReason: string | null = null) =>
        frame({ choices: [{ index: 0, delta: value, finish_reason: finishReason }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(delta({ role: 'assistant', content: '' }));
      if (reasoning !== undefined) res.write(delta({ reasoning_content: reasoning }));
      res.write(delta({ content }));
      for (const [index, call] of toolCalls.entries())
        res.write(delta({ tool_calls: [{ index, ...call }] }));
      res.write(delta({}, finish));
      res.write(frame({ choices: [], usage }));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 目錄底下每個 `.jsonl`，照相對路徑排序後接起來；每個檔前面一行 `# <相對路徑>`。 */
async function readJsonlTree(root: string): Promise<string> {
  const files = (await readdir(root, { recursive: true }))
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  const parts: string[] = [];
  for (const name of files) parts.push(`# ${name}\n${await readFile(join(root, name), 'utf8')}`);
  return parts.join('');
}

/** 每次跑都會變的格：時間、暫存路徑、亂數 id、建置資訊、設定雜湊（帶 home 的金鑰與 port）。 */
function normalizedLog(text: string, paths: readonly string[]): string {
  let out = text;
  for (const [index, path] of paths.entries()) out = out.split(path).join(`<tmp${index}>`);
  return out
    .replace(/"build":\{[^}]*\}/gu, '"build":"<build>"')
    .replace(/"configHash":"[^"]*"/gu, '"configHash":"<hash>"')
    .replace(/127\.0\.0\.1:\d+/gu, '127.0.0.1:<port>')
    .replace(/^# [^/\n]+\//gmu, '# <run>/')
    .replace(/"(time|ts|startedAt|endedAt|createdAt)":\s?"[^"]*"/gu, '"$1":"<time>"')
    .replace(/"(time|ts|startedAt|endedAt|createdAt|elapsedMs|durationMs)":\s?\d+/gu, '"$1":0')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<uuid>');
}

/**
 * CLI 單機 native（打串流請求）的計時與用量（#2361）：到第一則事件的 `timeoutMs` 加上閒置的 `streamIdleTimeoutMs`，沒有總上限；
 * 吐過用量才失敗的那一次多記一筆帶 `outcome` 的 `model/usage`。
 */
describe('CLI 單機 native 的串流計時與用量', () => {
  type Respond = (res: import('node:http').ServerResponse, attempt: number) => void;

  const head = { id: 'chatcmpl-timing', created: 0, model: DEFAULT_LIVE_MODEL_ID };
  const frame = (payload: Record<string, unknown>) =>
    `data: ${JSON.stringify({ ...head, object: 'chat.completion.chunk', ...payload })}\n\n`;
  const delta = (value: Record<string, unknown>, finish: string | null = null) =>
    frame({ choices: [{ index: 0, delta: value, finish_reason: finish }] });
  const USAGE = frame({
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });

  function finishWith(res: import('node:http').ServerResponse, text: string): void {
    res.write(delta({ content: text }));
    res.write(delta({}, 'stop'));
    res.write(USAGE);
    res.end('data: [DONE]\n\n');
  }

  async function runNative(
    respond: Respond,
    config: Record<string, unknown>,
  ): Promise<{ attempts: number; log: string; thrown: unknown }> {
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-cli-native-timing');
    let attempts = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        attempts += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(delta({ role: 'assistant', content: '' }));
        respond(res, attempts);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const home = await mkdtemp(join(tmpdir(), 'nexus-cli-timing-home-'));
    const logs = await mkdtemp(join(tmpdir(), 'nexus-cli-timing-logs-'));
    const cwd = await mkdtemp(join(tmpdir(), 'nexus-cli-timing-cwd-'));
    const patch = join(home, 'patch.yml');
    const row = {
      ...shippedLiveModelConfig(),
      baseUrl: `http://127.0.0.1:${port}/v1`,
      ...config,
    };
    // JSON 也是合法的 YAML。
    await writeFile(
      patch,
      `- id: live-model\n  config: ${JSON.stringify(row)}\n- id: thread-title-llm\n  disabled: true\n`,
      { mode: 0o600 },
    );
    let thrown: unknown;
    try {
      await runCli({
        argv: ['--live', '--agent-loop', 'native', '--session-log', logs, '--patch', patch, '嗨'],
        cwd,
        env: { [HARNESS_HOME_ENV]: home },
        input: new PassThrough(),
        output: new PassThrough(),
        printer: { log: () => undefined, error: () => undefined },
      }).catch((error: unknown) => {
        thrown = error;
      });
      return { attempts, log: await readJsonlTree(logs), thrown };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
      for (const dir of [home, logs, cwd]) await rm(dir, { recursive: true, force: true });
    }
  }

  const retries = (maxRetries: number) => ({
    retryPolicy: {
      mode: 'normal',
      maxRetries,
      retryableCodes: ['TIMEOUT', 'TRANSPORT', 'UNKNOWN'],
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    },
  });

  const events = (log: string, type: string) =>
    log
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
      .filter((event) => event.type === type);

  it('吐一段就停住：閒置逾時觸發，進同一份重試預算（maxRetries + 1 次）', async () => {
    const { attempts, log, thrown } = await runNative(() => undefined, {
      streamIdleTimeoutMs: 200,
      ...retries(2),
    });
    expect(String(thrown)).toContain('閒置逾時');
    expect(attempts).toBe(3);
    expect(log).toContain('TIMEOUT');
    expect(events(log, 'assistant/message')).toHaveLength(0);
  });

  it('一直有吐、總長超過 timeoutMs：不逾時，一次就收', async () => {
    const { attempts, log } = await runNative(
      (res) => {
        let sent = 0;
        const tick = setInterval(() => {
          sent += 1;
          if (sent < 8) res.write(delta({ content: '字' }));
          else {
            clearInterval(tick);
            finishWith(res, '完');
          }
        }, 100);
      },
      { timeoutMs: 300, streamIdleTimeoutMs: 1000, ...retries(0) },
    );
    expect(attempts).toBe(1);
    const [reply] = events(log, 'assistant/message');
    expect(JSON.stringify(reply)).toContain('字字字字字字字完');
  });

  it('吐了用量之後斷線、重打成功：model/usage 兩筆，失敗那筆帶 outcome', async () => {
    const { attempts, log } = await runNative((res, attempt) => {
      if (attempt === 1) {
        res.write(delta({ content: '半' }));
        res.write(USAGE);
        setTimeout(() => res.socket?.destroy(), 50); // 等兩段寫出去再斷，當下 destroy 會丟掉緩衝裡的。
        return;
      }
      finishWith(res, '好');
    }, retries(1));
    expect(attempts).toBe(2);
    const usages = events(log, 'model/usage').map((event) => event.data);
    expect(usages).toHaveLength(2);
    expect(usages.filter((usage) => usage['outcome'] !== undefined)).toHaveLength(1);
    expect(usages[0]?.['outcome']).toBe('error');
    expect(usages[1]?.['outcome']).toBeUndefined();
  });
});
