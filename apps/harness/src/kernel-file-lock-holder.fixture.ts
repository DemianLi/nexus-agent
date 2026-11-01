// 握著鎖不放的行程（#2253）：`node --import tsx <這個檔> <spawner> <鎖檔>`。只用 spawner 對 fd 3 拿鎖，印 held 就等著被殺。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open } from 'node:fs/promises';

const binary = process.argv[2]!;
const path = process.argv[3]!;
const handle = await open(path, 'w', 0o600);
const child = spawn(binary, ['--flock'], { stdio: ['ignore', 'ignore', 'inherit', handle.fd] });
const [status] = (await once(child, 'close')) as [number | null];
console.log(status === 0 ? 'held' : `failed ${String(status)}`);
setInterval(() => undefined, 1000);
