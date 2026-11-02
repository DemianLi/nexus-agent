// 我們自己的回歸測試，不是上游的：vendor/sync.mjs 不碰這個目錄。
//
// cordiverse/cordis#127：fiber 不是 ACTIVE 時被卸載，狀態停在原地、收不到 DISPOSED。
// 上游 #133 的測試只量 PENDING 與 FAILED，這裡三種起點都量。
//
// patches/0001（上游 #185）讓從沒啟用過與失敗過的 fiber 卸載時也跑一次 `_unload()`，所以會經過 UNLOADING 再到 DISPOSED。
// 上游 #133 讓它們直接到 DISPOSED，與這裡的期待不同，所以 patches/0002 改了上游那兩條測試（#1827 C1）。
import { Context, FiberState } from '../src/index.ts'
import { describe, expect, it, vi } from 'vitest'

/** 記下這顆 fiber 的每一次狀態轉換。 */
function watch(root: Context, fiber: object) {
  const target = Object.getPrototypeOf(fiber)
  const transitions: [FiberState, FiberState][] = []
  root.on('internal/status', (current, oldState) => {
    if (current === target) transitions.push([oldState, current.state])
  })
  return transitions
}

describe('非 ACTIVE 的 fiber 卸載後收斂到 DISPOSED（#127）', () => {
  it('PENDING：依賴的服務一直沒提供', async () => {
    const root = new Context()
    const fiber = root.inject(['never-provided'], () => {})
    expect(fiber.state).toBe(FiberState.PENDING)
    const transitions = watch(root, fiber)
    await fiber.dispose()
    expect(fiber.state).toBe(FiberState.DISPOSED)
    expect(transitions).toEqual([
      [FiberState.PENDING, FiberState.UNLOADING],
      [FiberState.UNLOADING, FiberState.DISPOSED],
    ])
  })

  it('LOADING：apply 還沒跑完就被卸載', async () => {
    const root = new Context()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fiber = root.plugin(async () => {
      await gate
    })
    await Promise.resolve()
    expect(fiber.state).toBe(FiberState.LOADING)
    const disposed = fiber.dispose()
    release()
    await disposed
    expect(fiber.state).toBe(FiberState.DISPOSED)
  })

  it('FAILED：apply 拋錯', async () => {
    const root = new Context()
    root.logger.error = vi.fn()
    const fiber = root.plugin(() => {
      throw new Error('boom')
    })
    await expect(fiber.await()).rejects.toThrow('boom')
    expect(fiber.state).toBe(FiberState.FAILED)
    const transitions = watch(root, fiber)
    await fiber.dispose()
    expect(fiber.state).toBe(FiberState.DISPOSED)
    expect(transitions).toEqual([
      [FiberState.FAILED, FiberState.UNLOADING],
      [FiberState.UNLOADING, FiberState.DISPOSED],
    ])
  })

  it('FAILED：失敗前登記的 effect 在失敗當下就收掉，卸載不重收（對照，有沒有 patches/0001 都成立）', async () => {
    const root = new Context()
    root.logger.error = vi.fn()
    const undo = vi.fn()
    const fiber = root.plugin((ctx) => {
      ctx.effect(() => undo)
      throw new Error('boom')
    })
    await expect(fiber.await()).rejects.toThrow('boom')
    expect(fiber.state).toBe(FiberState.FAILED)
    expect(undo).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    expect(undo).toHaveBeenCalledTimes(1)
  })

  // 沒有 patches/0001 時這條會紅：上游 rc.12（#133）直接到 DISPOSED、不跑 `_unload()`，effect 留著沒收。
  it('PENDING：觀察者趁著發佈登記的 effect，卸載時收掉', async () => {
    const root = new Context()
    const undo = vi.fn()
    root.on('internal/plugin', (fiber) => {
      fiber.ctx.effect(() => undo)
    })
    const fiber = root.inject(['never-provided'], () => {})
    expect(fiber.state).toBe(FiberState.PENDING)
    await fiber.dispose()
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('ACTIVE 的卸載順序不變（對照）', async () => {
    const root = new Context()
    const fiber = root.plugin(() => {})
    await fiber.await()
    const transitions = watch(root, fiber)
    await fiber.dispose()
    expect(fiber.state).toBe(FiberState.DISPOSED)
    expect(transitions).toEqual([
      [FiberState.ACTIVE, FiberState.UNLOADING],
      [FiberState.UNLOADING, FiberState.DISPOSED],
    ])
  })
})
