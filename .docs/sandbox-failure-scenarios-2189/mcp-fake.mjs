// 假 MCP：newline JSON-RPC。stdin 收尾也不走，模擬壞掉的 server。
import { lookup, promises as dp } from 'node:dns';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const text = (id, t) =>
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: t }] } });
const tools = ['ping', 'dns', 'hang', 'spin'].map((name) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: { host: { type: 'string' } } },
}));
setInterval(() => {}, 1 << 30);
if (process.argv[2] === 'polite') process.stdin.on('end', () => process.exit(0));
else {
  process.stdin.on('end', () => {});
  process.on('SIGTERM', () => {});
}
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize')
      send({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1' },
        },
      });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
    else if (m.method === 'tools/call') {
      const n = m.params.name;
      const host = m.params.arguments?.host;
      if (n === 'ping') text(m.id, `pong ${process.pid}`);
      if (n === 'hang') {
        /* 永不回 */
      }
      if (n === 'spin') {
        for (;;);
      }
      if (n === 'dns') {
        const t0 = Date.now();
        lookup(host, async (e, a) => {
          const l = e ? `lookup ${e.code} ${e.message}` : `lookup ok ${a}`;
          const t1 = Date.now();
          let r;
          try {
            r = `resolve4 ok ${await dp.resolve4(host)}`;
          } catch (x) {
            r = `resolve4 ${x.code} ${x.message}`;
          }
          text(m.id, `${l} (${t1 - t0}ms); ${r} (${Date.now() - t1}ms)`);
        });
      }
    } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
