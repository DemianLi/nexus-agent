/**
 * 產品用哪一支 {@link ToolLauncher}（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）：Linux 一律經 spawner，
 * 非 Linux 沒有沙箱後端，只有 `danger-full-access` 直接 spawn，其餘回 `sandbox-unavailable`。
 *
 * 這裡沒有關掉沙箱的開關。測試設施在 `test-home.setup.ts` 換掉 {@link productToolLauncher}。
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPAWNER_PATH } from './sandbox-protocol.js';
import { SpawnerSupervisor } from './sandbox-spawner-client.js';
import { directToolLauncher } from './tool-process.js';
import type { ToolLauncher } from './tool-process.js';

/** spawner 的 `landlock::WANTED_ABI`。 */
const WANTED_LANDLOCK_ABI = 6;

let report: (line: string) => void = (line) => console.error(line);

/** 沙箱的診斷往哪裡講。serve 接到伺服器日誌；沒接就是 stderr。 */
export function reportSandboxTo(log: (line: string) => void): void {
  report = log;
}

/** 講一句沙箱的診斷，去處同 {@link reportSandboxTo}。 */
export function reportSandbox(line: string): void {
  report(line);
}

/** 從這個模組往上找產物裡的 spawner；找不到回 `undefined`。 */
export function findSpawnerBinary(from = fileURLToPath(import.meta.url)): string | undefined {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = join(dir, SPAWNER_PATH);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** 依平台選。`binary` 找不到時每次都回 `sandbox-unavailable`，不退回直接 spawn。 */
export function selectToolLauncher(
  platform: NodeJS.Platform,
  binary: string | undefined,
  direct: ToolLauncher = directToolLauncher,
): ToolLauncher {
  if (platform !== 'linux') {
    return (request) =>
      request.mode === 'danger-full-access'
        ? direct(request)
        : Promise.resolve('sandbox-unavailable');
  }
  if (binary === undefined) return () => Promise.resolve('sandbox-unavailable');
  spawner = new SpawnerSupervisor({ binary, log: (line) => report(line) });
  return spawner.launch;
}

let spawner: SpawnerSupervisor | undefined;
let product: ToolLauncher | undefined;

/** 這個行程共用的那一支：一個行程一個 spawner，不是一條 thread 一個。 */
export function productToolLauncher(): ToolLauncher {
  product ??= selectToolLauncher(process.platform, findSpawnerBinary());
  return product;
}

/** serve 起動時講的那一行：`landlockAbi` 是 spawner 回報的，起不來是 `undefined`。 */
export function formatSandboxStatus(
  platform: NodeJS.Platform,
  binary: string | undefined,
  landlockAbi: number | undefined,
): string {
  if (platform !== 'linux') return '沙箱：這個平台沒有沙箱後端，只有 danger-full-access 跑得了工具';
  if (binary === undefined) return '沙箱：找不到 spawner，工具一律跑不了';
  if (landlockAbi === undefined) return '沙箱：spawner 起不來，工具一律跑不了，原因見上一行';
  if (landlockAbi < WANTED_LANDLOCK_ABI) {
    return `沙箱：Landlock ABI ${String(landlockAbi)}，只有部分強制（完整強制要 ABI ${String(WANTED_LANDLOCK_ABI)}）`;
  }
  return `沙箱：Landlock ABI ${String(landlockAbi)}，完整強制`;
}

/** 起 spawner，回這台主機的狀態行。 */
export async function productSandboxStatus(): Promise<string> {
  productToolLauncher();
  const binary = process.platform === 'linux' ? findSpawnerBinary() : undefined;
  return formatSandboxStatus(process.platform, binary, await spawner?.landlockAbi());
}
