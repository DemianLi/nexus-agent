// #2189 量具：假模型（腳本決定工具呼叫）、起 serve、wire client。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
export const R = process.env.R;
const { createWireClient } = await import(
  `${R}/node_modules/.pnpm/node_modules/@nexus/wire/lib/index.js`
).catch(async () => import(process.env.WIRE));

/** 提示詞含 `SCRIPT:<json>`：json 是一串 {name,args}，每個模型請求吐下一支，走完回文字。 */
export function startFakeModel({ onRequest } = {}) {
  const calls = [];
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[]}');
        return;
      }
      const body = JSON.parse(b);
      const msgs = body.messages;
      const toolNames = (body.tools ?? []).map((t) => t.function.name);
      calls.push({ at: Date.now(), n: msgs.length, tools: toolNames, last: undefined });
      {
        const after = msgs
          .slice(
            Math.max(
              0,
              msgs.findLastIndex((x) => x.role === 'assistant'),
            ),
          )
          .filter((x) => x.role === 'tool');
        if (after.length) calls.at(-1).last = after.at(-1).content;
      }
      onRequest?.(body);
      if (process.env.DBG && toolNames.length)
        console.log(
          'REQ',
          JSON.stringify(msgs.map((x) => [x.role, JSON.stringify(x.content).slice(0, 150)])).slice(
            -900,
          ),
        );
      let lastUser = -1;
      msgs.forEach((m, i) => {
        if (m.role === 'user' && JSON.stringify(m.content).includes('SCRIPT:')) lastUser = i;
      });
      const text = JSON.stringify(msgs[lastUser]?.content ?? '');
      const m = /SCRIPT:([A-Za-z0-9+\/=]+)ENDSCRIPT/.exec(text);
      const done = msgs.slice(lastUser + 1).filter((x) => x.role === 'assistant').length;
      const step =
        m && toolNames.length > 0
          ? JSON.parse(Buffer.from(m[1], 'base64').toString())[done]
          : undefined;
      if (step?.args?.content === '@BIG') step.args.content = 'a'.repeat(step.args.size);
      const delta = step
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                index: 0,
                id: `c${Date.now()}${done}`,
                type: 'function',
                function: { name: step.name, arguments: JSON.stringify(step.args) },
              },
            ],
          }
        : { role: 'assistant', content: '完成' };
      if (!step && toolNames.length > 0) counters.finals += 1;
      const rid = `r${calls.length}-${Date.now()}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (d, fr) =>
        `data: ${JSON.stringify({ id: rid, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: d, finish_reason: fr }] })}\n\n`;
      res.write(chunk(delta, null));
      res.write(chunk({}, step ? 'tool_calls' : 'stop'));
      res.write(
        `data: ${JSON.stringify({ id: rid, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((ok) =>
    srv.listen(0, '127.0.0.1', () =>
      ok({ baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, calls, close: () => srv.close() }),
    ),
  );
}

export function patchFile(path, baseUrl, extra = '') {
  writeFileSync(path, `- id: live-model\n  config:\n    baseUrl: '${baseUrl}'\n${extra}`);
}

export function startServe({ home, ws, logDir, patch, sandbox, env = {} }) {
  const argv = [
    `${R}/lib/serve.js`,
    '--live',
    '--port',
    '0',
    '--workspace',
    ws,
    '--session-log',
    logDir,
    '--patch',
    patch,
    ...(sandbox ? ['--sandbox', sandbox] : []),
  ];
  const child = spawn(process.execPath, argv, {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      NEXUS_AGENT_HOME: home,
      NVIDIA_API_KEY: 'fake-endpoint-not-a-key',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stderr.on('data', (d) => (out += d));
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('serve 起動逾時:\n' + out.slice(-1500))), 60000);
    child.once('exit', (c, s) => {
      clearTimeout(t);
      no(new Error(`serve 結束 ${c} ${s}:\n${out.slice(-1500)}`));
    });
    child.stdout.on('data', (d) => {
      out += d;
      const m = /nexus-agent 在 (http\S+)/.exec(out);
      if (m) {
        clearTimeout(t);
        child.removeAllListeners('exit');
        ok({ child, authUrl: m[1], url: new URL(m[1]).origin, output: () => out });
      }
    });
  });
}

export async function client(s) {
  const r = await fetch(s.authUrl, { redirect: 'manual' });
  const cookie = r.headers.get('set-cookie').split(';', 1)[0];
  const f = (i, init) => {
    const h = new Headers(init?.headers);
    h.set('cookie', cookie);
    return fetch(i, { ...init, headers: h });
  };
  return createWireClient({ baseUrl: s.url, fetch: f });
}

/** 跑一輪：送 SCRIPT，收到 root 收尾為止，回工具結果與錯誤文字。逾時回 timedOut。 */
export const counters = { finals: 0 };
export const streams = {};
export async function turn(c, thread, steps, { limitMs = 60000, label = '' } = {}) {
  const ev = (streams[thread] ??= await c.openEvents(thread));
  const frames = [];
  const t0 = Date.now();
  const f0 = counters.finals;
  await c.runStart(
    thread,
    `${label} SCRIPT:${Buffer.from(JSON.stringify(steps)).toString('base64')}ENDSCRIPT`,
  );
  const done = (async () => {
    for (;;) {
      const n = await ev.next();
      if (n.done) return 'stream-ended';
      frames.push(n.value);
      const d = n.value.params.data;
      if (
        n.value.method === 'lifecycle' &&
        n.value.params.namespace.length === 0 &&
        d?.graph_name === 'root' &&
        (d.event === 'failed' || (d.event === 'completed' && counters.finals > f0))
      )
        return d.event + (d.aborted ? ':aborted' : '');
    }
  })().catch((e) => `stream-error:${e.message}`);
  const end = await Promise.race([
    done,
    new Promise((r) => setTimeout(() => r('timedOut'), limitMs)),
  ]);
  return { end, ms: Date.now() - t0, frames };
}

export const brief = (frames) =>
  JSON.stringify(
    frames
      .filter((f) => f.method !== 'messages' || /tool/.test(JSON.stringify(f.params.data)))
      .map((f) => f.params.data),
  ).slice(0, 4000);

export const toolResults = (m) =>
  m.calls
    .filter((c) => c.last !== undefined)
    .map((c) => (typeof c.last === 'string' ? c.last : JSON.stringify(c.last)));
export const toolList = (m) => m.calls.find((c) => c.tools.length > 0)?.tools ?? [];

export const mcpPatch = () => `- insert:
    - id: mcp-free
      name: '@nexus/plugin-mcp'
      config:
        serverName: free
        approval: { default: allow }
        connection:
          transport: stdio
          command: /usr/local/bin/node
          args: [/run2189/mcpdir/mcp-fake.mjs]
    - id: mcp-box
      name: '@nexus/plugin-mcp'
      config:
        serverName: box
        approval: { default: allow }
        connection:
          transport: stdio
          command: /usr/local/bin/node
          args: [/run2189/mcpdir/mcp-fake.mjs]
          sandbox:
            readable: [/usr, /etc, /run2189/mcpdir]
            writable: []
`;
export const procs = () => {
  const out = [];
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p) || +p === process.pid) continue;
    try {
      const st = readFileSync(`/proc/${p}/stat`, 'utf8');
      const r = st.slice(st.lastIndexOf(')') + 2).split(' ');
      out.push({
        pid: +p,
        state: r[0],
        ppid: +r[1],
        cmd: readFileSync(`/proc/${p}/cmdline`, 'utf8').replace(/\0/g, ' ').slice(0, 300),
      });
    } catch {}
  }
  return out;
};
