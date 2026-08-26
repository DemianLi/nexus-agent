import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import {
  COLLIDING_TOOL_NAME,
  FIRST_PLUGIN_NAME,
  SECOND_PLUGIN_NAME,
} from './cli-collision.fixture.js';
import {
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

  it('預設清單裡的 echo 工具真的接上了', async () => {
    expect(DEFAULT_PLUGINS.map((plugin) => plugin.name)).toEqual(['echo']);
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
    const { agent, model } = await createCliAgent({ live: false }, DEFAULT_PLUGINS);

    await runTurn(agent, '第一句：記住「胡桃」這兩個字。', printer);
    await runTurn(agent, '第二句：剛剛那兩個字是什麼？', printer);

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

    await runRepl(await replAgent(), { input, output: new PassThrough() }, printer);

    expect(stdout()).toContain('回聲：嗨');
  });

  it('stdin 收掉就結束——沒有 /exit 也不會卡住', async () => {
    const input = new PassThrough();
    input.end('說點什麼\n');

    await expect(
      runRepl(await replAgent(), { input, output: new PassThrough() }, recorder().printer),
    ).resolves.toBeUndefined();
  });

  it('一輪答壞了印進 stderr 並繼續問下一句，不關掉整個 REPL', async () => {
    const { printer, stdout, stderr } = recorder();
    const input = new PassThrough();
    // 第二句話時腳本已經用完，那一輪會拋。
    input.end('第一句\n第二句\n第三句\n');

    await runRepl(await replAgent(), { input, output: new PassThrough() }, printer);

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
