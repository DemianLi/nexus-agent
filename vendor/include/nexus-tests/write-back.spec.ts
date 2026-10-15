// 我們自己的回歸測試，不是上游的。
//
// 本地修改第 7 條關掉了 Include 的寫回：樹只由 `patches` 驅動，`cordis.yml` 與家目錄一個檔都不會被它寫。
// 上游有三條路會寫檔，這裡各打一次，每一條都量「檔案內容一模一樣、目錄裡沒有多出檔、patches 沒被改」。
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'

import type { Context } from '@nexus/cordis'
import { record } from '../src/journal.ts'
import { bootTree, filesIn } from './harness.ts'
import type { Tree } from './harness.ts'

const rows = [
  { id: 'a', name: 'cordis:consumer', config: { v: 'one' } },
  { id: 'b', name: 'cordis:consumer', config: { v: 'two' } },
]

/** Include 內部的待寫清單（私有欄位，白箱量：關掉寫回的證據就是它永遠是空的）。 */
function journalOf(t: Tree): Map<string, unknown> {
  const group = t.root.loader.resolve('include:a').parent.tree as unknown as {
    journal: Map<string, unknown>
  }
  return group.journal
}

let tree: Tree | undefined
afterEach(async () => {
  await tree?.dispose()
  tree = undefined
})

describe('Include 不寫檔', () => {
  it('不掛 hmr 也能 ACTIVE：樹由 patches 驅動，沒有檔案監看', async () => {
    tree = await bootTree({ rows })
    expect(tree.fiber('a')?.state).toBe(2)
    const include = tree.root.loader.resolve('include').fiber?.ctx.fiber
    expect(include?.state).toBe(2)
    expect(tree.root.hmr).toBeUndefined()
  })

  it('路徑 (a)：樹側的變更（commit）不寫檔、不進 patches', async () => {
    tree = await bootTree({ rows, patches: [{ id: 'b', config: { v: 'patched' } }] })
    const before = readFileSync(tree.file, 'utf8')
    const names = filesIn(tree.dir)
    const group = tree.root.loader.resolve('include:a').parent.tree as unknown as {
      update(id: string, options: object): Promise<void>
    }
    await group.update('a', { disabled: true })
    await group.update('b', { config: { v: 'runtime' } })
    await sleep(50)
    expect(readFileSync(tree.file, 'utf8')).toBe(before)
    expect(filesIn(tree.dir)).toEqual(names)
    const patches = tree.root.loader.resolve('include').options.config as { patches: object[] }
    expect(patches.patches).toEqual([{ id: 'b', config: { v: 'patched' } }])
    // commit 層：樹側的變更沒有進 journal（它是「還沒寫進檔」的待寫清單）。把 commit 那一段還原，這裡就是 2 筆。
    expect(journalOf(tree).size).toBe(0)
  })

  it('路徑 (a2)：插件自己呼叫 `ctx.fiber.update(config)`（internal/commit）也不寫檔、不進 patches', async () => {
    let saved: Context | undefined
    tree = await bootTree({
      rows: [{ id: 's', name: 'cordis:saver', config: { v: 'before' } }, ...rows],
      builtins: {
        saver: {
          name: 'saver',
          apply(ctx: Context) {
            saved = ctx
          },
        },
      },
    })
    const before = readFileSync(tree.file, 'utf8')
    const names = filesIn(tree.dir)
    expect(saved).toBeDefined()
    // `noSave` 預設為假：這一步在 Loader 裡走 `internal/commit` → `tree.commit`。
    await saved!.fiber.update({ v: 'after' })
    await sleep(50)
    expect(readFileSync(tree.file, 'utf8')).toBe(before)
    expect(filesIn(tree.dir)).toEqual(names)
    const patches = tree.root.loader.resolve('include').options.config as { patches?: object[] }
    expect(patches.patches ?? []).toEqual([])
    // 沒進 journal：這是 `internal/commit` 那一路的 commit 層。
    expect(journalOf(tree).size).toBe(0)
  })

  it('縱深：`_loop` 不呼叫 `_write`——journal 即使被塞進東西，也不會寫成檔', async () => {
    tree = await bootTree({ rows })
    const before = readFileSync(tree.file, 'utf8')
    const names = filesIn(tree.dir)
    const entry = tree.root.loader.resolve('include:a')
    const include = entry.parent.tree as unknown as {
      journal: Map<string, unknown>
      dirtyWrite: boolean
      _drain(): void
      flush(): Promise<void>
    }
    // 繞過 commit 層，直接把一筆變更塞進 journal，再要求寫入：這一條只靠 `_loop` 那一層擋。
    record(
      include.journal as never,
      {
        id: 'a',
        group: entry.parent,
        options: { ...entry.options, disabled: true },
        legacy: { ...entry.options },
      } as never,
      null,
    )
    expect(include.journal.size).toBe(1)
    include.dirtyWrite = true
    include._drain()
    await include.flush()
    expect(readFileSync(tree.file, 'utf8')).toBe(before)
    expect(filesIn(tree.dir)).toEqual(names)
    // 收尾：不讓 `stop` 在 dispose 時再看到這一筆。
    include.journal.clear()
  })

  it('路徑 (b)：缺檔就是錯，`initial` 不會被寫成檔', async () => {
    tree = await bootTree({
      rows,
      noFile: true,
      initial: [{ id: 'z', name: 'cordis:consumer' }],
    })
    expect(filesIn(tree.dir)).toEqual([])
    expect(tree.root.loader.resolve('include').fiber?.ctx.fiber.state).toBe(3)
    expect(tree.registry).toEqual([])
  })

  it('路徑 (c)：插件自我停用（Loader 處理自我停用的那一格）只在記憶體，不寫檔', async () => {
    tree = await bootTree({
      rows: [{ id: 'q', name: 'cordis:quitter' }, ...rows],
      builtins: {
        quitter: {
          name: 'quitter',
          apply(ctx: Context) {
            setTimeout(() => void ctx.fiber.dispose(), 10)
          },
        },
      },
    })
    const before = readFileSync(tree.file, 'utf8')
    const names = filesIn(tree.dir)
    await sleep(100)
    // 確實發生了自我停用：那一列在樹上被標成 disabled。
    expect(tree.root.loader.resolve('include:q').options.disabled).toBe(true)
    expect(readFileSync(tree.file, 'utf8')).toBe(before)
    expect(filesIn(tree.dir)).toEqual(names)
    // 其他列不受影響。
    expect(tree.registry.sort()).toEqual(['a=one', 'b=two'])
  })
})

describe('允許名單 `only`', () => {
  it('只掛名字在名單上的列；名單外的列在樹上不存在', async () => {
    tree = await bootTree({
      rows: [...rows, { id: 'legacy', name: 'cordis:legacy' }],
      only: ['cordis:consumer'],
    })
    expect(tree.registry.sort()).toEqual(['a=one', 'b=two'])
    expect(tree.fiber('legacy')).toBeUndefined()
  })

  it('對照：同一份清單不給 `only`，名單外的那一列真的掛得起來（上面的缺席是過濾造成的）', async () => {
    tree = await bootTree({ rows: [...rows, { id: 'legacy', name: 'cordis:legacy' }] })
    expect(tree.registry.sort()).toEqual(['a=one', 'b=two', 'legacy!legacy'])
    expect(tree.fiber('legacy')?.state).toBe(2)
  })

  it('先疊 patch、後過濾：指到名單外列的 patch 不產生「找不到」警告', async () => {
    tree = await bootTree({
      rows: [...rows, { id: 'legacy', name: 'cordis:legacy' }],
      only: ['cordis:consumer'],
      patches: [{ id: 'legacy', disabled: true }],
    })
    expect(tree.logs.filter((line) => line.includes('not found'))).toEqual([])
    expect(tree.registry.sort()).toEqual(['a=one', 'b=two'])
  })

  it('對照：指到根本不存在的列，照樣有「找不到」警告（量具抓得到訊息，上一條的零是真的）', async () => {
    tree = await bootTree({
      rows,
      only: ['cordis:consumer'],
      patches: [{ id: 'ghost', disabled: true }],
    })
    expect(tree.logs.filter((line) => line.includes('not found')).length).toBeGreaterThan(0)
  })

  it('沒給 `only` 就不濾，等同上游', async () => {
    tree = await bootTree({
      rows: [...rows, { id: 'legacy', name: 'cordis:consumer', config: { v: 'x' } }],
    })
    expect(tree.registry.sort()).toEqual(['a=one', 'b=two', 'legacy=x'])
  })
})
