/**
 * `@nexus/plugin-skills/invocation`——人寫 `/名字` 叫用技能（[#1574](https://github.com/DemianLi/nexus-agent/issues/1574) 刀 2）。
 *
 * 照 dsh `tool-skill` 的 `agent/pre-step` listener（`packages/skill/tool-skill/src/index.ts:165-206`，`687f282e`）：人的話裡有
 * `/名字`、而那份技能人叫得到，就把渲染好的 `<skill_content>` 當成一則使用者訊息交給這一步，來源是
 * `{ kind: 'skill-invocation', name, form: 'instructions' }`。只給人叫的技能（`disable-model-invocation: true`）只有這一個入口——
 * 模型的清單看不到它（刀 1，`@nexus/core` 的 `skills-middleware.ts`）。
 *
 * ## 為什麼是同一個套件的另一列
 *
 * dsh 的 `/name` 由**一顆** `tool-skill` 負責，技能的提供者（`skill-filesystem`）可以有很多顆。`@nexus/plugin-skills` 的主入口是提供者那一半：
 * 每一列登記自己的來源，清單上可以有好幾列（`apps/harness/src/skills-on-tree.test.ts` 的 F、G）。叫用是「整個行程一份」，所以單獨一列，
 * 不管有幾列 skills 都只有一位 listener，位置也由這一列決定（PM 裁決 issuecomment-6359103754 (a)；Q3 (a) 的「listener 在 plugin-skills」照舊）。
 *
 * - **手勢**：同 dsh 的 `SKILL_GESTURE`（`:411`）：前後是空白或行首行尾，所以 `/usr/bin`、`5/8`、`/deploy/x` 都不算；依第一次出現的
 *   順序去重（`:420-432`）。只看 text 區塊。
 * - **只認人話**：dsh 只掃 `kind === 'user'`（`:420-423`），它每個生產者都帶來源。nexus 圖上那句人話沒有來源（「缺席就是人」），所以
 *   改成排除機器造的（`@nexus/core` 的 `isHumanSpeech`）：有非 `user` 來源的（續行輪、引用別的會話的快照、外掛注入、技能叫用本身），
 *   以及兩種沒有來源的機器訊息——**重複提醒**（詳細那一版帶著模型寫的工具參數）與**基座的摘要訊息**（模型寫的）。模型寫的字因此
 *   造不出手勢。**沒有排除到的**：今天以後新增、卻沒帶來源也沒帶上面兩種記號的機器訊息會被當成人話——新的生產者要帶來源（#662）。
 * - **叫不出來就是一般文字**：名字找不到、或 `user-invocable: false`，不注入、不報錯（`:195-197`）。
 * - **掃描不完整就一份都不注入**：dsh 的檔案提供者讀 `SKILL.md` 遇到「不存在」以外的錯誤會拋（`skill-filesystem/src/index.ts:865`、
 *   `:879`、`:888`），註冊表跳過整個提供者（`skill/src/index.ts:602-609`），那個提供者底下的技能這一步全叫不出來。nexus 的所有來源是
 *   **一次**掃描，等於一個提供者，所以照同一個語意：不完整就不注入、記一行 warn。不算偏離（PM 裁決 issuecomment-6358917124 第 1 題）。
 * - **落點**：dsh 的叫用排在其他注入之後、time-context 的讀數之前（time-context 以 `prepend` 登記，是 waterfall 的最外層，最後才 append，
 *   `time-context/src/index.ts:225`）。我們的落點由出貨清單的列序決定，所以 `cordis.yml` 上這一列排在 `agent-instructions` 與
 *   `time-context` 之間：同一次 invoke 裡人話、AGENTS.md 基線、技能說明、讀數。
 * - **掃哪裡**：這次呼叫那條 thread 的 backend 與技能來源，都從同一格 fs 把手讀（`fs.forCall(invocation)`）：backend 就是組裝交給 skills
 *   中介層的那一個，來源是 `fs.skillSources()`，也就是 fold 折進這條 thread、模型清單用的那一份
 *   （有共用區的 thread 已換到共用區底下，#1928；[#1919](https://github.com/DemianLi/nexus-agent/issues/1919)）。`skill.list` 讀的也是這一份。
 *
 * ## 偏離登記
 *
 * 1. **只在 root 認**（理由 2：產品需求超出 dsh 的射程；Q1 (a)，issuecomment-6235541455）。dsh 的 listener 子代理也跑，子代理第一則是
 *    `source: { kind: 'user' }`（`packages/subagent/subagent/src/manager.ts:464`）。nexus 子代理的第一句是父模型寫的 `task` 描述，日誌記成
 *    `user`、圖上那則沒有來源，沒有來源就算人：照抄的話父模型在 `task` 描述裡寫 `/deploy`，就叫得出只給人叫的技能。`session-log.ts` 也寫明
 *    「讀 `user` 當有人在場的人，要先確定讀的是 root」。位址取自 `fs.forCall` 交回的 `address`。
 * 2. **每次 invoke 看一次「最後一則模型回覆之後」的人話**（理由 1，繼承 `@nexus/agent-loop` 偏離 2、3）。dsh 每一步掃這一步從收件匣領出來的
 *    批次；我們沒有收件匣，listener 每次 invoke 跑一次、拿到的是模型看得到的整串，所以「這一批」退成「最後一則 `AIMessage` 之後的人話」。
 *    **留下的缺口**：一輪跑著時插的話（`source.kind === 'user'`）裡的 `/名字` 叫不出來——插話進圖時這次 invoke 的 pre-step 已經跑過，
 *    下一次 invoke 它前面已經有模型回覆。**重開條件**同 `@nexus/agent-loop` 偏離 2（#389 重開，每一步注入）。
 * 3. **防重複的判準放在訊息上**（同理由 1）：dsh 的收件匣領走就不會再領；我們每次 invoke 都重看那一段，所以注入的訊息帶
 *    `nexus_skill_invocation: { name }`，這一段已有同名的注入就不再注入（上一輪中途停掉、沒有模型回覆時會走到）。看的是段落、不是
 *    哪一句人話：一輪開頭那句人話的 id 是 reducer 補的，日誌不記，續接重放回來就換了一個
 *    （[#1920](https://github.com/DemianLi/nexus-agent/issues/1920)）。所以同一段裡人再打一次 `/名字` 也不再注入——那份正文模型在這一段看得到。
 *
 * ## 代價
 *
 * 宿主為每位 listener 建一顆 `beforeAgent` middleware，每次 invoke（root 與每個子代理）多走一格節點；話裡沒有手勢就不掃 backend。
 * 2026-10-23 用 `LoopingChatModel` 實測（`apps/harness/src/time-context-on-tree.test.ts` J 組）：每輪三格時
 * `輪數 = floor((上限 - 2 - k) / 3)`，k 是 pre-step 的 `beforeAgent` 顆數。出貨清單加上這一列後 k = 3，**預設上限 100 從 32 輪變 31 輪**；
 * serve 的形狀（每輪四格）從 24 變 23。dsh 的 pre-step 是一個事件依序跑完，不按 listener 計格——這一格是 LangGraph 基座的代價
 * （同 `@nexus/agent-loop` 偏離 2），併成一顆節點的討論在 [#1917](https://github.com/DemianLi/nexus-agent/issues/1917)。
 *
 * @module
 */

import { agentLoopToken } from '@nexus/agent-loop';
import type { PreStepInjection, PreStepInvocation, PreStepListener } from '@nexus/agent-loop';
import type { Context } from '@nexus/cordis';
import { fsToken } from '@nexus/fs';
import type { FsLookup } from '@nexus/fs';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { isHumanSpeech, renderSkillInvocation, scanSkills } from '@nexus/skills';
import { z } from 'zod';

/** 插件在樹上的列用的名字。 */
export const name = 'skill-invocation';

/**
 * 要的服務：`agentLoop`（`^1.2.0`，登記 listener；注入要帶自己的 `source`，1.1.0 的宿主會靜靜記成 `plugin`，所以擋在範圍上）、
 * `fs`（`^2.2.0`，呼叫當下拿這條 thread 的 backend、位址與技能來源；來源是 2.2.0 加的 `skillSources`，#1919）。範圍在這裡宣告，經
 * `Service.resolveIntercept` 合併，提供者的 `check` 讀得到。
 */
export const inject = injectOf(need(agentLoopToken, '^1.2.0'), need(fsToken, '^2.2.0'));

/** 沒有設定：來源由 `skills` 列登記。`strictObject`：未知欄位讓載入失敗。 */
export const Config = z.strictObject({});

export const manifest = defineManifest({
  id: 'skill-invocation',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [],
  consumes: [
    { token: agentLoopToken.name, range: '^1.2.0' },
    { token: fsToken.name, range: '^2.2.0' },
  ],
  config: Config,
  // 換程式碼要重啟行程；掛不掛只影響新的 thread（#1405、決議 §3-2 第 6 條：組 thread 時取快照）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * 掛上：登記一位 `preStep` listener。兩個服務都在這裡抓進閉包（列卸載之後經 `ctx` 取服務會拋，抓住的那份仍可呼叫），**呼叫當下才**
 * `fs.forCall`。
 *
 * @param ctx - 這一列的 Cordis context。
 */
export function apply(ctx: Context): void {
  const agentLoop = service(ctx, agentLoopToken);
  const fs = service(ctx, fsToken);
  agentLoop.preStep(
    SKILL_INVOCATION_LISTENER_NAME,
    createSkillInvocationListener({ fs: (invocation) => fs.forCall(invocation) }),
  );
}

/** `/名字` 叫用那位 listener 的名字：宿主拿它當 middleware 名。 */
export const SKILL_INVOCATION_LISTENER_NAME = 'SkillInvocationMiddleware';

/** 注入的訊息帶的記號：`{ name }`，認出「這一段已經注入過這個名字」（檔頭偏離 3）。 */
export const SKILL_INVOCATION_MARKER = 'nexus_skill_invocation';

/**
 * `/名字` 手勢，逐字照 dsh `SKILL_GESTURE`（`tool-skill/src/index.ts:411`）：前後要是空白或行首行尾，名字是技能名的文法
 * （小寫英數，以 `-` 連接）。
 */
export const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

/** listener 收到的一則訊息（`@langchain/core` 的 `BaseMessage`，經接縫的型別取得，這個套件不另外相依它）。 */
type BaseMessage = Parameters<PreStepListener>[0][number];

/** 記號上的名字；沒有記號、或記號裡的 `name` 不是字串，都是 `undefined`。 */
function markedName(message: BaseMessage): string | undefined {
  const raw: unknown = message.additional_kwargs?.[SKILL_INVOCATION_MARKER];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name } = raw as { name?: unknown };
  return typeof name === 'string' ? name : undefined;
}

function textBlocks(message: BaseMessage): string[] {
  const { content } = message;
  if (typeof content === 'string') return [content];
  return content.flatMap((block) =>
    block.type === 'text' && typeof (block as { text?: unknown }).text === 'string'
      ? [(block as { text: string }).text]
      : [],
  );
}

/**
 * 這一次要叫用的名字，依第一次出現的順序去重。只看最後一則模型回覆之後的人話（檔頭偏離 2）；這一段已經有同名注入的跳過（偏離 3）。
 */
function requestedNames(visible: readonly BaseMessage[]): string[] {
  const after = visible.slice(visible.findLastIndex((message) => message.type === 'ai') + 1);
  const seen = new Set(after.map(markedName).filter((name) => name !== undefined));
  const requested: string[] = [];
  for (const message of after) {
    if (!isHumanSpeech(message)) continue;
    for (const text of textBlocks(message)) {
      for (const match of text.matchAll(SKILL_GESTURE)) {
        const name = match[2]!;
        if (seen.has(name)) continue;
        seen.add(name);
        requested.push(name);
      }
    }
  }
  return requested;
}

/** {@link createSkillInvocationListener} 要的查找。測試換成替身；`apply` 換成從服務抓進閉包的那一份。 */
export interface SkillInvocationLookups {
  /** 這次呼叫那條 thread 的 fs 把手與位址（`fs.forCall`）；把手帶著這條 thread 的 backend 與技能來源。 */
  fs(invocation: PreStepInvocation): FsLookup;
}

/**
 * 建 `/名字` 叫用的 listener，見檔頭。
 *
 * @param lookups - 查找，見 {@link SkillInvocationLookups}。
 * @returns 登記給 `agentLoop.preStep` 的 listener。
 */
export function createSkillInvocationListener(lookups: SkillInvocationLookups): PreStepListener {
  return async (visible, invocation): Promise<readonly PreStepInjection[] | undefined> => {
    const found = lookups.fs(invocation);
    // 只在 root 認（偏離 1）。
    if (found.kind !== 'ok' || found.address.kind !== 'root') return undefined;
    const requested = requestedNames(visible);
    if (requested.length === 0) return undefined;
    const backend = found.fs.backend();
    if (backend === undefined) return undefined;
    invocation.signal?.throwIfAborted();
    const scan = await scanSkills(backend, found.fs.skillSources());
    invocation.signal?.throwIfAborted();
    if (!scan.complete) {
      // 照 dsh 的提供者語意：掃描不完整，這一步一份都叫不出來（檔頭）。
      console.warn(
        `技能叫用這一次不注入：掃描不完整（${requested.map((name) => `/${name}`).join('、')}）`,
      );
      return undefined;
    }
    const injections: PreStepInjection[] = [];
    for (const name of requested) {
      const skill = scan.skills.find((entry) => entry.name === name);
      if (skill === undefined || !skill.invocation.userInvocable) continue;
      injections.push({
        content: renderSkillInvocation(skill),
        additionalKwargs: { [SKILL_INVOCATION_MARKER]: { name } },
        source: { kind: 'skill-invocation', name, form: 'instructions' },
      });
    }
    return injections;
  };
}
