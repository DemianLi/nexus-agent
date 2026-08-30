import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { describe, expect, it } from 'vitest';

import { SessionLog } from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';
import { z } from 'zod';
import { createNexusAgent, HEADLESS_APPROVALS } from './agent-factory.js';
import {
  COLLIDING_TOOL_NAME,
  FIRST_PLUGIN_NAME,
  SECOND_PLUGIN_NAME,
} from './cli-collision.fixture.js';
import {
  APPROVAL_DISCLOSURE,
  CLI_PROBE_FILE,
  createCliAgent,
  DEFAULT_PLUGINS,
  loadPluginModule,
  parseCliArgs,
  runCli,
  runRepl,
  runTurn,
} from './cli.js';
import { DISPOSE_FAILURE } from './cli-dispose-failure.fixture.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

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

  it('--workspace 收得到，空字串當場報錯', () => {
    expect(parseCliArgs(['--workspace', './ws']).workspace).toBe('./ws');
    expect(parseCliArgs([]).workspace).toBeUndefined();
    expect(() => parseCliArgs(['--workspace', '  '])).toThrow('--workspace');
  });

  it('旗標與那句話同時收得下，順序不拘', () => {
    const invocation = parseCliArgs(['--plugins', './list.js', '說點什麼', '--live']);
    expect(invocation).toMatchObject({
      live: true,
      pluginModule: './list.js',
      prompt: '說點什麼',
    });
  });

  it('不認得的旗標報錯，訊息接上用法', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow(/--nope[\s\S]*用法/);
  });

  it('--plugins 給空字串報錯——那是打錯了，不是「不指定」', () => {
    expect(() => parseCliArgs(['--plugins', ''])).toThrow(/--plugins/);
  });
});

describe('loadPluginModule', () => {
  const fixture = fileURLToPath(new URL('./cli-collision.fixture.ts', import.meta.url));

  it('載得到模組的預設匯出', async () => {
    const plugins = await loadPluginModule(fixture);
    expect(plugins.map((plugin) => plugin.name)).toEqual([FIRST_PLUGIN_NAME, SECOND_PLUGIN_NAME]);
  });

  it('相對路徑相對於呼叫者站的地方解析，不是相對於 cli.ts 也不是行程的工作目錄', async () => {
    // 刻意用 repo 根目錄當基準——它不等於跑測試時的工作目錄（`apps/harness`），
    // 兩者相同的話這條測試會在「根本沒解析」的實作下照樣通過。
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const plugins = await loadPluginModule('./apps/harness/src/cli-collision.fixture.ts', repoRoot);
    expect(plugins).toHaveLength(2);
  });

  it('預設匯出不是陣列時報錯，指名是哪個模組', async () => {
    const notAList = fileURLToPath(new URL('./messages.js', import.meta.url));
    await expect(loadPluginModule(notAList)).rejects.toThrow(/messages[\s\S]*不是陣列/);
  });

  it('載不到模組時報錯，把原因接進訊息', async () => {
    await expect(loadPluginModule('./沒有這個檔.js')).rejects.toThrow(/載不了 plugin 清單模組/);
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

  it('預設清單是一個工具 ＋ 十個配套入口', async () => {
    // **工具只有 echo 一個，這一半沒變**：預設組裝要能證明工具真的接上了，不替誰決定
    // 該裝什麼。十個配套入口是那句話的例外，理由寫在 `DEFAULT_PLUGINS` 的 JSDoc 上
    // （[#107](https://github.com/DemianLi/nexus-agent/issues/107)）。
    const names = DEFAULT_PLUGINS.map((plugin) => plugin.name);
    expect(names.filter((name) => !name.endsWith('-invariant'))).toEqual(['echo']);
    expect(names.filter((name) => name.endsWith('-invariant'))).toHaveLength(10);
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
      argv: ['--plugins', 'src/cli-invariant-violation.fixture.ts', '說點什麼'],
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

/**
 * CLI 這個入口沒有人在，所以它不停。
 *
 * [#113](https://github.com/DemianLi/nexus-agent/issues/113) 拍板 (a)：預設關掉、不加旗標。
 * **這一組要證的是「接上了」，不是「閘門會拒絕」**——閘門本身的行為在
 * [`interrupt.test.ts`](./interrupt.test.ts) 與 `@nexus/core` 的 `approval.test.ts` 驗過，
 * 這裡問的是 `runCli` 這條路真的把政策傳了下去。
 *
 * **`serve.ts` 那條刻意不一樣**，而那半邊的證據在 [`serve.test.ts`](./serve.test.ts) 的
 * 「核准那份清單」：同一份 fixture、同一個閘門，走 web 那條會停下來、按得下去、接得回來。
 * 兩邊一起看才看得出「入口不同答案不同」是選的不是漏的——只看一邊的話，另一邊悄悄
 * 跟著改了也沒有東西會紅。
 */
describe('CLI 的核准政策', () => {
  it('標了核准的清單也跑得完一整輪——被擋的沒跑，理由是「沒有人被問到」', async () => {
    const { printer, stdout } = recorder();
    await runCli({
      // 跟 README 與 `serve.test.ts` 同一份 fixture：`echo` 與 `write_file` 都標了要核准，
      // 而假模型的腳本兩個都會叫。
      argv: ['--plugins', 'src/approval.fixture.ts', '動手'],
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
    const gateWriteFile: NexusPlugin = {
      name: 'gate-write-file',
      apply(registry) {
        registry.approvals.gate((exec, next) =>
          exec.name === 'write_file' ? { kind: 'ask', reason: '寫檔要人看過' } : next(),
        );
      },
    };

    const { agent, dispose, sessionLog } = await createCliAgent(
      { live: false },
      [createEchoPlugin(), gateWriteFile],
      undefined,
      undefined,
      HEADLESS_APPROVALS,
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
  const fixture = fileURLToPath(new URL('./cli-dispose-failure.fixture.ts', import.meta.url));

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
        argv: ['--plugins', fixture, '說點什麼'],
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
        argv: ['--plugins', fixture, '說點什麼'],
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
    const { agent, model, sessionLog } = await createCliAgent({ live: false }, DEFAULT_PLUGINS);

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
    const { agent } = await createNexusAgent({
      model: new ScriptedChatModel({ turns: ONE_TURN }),
      plugins: DEFAULT_PLUGINS,
    });
    return agent;
  }

  it('一行一輪，/exit 收工', async () => {
    const { printer, stdout } = recorder();
    const input = new PassThrough();
    input.end('說點什麼\n/exit\n');

    await runRepl(
      await replAgent(),
      { input, output: new PassThrough() },
      printer,
      new SessionLog('t'),
    );

    expect(stdout()).toContain('回聲：嗨');
  });

  it('stdin 收掉就結束——沒有 /exit 也不會卡住', async () => {
    const input = new PassThrough();
    input.end('說點什麼\n');

    await expect(
      runRepl(
        await replAgent(),
        { input, output: new PassThrough() },
        recorder().printer,
        new SessionLog('t'),
      ),
    ).resolves.toBeUndefined();
  });

  it('一輪答壞了印進 stderr 並繼續問下一句，不關掉整個 REPL', async () => {
    const { printer, stdout, stderr } = recorder();
    const input = new PassThrough();
    // 第二句話時腳本已經用完，那一輪會拋。
    input.end('第一句\n第二句\n第三句\n');

    await runRepl(
      await replAgent(),
      { input, output: new PassThrough() },
      printer,
      new SessionLog('t'),
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
  const fixture = fileURLToPath(new URL('./cli-collision.fixture.ts', import.meta.url));
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

  it('兩個 plugin 撞同一個工具名時非零退出，stderr 指名是誰撞了什麼', async () => {
    const { code, stderr } = await runProcess(['--plugins', fixture, '說點什麼']);

    expect(code).not.toBe(0);
    expect(stderr).toContain(COLLIDING_TOOL_NAME);
    expect(stderr).toContain(FIRST_PLUGIN_NAME);
    expect(stderr).toContain(SECOND_PLUGIN_NAME);
  }, 90_000);
});
