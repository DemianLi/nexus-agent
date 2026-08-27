import { describe, expect, it } from 'vitest';
import { createAgentClient } from './agent.js';

/**
 * 瀏覽器這一端只驗兩件事：**解析得到**（`@nexus/wire` 在 Vite／DOM 那份 tsconfig 下
 * 編得過、載得進來），以及**預設同源**（沒設 `VITE_AGENT_BASE_URL` 時走相對路徑，
 * 不會硬編一個 localhost）。協定本身的行為在 `@nexus/wire` 自己的測試裡。
 */
describe('agent client', () => {
  it('預設走相對路徑，路徑就是協定規定的那條', async () => {
    const seen: string[] = [];
    const client = createAgentClient({
      fetch: async (input) => {
        seen.push(String(input));
        return Response.json({ type: 'success', id: 1, result: {} });
      },
    });
    await client.runStart('t1', '哈囉');
    expect(seen).toEqual(['/threads/t1/commands/run.start']);
  });

  it('指定來源時接在前面', async () => {
    const seen: string[] = [];
    const client = createAgentClient({
      baseUrl: 'http://localhost:8787/',
      fetch: async (input) => {
        seen.push(String(input));
        return Response.json({ type: 'success', id: 1, result: {} });
      },
    });
    await client.runStart('t1', '哈囉');
    expect(seen).toEqual(['http://localhost:8787/threads/t1/commands/run.start']);
  });
});
