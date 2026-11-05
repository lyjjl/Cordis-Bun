import { describe, expect, it } from 'vitest'
import { Context } from '../src/index.ts'

// Target configuration and successful application are observed independently.
describe('Fiber target state', () => {
  it('publishes only the latest successful activation and retains it after an application error', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const failure = new Error('application rejected')
    const fiber = await root.plugin(async (_ctx, config: number) => {
      if (config === 1) {
        entered.resolve()
        await release.promise
      }
      if (config === 4) throw failure
    }, 0)
    expect(fiber.effective).toBe(0)
    const revision = fiber.revision
    const first = fiber.update(1)
    await entered.promise
    const second = fiber.update(2)
    const third = fiber.update(3)
    expect(fiber.config).toBe(3)
    expect(fiber.effective).toBe(0)
    expect(fiber.revision).toBeGreaterThan(revision)
    release.resolve()
    await Promise.all([first, second, third])
    expect(fiber.effective).toBe(3)
    await expect(fiber.update(4)).rejects.toBe(failure)
    expect(fiber.config).toBe(4)
    expect(fiber.effective).toBe(3)
    expect(fiber.lastError).toBe(failure)
    await root.fiber.dispose()
  })

  it('keeps a late in-place update from overwriting a newer accepted configuration', async () => {
    const root = new Context()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const fiber = await root.plugin((ctx, _config: number) => {
      ctx.on('internal/update', async (config: number) => {
        if (config !== 1) return
        entered.resolve()
        await release.promise
      })
    }, 0)
    const first = fiber.update(1)
    await entered.promise
    expect(fiber.effective).toBe(0)
    await fiber.update(2)
    expect(fiber.effective).toBe(2)
    release.resolve()
    await first
    expect(fiber.config).toBe(2)
    expect(fiber.effective).toBe(2)
    await root.fiber.dispose()
  })

  it('publishes an in-place configuration accepted during initialization after that initialization completes', async () => {
    const root = new Context()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const fiber = root.plugin(async (ctx, _config: number) => {
      ctx.on('internal/update', () => {})
      entered.resolve()
      await release.promise
    }, 0)
    await entered.promise
    await fiber.update(1)
    expect(fiber.effective).toBeUndefined()
    release.resolve()
    await fiber
    expect(fiber.effective).toBe(1)
    await root.fiber.dispose()
  })

  it('records the current in-place update error while keeping an older rejection separate', async () => {
    const root = new Context()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const outdated = new Error('outdated update')
    const current = new Error('current update')
    const fiber = await root.plugin((ctx, _config: number) => {
      ctx.on('internal/update', async (config: number) => {
        if (config === 1) {
          entered.resolve()
          await release.promise
          throw outdated
        }
        if (config === 2) throw current
      })
    }, 0)
    const first = Promise.resolve(fiber.update(1)).catch(error => error)
    await entered.promise
    try {
      await expect(fiber.update(2)).rejects.toBe(current)
      expect(fiber.effective).toBe(0)
      expect(fiber.lastError).toBe(current)
      await fiber.update(3)
      expect(fiber.effective).toBe(3)
      expect(fiber.lastError).toBeUndefined()
    } finally {
      release.resolve()
      expect(await first).toBe(outdated)
      await root.fiber.dispose()
    }
    expect(fiber.lastError).toBeUndefined()
  })
})
