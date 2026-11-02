// @vitest-environment node
/**
 * `apps/web/eslint.config.js` 擋 `crypto.randomUUID` 的那一條（[#1548](https://github.com/DemianLi/nexus-agent/issues/1548)）。
 *
 * 量的是 web **真的那份**設定（`overrideConfigFile`），違規碼放在記憶體裡、不落成檔（理由同
 * `packages/nexus-sdk/src/lint.test.ts` 檔頭：落地的違規夾具會被 lint、typecheck 與 prettier 掃到）。`filePath` 是虛擬路徑。
 */

import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const WEB = fileURLToPath(new URL('../..', import.meta.url));

const eslint = new ESLint({ cwd: WEB, overrideConfigFile: `${WEB}eslint.config.js` });

async function restricted(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${WEB}${file}` });
  const messages = result?.messages ?? [];
  expect(messages.filter((m) => m.fatal === true).map((m) => m.message)).toEqual([]);
  return messages.filter((m) => m.ruleId === 'no-restricted-properties').map((m) => m.message);
}

describe('lint 擋 crypto.randomUUID（#1548）', () => {
  it('原始碼呼叫 crypto.randomUUID()：一則錯，訊息指到 @/lib/uuid', async () => {
    const messages = await restricted('export const id = crypto.randomUUID();\n', 'src/probe.ts');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('@/lib/uuid');
  });

  it('測試檔也擋：模擬非安全環境的測試同樣該走共用的那一支', async () => {
    const messages = await restricted(
      'export const id = crypto.randomUUID();\n',
      'src/probe.test.tsx',
    );
    expect(messages).toHaveLength(1);
  });

  it('走 randomUuid()：零則', async () => {
    const code = "import { randomUuid } from '@/lib/uuid';\n\nexport const id = randomUuid();\n";
    expect(await restricted(code, 'src/probe.ts')).toEqual([]);
  });
});
