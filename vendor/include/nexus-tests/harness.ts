// 我們自己的回歸測試，不是上游的：vendor/sync.mjs 不碰這個目錄。
//
// 一棵最小的樹：Loader ＋ 一個「登記處」服務 ＋ Include。登記處把每次 `add` 記進 `registry`，經 `ctx.effect` 登記，
// 所以那一列卸載時登記處跟著收。測試讀 `registry` 看「樹上的列對外有什麼貢獻」。
import { Context, Service } from '@nexus/cordis'
import type { Fiber } from '@nexus/cordis'
import Loader from '@nexus/cordis-plugin-loader'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import Include from '../src/index.ts'
import type { PatchOptions } from '../src/patch.ts'

export interface Tree {
  readonly root: Context
  readonly dir: string
  readonly file: string
  /** 登記處現在的內容，依登記順序。 */
  readonly registry: string[]
  /** 已經 apply 過幾次（含被卸載的），依列 id 計。 */
  readonly applied: Record<string, number>
  readonly logs: string[]
  include(): ReturnType<Loader['resolve']>
  fiber(id: string): Fiber | undefined
  includeConfig(patches: PatchOptions[], only?: string[]): Record<string, unknown>
  dispose(): Promise<void>
}

export interface TreeOptions {
  readonly rows: Record<string, unknown>[]
  readonly patches?: PatchOptions[]
  readonly only?: string[]
  readonly initial?: Record<string, unknown>[]
  /** 不建檔（驗缺檔那條路）。 */
  readonly noFile?: boolean
  /** 直接給檔案原文（要寫 YAML 標籤這類 `stringifyYaml` 寫不出來的形狀）；有給就不用 `rows` 產生。 */
  readonly source?: string
  /** 額外的內建插件。 */
  readonly builtins?: Record<string, unknown>
}

export async function bootTree(options: TreeOptions): Promise<Tree> {
  const dir = mkdtempSync(join(tmpdir(), 'include-nexus-'))
  const file = join(dir, 'cordis.yml')
  if (options.noFile !== true) writeFileSync(file, options.source ?? stringifyYaml(options.rows))
  const registry: string[] = []
  const applied: Record<string, number> = {}
  const logs: string[] = []
  const root = new Context()
  root.logger.exporter({
    export: (message) => void logs.push(`${message.type}: ${message.args.map((arg) => String(arg)).join(' ')}`),
  })
  await root.plugin(Loader, { baseUrl: pathToFileURL(`${dir}/`).href })

  class Reg extends Service {
    constructor(ctx: Context) {
      super(ctx, 'reg')
    }
    add(value: string) {
      return this.ctx.effect(() => {
        registry.push(value)
        return () => {
          const index = registry.indexOf(value)
          if (index >= 0) registry.splice(index, 1)
        }
      }, 'reg.add()')
    }
  }
  /** 名單外的列要換成「真的掛得起來」的插件：不然沒有過濾它也掛不上，過濾那一步就沒被測到。 */
  const legacy = {
    name: 'legacy',
    inject: ['reg'],
    apply(ctx: Context) {
      const id = (ctx.fiber.entry?.id ?? '?').replace(/^include:/, '')
      applied[id] = (applied[id] ?? 0) + 1
      ;(ctx as unknown as { reg: Reg }).reg.add(`${id}!legacy`)
    },
  }
  const consumer = {
    name: 'consumer',
    inject: ['reg'],
    apply(ctx: Context, config: { v?: string }) {
      // Include 底下的列 id 帶 `include:` 前綴（上游的命名空間規則）；測試用不帶前綴的。
      const id = (ctx.fiber.entry?.id ?? '?').replace(/^include:/, '')
      applied[id] = (applied[id] ?? 0) + 1
      ;(ctx as unknown as { reg: Reg }).reg.add(`${id}=${config?.v ?? ''}`)
    },
  }
  Object.assign(root.loader.builtins, { reg: Reg, consumer, legacy, include: Include, ...options.builtins })
  const config = {
    path: file,
    ...(options.patches === undefined ? {} : { patches: structuredClone(options.patches) }),
    ...(options.only === undefined ? {} : { only: options.only }),
    ...(options.initial === undefined ? {} : { initial: options.initial }),
  }
  await root.loader.create({ id: 'reg', name: 'cordis:reg' } as never)
  await root.loader.create({ id: 'include', name: 'cordis:include', config } as never)
  await root.loader.await()
  const tree: Tree = {
    root,
    dir,
    file,
    registry,
    applied,
    logs,
    include: () => root.loader.resolve('include'),
    fiber: (id) => {
      try {
        return root.loader.resolve(`include:${id}`).fiber?.ctx.fiber
      } catch {
        return undefined
      }
    },
    includeConfig: (patches, only) => ({
      ...config,
      patches: structuredClone(patches),
      ...(only === undefined ? {} : { only }),
    }),
    async dispose() {
      await root.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return tree
}

export function readRows(file: string): unknown {
  return parseYaml(readFileSync(file, 'utf8'))
}

export function filesIn(dir: string): string[] {
  return readdirSync(dir).sort()
}
