/**
 * 真的 Node 與 Python stdio MCP server 經真的 spawner 單次模式（#1946）：連得上、呼叫得到工具，讀不到 serve 的 home，連不出網路。
 * `NEXUS_SPAWNER_BIN` 指到執行檔才跑（只有 Linux 建得出來）。CI 上沒有 python3 就紅，本機容器沒有就跳過。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPlugins } from '@nexus/core';
import type { PluginRegistry } from '@nexus/core';
import { createMcpPlugin, MCP_SANDBOX_SERVICE } from '@nexus/plugin-mcp';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { createMcpSandboxWrapper } from './mcp-sandbox.js';

const BINARY = process.env.NEXUS_SPAWNER_BIN;

/** 回一筆 A 紀錄 127.0.0.2 的本機 DNS：`queries` 數收到幾個請求，看解析有沒有真的送出去。 */
async function startFakeDns(): Promise<{ socket: Socket; port: string; queries: () => number }> {
  const socket = createSocket('udp4');
  let queries = 0;
  socket.on('message', (query, peer) => {
    queries += 1;
    const answer = [0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 127, 0, 0, 2];
    const flags = [0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0];
    socket.send(
      Buffer.concat([
        query.subarray(0, 2),
        Buffer.from(flags),
        query.subarray(12),
        Buffer.from(answer),
      ]),
      peer.port,
      peer.address,
    );
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { socket, port: String(socket.address().port), queries: () => queries };
}

const python = ((): string | undefined => {
  try {
    return execFileSync('sh', ['-c', 'command -v python3']).toString().trim();
  } catch {
    return undefined;
  }
})();

/** 手寫的 MCP：一行一筆 JSON-RPC，沒有相依，四支工具 read、connect、env、dns。 */
const NODE_SERVER = `
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const readline = require('node:readline');
const text = (value) => ({ content: [{ type: 'text', text: value }] });
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] };
const tools = ['read', 'connect', 'env', 'dns'].map((name) => ({ name, description: name, inputSchema: schema }));
const call = (name, value) => new Promise((resolve) => {
  if (name === 'dns') {
    const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
    resolver.setServers(['127.0.0.1:' + value]);
    return resolver.resolve4('svc.nexus.test').then(
      (addresses) => resolve(text('resolved:' + addresses[0])),
      (error) => resolve(text('denied:' + error.code)),
    );
  }
  if (name === 'env') return resolve(text(process.env[value] ?? 'unset'));
  if (name === 'read') {
    try { return resolve(text(fs.readFileSync(value, 'utf8'))); }
    catch (error) { return resolve(text('denied:' + error.code)); }
  }
  const socket = net.connect(Number(value), '127.0.0.1');
  socket.on('connect', () => { socket.destroy(); resolve(text('connected')); });
  socket.on('error', (error) => resolve(text('denied:' + error.code)));
});
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
  if (method === 'initialize') {
    send({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'n', version: '1' } });
  } else if (method === 'tools/list') send({ tools });
  else if (method === 'tools/call') send(await call(params.name, params.arguments.value));
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } }) + '\\n');
});
`;

const PYTHON_SERVER = `
import json, os, socket, sys

def text(value):
    return {"content": [{"type": "text", "text": value}]}

def call(name, value):
    if name == "env":
        return text(os.environ.get(value, "unset"))
    try:
        if name == "read":
            with open(value) as f:
                return text(f.read())
        with socket.create_connection(("127.0.0.1", int(value)), 3):
            return text("connected")
    except OSError as error:
        return text("denied:" + str(error.errno))

schema = {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}
tools = [{"name": n, "description": n, "inputSchema": schema} for n in ["read", "connect", "env"]]
for line in sys.stdin:
    message = json.loads(line)
    id_ = message.get("id")
    if id_ is None:
        continue
    method = message.get("method")
    params = message.get("params") or {}
    reply = {"jsonrpc": "2.0", "id": id_}
    if method == "initialize":
        reply["result"] = {"protocolVersion": params["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "p", "version": "1"}}
    elif method == "tools/list":
        reply["result"] = {"tools": tools}
    elif method == "tools/call":
        reply["result"] = call(params["name"], params["arguments"]["value"])
    else:
        reply["error"] = {"code": -32601, "message": "nope"}
    print(json.dumps(reply), flush=True)
`;

const servers = [
  { name: 'node', command: process.execPath, file: 'server.js', source: NODE_SERVER },
  ...(python === undefined && process.env.CI === undefined
    ? []
    : [{ name: 'python', command: python ?? 'python3', file: 'server.py', source: PYTHON_SERVER }]),
];

describe.skipIf(BINARY === undefined).each(servers)(
  '真的 $name stdio server 經單次模式',
  ({ command, file, source }) => {
    let base: string;
    let serve: string;
    let secret: string;
    let code: string;
    let listener: Server;
    let port: string;
    let dispose: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      base = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-mcp-it-')));
      mkdirSync(process.env[HARNESS_HOME_ENV] ?? '', { recursive: true });
      serve = realpathSync(process.env[HARNESS_HOME_ENV] ?? '');
      secret = join(serve, 'secret');
      writeFileSync(secret, 'token\n');
      code = join(base, file);
      writeFileSync(code, source);
      listener = createServer((socket) => socket.destroy());
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
      port = String((listener.address() as AddressInfo).port);
    });

    afterEach(async () => {
      await dispose?.();
      dispose = undefined;
      await new Promise((resolve) => listener.close(resolve));
      rmSync(base, { recursive: true, force: true });
    });

    const connect = async (sandbox: object | undefined) => {
      const wrap = createMcpSandboxWrapper(() => ({
        platform: 'linux',
        binary: BINARY,
        serveHome: serve,
        userHomes: ['/no-such-home'],
      }));
      const loaded = await loadPlugins([
        {
          plugin: {
            name: 'host',
            apply: (host) => void host.services.provide(MCP_SANDBOX_SERVICE, wrap),
          },
        },
        createMcpPlugin({
          serverName: 'srv',
          connection: {
            transport: 'stdio',
            command,
            args: [code],
            env: { FROM_CONFIG: 'kept' },
            ...(sandbox === undefined ? {} : { sandbox }),
          },
          approval: { default: 'allow' },
        }),
      ]);
      dispose = loaded.dispose;
      const { registry }: { registry: PluginRegistry } = loaded;
      return async (tool: string, value: string): Promise<string> => {
        const found = registry.tools.resolve(`mcp__srv__${tool}`)?.value;
        if (found === undefined) throw new Error(`沒有 ${tool}`);
        return JSON.stringify(await found.invoke({ value } as never));
      };
    };

    it('宣告了：連得上、環境照舊，讀不到 serve 的 home、連不出網路', async () => {
      const call = await connect({ readable: [base], writable: [] });
      expect(await call('env', 'FROM_CONFIG')).toContain('kept');
      const data = join(base, 'data.txt');
      writeFileSync(data, 'hello\n');
      expect(await call('read', data)).toContain('hello');
      const read = await call('read', secret);
      expect(read).toContain('denied:');
      expect(read).not.toContain('token');
      expect(await call('connect', port)).toContain('denied:');
    });

    it.runIf(file === 'server.js')('宣告了：名稱解析立刻失敗，請求沒有送出去', async () => {
      const resolver = await startFakeDns();
      try {
        const call = await connect({ readable: [base], writable: [] });
        const started = Date.now();
        expect(await call('dns', resolver.port)).toContain('denied:');
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(resolver.queries()).toBe(0);
      } finally {
        await new Promise<void>((resolve) => resolver.socket.close(() => resolve()));
      }
    });

    it.runIf(file === 'server.js')('沒宣告（正對照）：同一支 server 解析得到', async () => {
      const resolver = await startFakeDns();
      try {
        const call = await connect(undefined);
        expect(await call('dns', resolver.port)).toContain('resolved:127.0.0.2');
        expect(resolver.queries()).toBe(1);
      } finally {
        await new Promise<void>((resolve) => resolver.socket.close(() => resolve()));
      }
    });

    it('沒宣告（正對照）：同一支 server 讀得到、連得出去', async () => {
      const call = await connect(undefined);
      expect(await call('read', secret)).toContain('token');
      expect(await call('connect', port)).toContain('connected');
    });
  },
);
