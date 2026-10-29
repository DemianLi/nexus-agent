// #1946 A 的量具用 Node client（不進 repo）：協定見 native/sandbox-spawner/src/protocol.rs。
import { spawn } from 'node:child_process';
import net from 'node:net';

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const bytes = (b) => Buffer.concat([u32(b.length), b]);
const list = (xs) => Buffer.concat([u32(xs.length), ...xs.map((x) => bytes(Buffer.from(x)))]);
const frame = (p) => Buffer.concat([u32(p.length), p]);

export class Spawner {
  constructor(bin, sock) {
    this.sock = sock;
    this.next = 1;
    this.wait = new Map();
    this.stderr = '';
    this.buf = Buffer.alloc(0);
    this.proc = spawn(bin, ['--listen', sock], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (d) => {
      this.stderr += d;
    });
    this.ready = new Promise((res, rej) => {
      this.onReady = res;
      this.proc.on('exit', (c, s) => rej(new Error(`spawner exited ${c} ${s}: ${this.stderr}`)));
    });
    this.proc.stdout.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
  }
  drain() {
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const p = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      const t = String.fromCharCode(p[0]);
      if (t === 'R') {
        this.info = { insns: p.readUInt32LE(1), abi: p.readUInt32LE(5) };
        this.onReady();
        continue;
      }
      if (t === 'U') throw new Error('unavailable');
      const id = p.readUInt32LE(1);
      const w = this.wait.get(id);
      if (!w) continue;
      if (t === 'S') {
        w.started = true;
        w.partial = p[9] === 1;
      } else if (t === 'F') {
        w.fail = { kind: p[5], errno: p.readInt32LE(6) };
        w.exited = true;
        w.code = 125;
        w.ends = 3;
        w.check();
      } else if (t === 'E') {
        w.code = p.readInt32LE(5);
        w.sig = p.readInt32LE(9);
        w.exited = true;
        w.check();
      }
    }
  }
  run(argv, input, { ws, readable, writable = [ws], env = ['PATH=/usr/bin:/bin'] }) {
    const id = this.next++;
    return new Promise((res) => {
      const w = { out: [], err: [], ends: 0, exited: false };
      w.check = () => {
        if (!w.exited || w.ends < 3) return;
        this.wait.delete(id);
        res({
          code: w.code,
          sig: w.sig,
          started: !!w.started,
          partial: w.partial,
          fail: w.fail,
          out: Buffer.concat(w.out),
          err: Buffer.concat(w.err),
        });
      };
      this.wait.set(id, w);
      const req = Buffer.concat([
        Buffer.from('S'),
        u32(id),
        Buffer.from([1, 0b111]),
        bytes(Buffer.from(ws)),
        list(readable),
        list(writable),
        list(argv),
        list(env),
      ]);
      this.proc.stdin.write(frame(req));
      const hdr = (fd) => Buffer.concat([u32(id), u32(fd)]);
      for (const fd of [0, 1, 2]) {
        const c = net.connect(this.sock);
        c.on('error', () => {});
        if (fd === 0) {
          c.end(input ? Buffer.concat([hdr(0), input]) : hdr(0));
          c.resume();
          c.on('close', () => {
            w.ends++;
            w.check();
          });
        } else {
          c.write(hdr(fd));
          c.on('data', (d) => (fd === 1 ? w.out : w.err).push(d));
          c.on('end', () => {
            w.ends++;
            w.check();
          });
        }
      }
    });
  }
  close() {
    this.proc.stdin.end();
  }
}
