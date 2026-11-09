/**
 * 宿主這一側的 `tools.threadSource`（#2533）：組一條 thread 時，照樹上那一列登記的順序叫它的每個來源，交給它這條 thread 的
 * {@link ToolThread}。宿主（harness 的 `plugin-config.ts`）與插件自己的測試用的是這同一份。
 *
 * 這裡只有橋接本身。哪些宿主服務授權給哪顆插件是宿主的政策，在宿主（harness 的 `thread-service-grants.ts`），
 * 傳進來的 `services` 是宿主已經授權過的。
 *
 * 在呼叫端那一列（`NexusPlugin`）的 `apply` 裡被 await，所以來源 reject 走的是那一列 `apply` 拋錯的同一條路：預設模式整次組裝失敗、`perEntry`
 * 模式那一列掉了，訊息帶的是那一列的 origin。差別只有一處：這一列每個來源已登記的 `onDispose`（含先前已 resolve 的）會先照反序跑完，
 * 再原樣拋出原本的錯誤。
 *
 * @module
 */

import type { StructuredTool } from '@langchain/core/tools';
import { admittedTools, createToolListStepMiddleware, WORKSPACE_CAPABILITY } from '@nexus/core';
import type { Disposer, Events, NexusPlugin, RegisterOptions } from '@nexus/core';
import { langChainToolOf } from './index.js';
import type {
  ToolExecuteListener,
  ToolExecuteOutcome,
  ToolPreStepListener,
  ToolThread,
  ToolThreadSource,
} from '@nexus/tools';

type Registry = Parameters<NexusPlugin<unknown>['apply']>[0];

/** 折進一條 thread 的一個來源：來源本身，與它宣告、宿主授權過的服務名。 */
export interface FoldedThreadSource {
  readonly threadSource: ToolThreadSource;
  readonly services: readonly string[];
}

/** 叫來源的那一列。 */
export interface ThreadSourceOwner {
  /** 呼叫端給的列名：錯誤訊息與 `admit` 的預設名字用它；宿主給的是解析後的 origin id。 */
  readonly id: string;
  /** 那一列的模組命名空間：`shared` 以它為鍵，同一顆插件的各列拿到同一份。 */
  readonly module: object;
}

/** 外層鍵是這條 thread 的 registry（一次組裝一份、各列共用），內層鍵是模組命名空間。 */
const sharedByThread = new WeakMap<object, WeakMap<object, object>>();

function sharedOf(registry: Registry, module: object): object {
  let byModule = sharedByThread.get(registry);
  if (byModule === undefined) {
    byModule = new WeakMap();
    sharedByThread.set(registry, byModule);
  }
  let shared = byModule.get(module);
  if (shared === undefined) {
    shared = {};
    byModule.set(module, shared);
  }
  return shared;
}

/**
 * 依序叫這一列的每個來源。全部 resolve 之後，它們登記的 `onDispose` 才照登記順序交給 `registry.lifecycle`，這條 thread 收掉時反序跑；
 * 交得早的話，後面的來源 reject 時那一列的 rollback 會把它們撤掉，資源就沒人收。
 *
 * @param registry - 這條 thread 的 registry。
 * @param sources - 這一列登記的來源，照登記順序。
 * @param owner - 這一列。
 * @throws 來源拋的錯，原樣。
 */
export async function runThreadSources(
  registry: Registry,
  sources: readonly FoldedThreadSource[],
  owner: ThreadSourceOwner,
): Promise<void> {
  let admissions = 0;
  const disposers: Disposer[] = [];
  for (const { threadSource, services } of sources) {
    let open = true;
    const live = (method: string): void => {
      if (!open) {
        throw new Error(`${owner.id} 的 threadSource 已經 resolve，不能再呼叫 thread.${method}()`);
      }
    };
    const thread: ToolThread = {
      services: {
        get(name) {
          if (!services.includes(name)) {
            throw new Error(
              `${owner.id} 沒有在 tools.threadSource() 宣告要讀宿主服務 ${name}，thread.services.get() 不給`,
            );
          }
          return registry.services.get(name);
        },
      },
      register(tool, options) {
        live('register');
        return registry.tools.register(
          langChainToolOf(tool) as StructuredTool,
          options as RegisterOptions | undefined,
        );
      },
      gate(listener) {
        live('gate');
        return registry.approvals.gate(listener);
      },
      admit(admission, options) {
        live('admit');
        admissions += 1;
        const name = options?.name ?? `${owner.id}:admit:${String(admissions)}`;
        return registry.middleware.use(
          createToolListStepMiddleware(name, (request) => {
            const admitted = admittedTools(request.tools, admission);
            return admitted.length === request.tools.length ? undefined : admitted;
          }),
        );
      },
      section(section) {
        live('section');
        const { text } = section;
        // 相容層的段 context 是 `ToolThreadSectionContext` 的超集，原樣轉交也編得過，插件會在執行期讀到 `agent` 與 `tools`；
        // 這裡收窄成契約上的 `call`（`thread-source.test.ts` 釘住）。
        return registry.prompt.section(
          typeof text === 'function'
            ? { ...section, text: (context) => text({ call: context.call }) }
            : section,
        );
      },
      on(event: 'tools/execute' | 'agent/pre-step', listener: unknown) {
        live('on');
        if (event === 'agent/pre-step') {
          const preStep = listener as ToolPreStepListener;
          // 這一步定了才叫插件：內側的決定是 `reject`、或這一步已經中止，就不叫，插件看到的都是會走下去的步。回傳值不往外交：
          // 插件改不了這一步、也擋不下這一輪，`reject` 只開放給宿主自己的監聽者。拋錯照樣往外拋，同 `tools/execute`。
          const bridged: Events['agent/pre-step'] = async (payload, next) => {
            const decision = await next();
            if (decision.kind === 'reject' || payload.signal.aborted) return decision;
            await preStep({
              threadId: payload.threadId,
              step: payload.step,
              signal: payload.signal,
            });
            return decision;
          };
          return registry.events.on('agent/pre-step', bridged);
        }
        if (event !== 'tools/execute')
          throw new TypeError(
            `thread.on() 只收 'tools/execute' 與 'agent/pre-step'，收到 ${String(event)}`,
          );
        const execute = listener as ToolExecuteListener;
        // `ToolExecuteOutcome` 只是型別上的不透明殼，執行期就是管線的結果，原樣往內交、原樣往外交。
        const bridged: Events['tools/execute'] = (exec, next) =>
          execute(
            exec,
            next as unknown as () => Promise<ToolExecuteOutcome>,
          ) as unknown as ReturnType<Events['tools/execute']>;
        return registry.events.on('tools/execute', bridged);
      },
      join(participant) {
        live('join');
        return registry.sessions.join(participant);
      },
      provide(capability) {
        live('provide');
        if (capability !== WORKSPACE_CAPABILITY) {
          throw new TypeError(
            `thread.provide() 只收 '${WORKSPACE_CAPABILITY}'，收到 ${String(capability)}`,
          );
        }
        return registry.capabilities.provide(capability);
      },
      onDispose(dispose) {
        live('onDispose');
        disposers.push(dispose);
      },
      logger: registry.logger.bind(),
      shared: sharedOf(registry, owner.module),
    };
    try {
      await threadSource(thread);
    } catch (error) {
      open = false;
      // 收自己的資源失敗不能蓋掉原本的錯誤：那個才是使用者要修的。
      for (const dispose of disposers.reverse())
        await Promise.resolve()
          .then(dispose)
          .catch(() => {});
      throw error;
    }
    open = false;
  }
  for (const dispose of disposers) registry.lifecycle.onDispose(dispose);
}
