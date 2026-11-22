// `entry.update({ config: { ...cfg, patches } })` 回來的時候，樹與登記處是不是已經是新值？
// 臨界區（`apps/harness/src/tree-sync.ts`）等的就是這個：量完才知道要 await 什麼。
import { afterEach, describe, expect, it } from 'vitest'

import { bootTree } from './harness.ts'
import type { Tree } from './harness.ts'

const rows = [
  { id: 'a', name: 'cordis:consumer', config: { v: 'one' } },
  { id: 'b', name: 'cordis:consumer', config: { v: 'two' } },
]

let tree: Tree | undefined
afterEach(async () => {
  await tree?.dispose()
  tree = undefined
})

async function push(t: Tree, patches: object[], only?: string[]) {
  await t.include().update({ config: t.includeConfig(patches as never, only) } as never)
}

describe('Include 層的收斂', () => {
  it('開機：await loader.await() 回來時兩列都在登記處', async () => {
    tree = await bootTree({ rows })
    expect(tree.registry).toEqual(['a=one', 'b=two'])
  })

  it('停用：await entry.update 回來時那一列已卸載、登記處已撤', async () => {
    tree = await bootTree({ rows })
    await push(tree, [{ id: 'a', disabled: true }])
    expect(tree.registry).toEqual(['b=two'])
    expect(tree.fiber('a')?.state).toBe(4)
  })

  it('啟用：patch 拿掉之後回來時那一列已重掛', async () => {
    tree = await bootTree({ rows, patches: [{ id: 'a', disabled: true }] })
    expect(tree.registry).toEqual(['b=two'])
    await push(tree, [])
    expect(tree.registry.sort()).toEqual(['a=one', 'b=two'])
  })

  it('改設定：回來時舊值已撤、新值已進', async () => {
    tree = await bootTree({ rows })
    await push(tree, [{ id: 'a', config: { v: 'changed' } }])
    expect(tree.registry.sort()).toEqual(['a=changed', 'b=two'])
    expect(tree.applied['a']).toBe(2)
    expect(tree.applied['b']).toBe(1)
  })

  it('同值：回來時什麼都沒動，沒有重掛', async () => {
    tree = await bootTree({ rows, patches: [{ id: 'a', config: { v: 'x' } }] })
    const before = tree.fiber('a')
    await push(tree, [{ id: 'a', config: { v: 'x' } }])
    expect(tree.fiber('a') === before).toBe(true)
    expect(tree.applied['a']).toBe(1)
  })
})
