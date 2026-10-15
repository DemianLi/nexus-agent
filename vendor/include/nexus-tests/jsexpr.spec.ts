// 我們自己的回歸測試，不是上游的。
//
// 本地修改第 11 條：疊完 patch 的那份樹交給 Loader 之前掃一遍，帶 `__jsExpr` 的整份拒絕（#1461）。
// rc.11 起（上游 #179）Loader 連 `disabled` 都會 eval；樹是 Include 讀檔、疊 patch 之後才交給 Loader 的，所以檢查放在
// 那一份資料上。量法：表達式帶副作用計數，`hits` 必須是 0（光看「被拒」分不出「拒了但先 eval 了」）。
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { evaluate } from '@nexus/cordis-plugin-loader'
import type { Include } from '../src/index.ts'
import { bootTree } from './harness.ts'
import type { Tree } from './harness.ts'

const COUNTER = '__nexusJsExprHits'
/** 被 eval 一次就加一，回傳真值（所以放在 `disabled` 會把那一列停用）。 */
const EXPR = `(globalThis.${COUNTER} = (globalThis.${COUNTER} ?? 0) + 1, true)`

const hits = (): number => ((globalThis as Record<string, unknown>)[COUNTER] as number | undefined) ?? 0

const rows = [
  { id: 'a', name: 'cordis:consumer', config: { v: 'one' } },
  { id: 'b', name: 'cordis:consumer', config: { v: 'two' } },
]

let tree: Tree | undefined
beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[COUNTER]
})
afterEach(async () => {
  await tree?.dispose()
  tree = undefined
  delete (globalThis as Record<string, unknown>)[COUNTER]
})

/** Include 那一列 fiber 的終局：狀態與失敗訊息。 */
async function includeOutcome(t: Tree): Promise<{ state: number | undefined; message: string }> {
  const fiber = t.root.loader.resolve('include').fiber?.ctx.fiber
  const error = await fiber?.await().then(
    () => undefined,
    (reason: unknown) => reason,
  )
  return { state: fiber?.state, message: error instanceof Error ? error.message : String(error ?? '') }
}

describe('量具', () => {
  it('對照：Loader 自己的 evaluate 會讓計數加一（下面的 hits 為 0 不是量具壞了）', () => {
    expect(hits()).toBe(0)
    expect(evaluate({}, EXPR)).toBe(true)
    expect(hits()).toBe(1)
  })

  it('對照：同一份清單不帶 __jsExpr 照樣起來，兩列都掛上（下面的拒絕是 __jsExpr 造成的）', async () => {
    tree = await bootTree({ rows })
    expect((await includeOutcome(tree)).state).toBe(2)
    expect(tree.registry.sort()).toEqual(['a=one', 'b=two'])
  })
})

describe('出貨檔那一列帶 __jsExpr：整份拒絕，沒有被 eval', () => {
  it('`disabled`：Include 起不來，沒有任何列掛上，hits 為 0（上游 #179 起 Loader 會 eval 它）', async () => {
    tree = await bootTree({ rows: [{ ...rows[0], disabled: { __jsExpr: EXPR } }, rows[1]] })
    const outcome = await includeOutcome(tree)
    expect(outcome.state).toBe(3)
    expect(outcome.message).toContain('__jsExpr')
    expect(outcome.message).toContain('entry "a".disabled')
    expect(hits()).toBe(0)
    expect(tree.registry).toEqual([])
  })

  it('`config` 裡任何一層：同樣整份拒絕（Loader 的 interpolate 也會 eval 它）', async () => {
    tree = await bootTree({
      rows: [rows[0], { ...rows[1], config: { v: 'two', nested: { list: [1, { __jsExpr: EXPR }] } } }],
    })
    const outcome = await includeOutcome(tree)
    expect(outcome.state).toBe(3)
    expect(outcome.message).toContain('entry "b".config.nested.list[1]')
    expect(hits()).toBe(0)
    expect(tree.registry).toEqual([])
  })

  it('群組底下的子列：掃的是整份樹，不只頂層', async () => {
    tree = await bootTree({
      rows: [
        { id: 'g', name: 'cordis:group', group: true, config: [{ id: 'c', name: 'cordis:consumer', disabled: { __jsExpr: EXPR } }] },
      ],
    })
    const outcome = await includeOutcome(tree)
    expect(outcome.state).toBe(3)
    expect(outcome.message).toContain('entry "g".config[0].disabled')
    expect(hits()).toBe(0)
  })

  it('YAML 的 `!!js` 標籤（Include 自己的 schema 會把它建成 { __jsExpr }）：同樣拒絕', async () => {
    tree = await bootTree({
      rows,
      source: `- id: a\n  name: cordis:consumer\n  disabled: !!js '${EXPR}'\n- id: b\n  name: cordis:consumer\n`,
    })
    const outcome = await includeOutcome(tree)
    expect(outcome.state).toBe(3)
    expect(outcome.message).toContain('entry "a".disabled')
    expect(hits()).toBe(0)
  })

  it('跑起來之後檔案被改成帶 __jsExpr：重讀被拒、沒被 eval，樹維持原樣，記一筆警告', async () => {
    tree = await bootTree({ rows })
    expect(tree.registry.sort()).toEqual(['a=one', 'b=two'])
    const include = tree.root.loader.resolve('include:a').parent.tree as unknown as Include
    writeFileSync(
      tree.file,
      `- id: a\n  name: cordis:consumer\n  disabled: !!js '${EXPR}'\n- id: b\n  name: cordis:consumer\n  config:\n    v: two\n`,
    )
    await include.refresh()
    expect(hits()).toBe(0)
    expect(tree.registry.sort()).toEqual(['a=one', 'b=two'])
    expect((await includeOutcome(tree)).state).toBe(2)
    expect(tree.logs.some((line) => line.startsWith('warn:') && line.includes('__jsExpr'))).toBe(true)
    // 檔案本身沒被動（Include 不寫檔，這一條只是把「被拒」與「被改寫」分開）。
    expect(readFileSync(tree.file, 'utf8')).toContain('!!js')
  })

  it('重讀被拒之後再推一次設定（internal/update 的呼叫鏈）：update 回報拒絕、Include 仍 ACTIVE、樹不變、沒有沒人接的 rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      tree = await bootTree({ rows })
      const include = tree.root.loader.resolve('include:a').parent.tree as unknown as Include
      writeFileSync(tree.file, `- id: a\n  name: cordis:consumer\n  disabled: !!js '${EXPR}'\n`)
      await include.refresh()
      await expect(
        tree.root.loader.resolve('include').update({
          config: tree.includeConfig([{ id: 'a', config: { v: 'patched' } }]),
        } as never),
      ).rejects.toThrow(/__jsExpr/u)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(hits()).toBe(0)
      expect(tree.registry.sort()).toEqual(['a=one', 'b=two'])
      expect((await includeOutcome(tree)).state).toBe(2)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
