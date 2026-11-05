/**
 * 代理 socket 的測試輔助：只給本套件的測試用。
 *
 * @module
 */

import { spawn } from 'node:child_process';

/** 起一個子行程聽 `path`，再 `SIGKILL` 它：留下一個沒有人在聽的 socket 檔。同一個行程裡 `close()` 會把檔刪掉，留不下來。 */
export async function staleSocketAt(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready"))',
      path,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}
