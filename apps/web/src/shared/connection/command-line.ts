import type { SlashDescriptor } from '@nexus/wire';

/**
 * 連線核心認斜線命令那一行用的判斷（[#1929](https://github.com/DemianLi/nexus-agent/issues/1929)、#1971）：
 * 命令的文法照伺服器的 `parseCommand`，走哪一路照 dsh 的 `matchEnter`。
 *
 * @module
 */

/** 退出就是打 `/plan off`，走跟打字送出同一條 `slash.run`。 */
export const PLAN_EXIT_LINE = '/plan off';

/** 只打這一行時開對話框，不送 `slash.run`（照 dsh 的 `/feedback` 裝飾）。 */
export const FEEDBACK_COMMAND_LINE = '/feedback';

/** 跟 `parseCommand` 同一條：名字後面緊接非空白（`/plan.md`）就不是命令。 */
export const COMMAND_TOKEN = /^\/([a-z][a-z0-9_-]*)(?=$|\s)/u;

/** 這一行開頭像不像一個命令（`/名字`，名字照 `parseCommand`）；不管清單上有沒有。不像就回 `undefined`。 */
export function commandToken(line: string): string | undefined {
  return COMMAND_TOKEN.exec(line.trim())?.[1];
}

/**
 * 這一行是命令的話走哪一路（[#1971](https://github.com/DemianLi/nexus-agent/issues/1971)），照 dsh `matchEnter`
 * （`ui-commands/src/client/service.ts:325-365`，`687f282e`）：
 *
 * - `claim`：宣告了 `input` 的命令，後面帶不帶字都算。送出後在途、收下才清（#1941）。
 * - `detached`：沒宣告 `input`、整行只有 `/名字`。當場拿掉、背景執行，不鎖輸入框（dsh `consumeVia`＋`runDetached`）。
 * - `undefined`：不是命令。不在清單上，或沒宣告 `input` 卻帶了字——後者 dsh 整行當一句話送（`if (!bare) return undefined`）。
 */
export function commandArm(
  commands: readonly SlashDescriptor[],
  line: string,
): 'claim' | 'detached' | undefined {
  const name = commandToken(line);
  if (name === undefined) return undefined;
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) return undefined;
  if (command.input !== undefined) return 'claim';
  return line.trim() === `/${name}` ? 'detached' : undefined;
}
