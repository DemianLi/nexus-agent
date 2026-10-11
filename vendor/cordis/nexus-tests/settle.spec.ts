// 我們自己的回歸測試，不是上游的：vendor/sync.mjs 不碰這個目錄。
//
// cordiverse/cordis#127：fiber 不是 ACTIVE 時被卸載，狀態停在原地、收不到 DISPOSED。
// 上游兩份修補（#133、#140）的測試只量 PENDING 與 FAILED，這裡三種起點都量。
//
// 修它的是 patches/0001（上游 #185）：從沒啟用過的 fiber 卸載時也跑一次 `_unload()`，所以會經過 UNLOADING
// 再到 DISPOSED。#133／#140 那一行在 #185 之上是多餘的，它們的測試預期直接跳到 DISPOSED，與 #185 衝突，沒有移植。
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
