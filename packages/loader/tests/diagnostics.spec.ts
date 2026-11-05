import { describe, expect, it } from 'vitest'
import { Context, FiberState } from 'cordis'
import MockLoader from './utils.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(MockLoader)
  return { ctx, loader: ctx.loader as MockLoader }
}

describe('Loader: current bootstrap diagnostics', () => {
  it('report an import failure and clear it after a corrected entry is loaded', async () => {
    const { ctx, loader } = await setup()
    try {
      await loader.read([{ id: 'app', name: 'unavailable' }])
      expect(loader.errors).toHaveLength(1)
      expect(loader.store.app.innerFiber).toBeUndefined()

      loader.modules.working = { apply() {} }
      await loader.read([{ id: 'app', name: 'working' }])
      expect(loader.errors).toEqual([])
      expect(loader.store.app.innerFiber?.state).toBe(FiberState.ACTIVE)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('report actual apply failures while accepting plugins that log a business error', async () => {
    const { ctx, loader } = await setup()
    const failure = new Error('bootstrap apply rejected')
    let cleaned = false
    loader.modules.rejected = { apply() { throw failure } }
    loader.modules.working = {
      apply(ctx: Context) {
        ctx.logger.error('a reported business incident')
        ctx.effect(() => () => { cleaned = true })
      },
    }
    try {
      await loader.read([{ id: 'app', name: 'rejected' }])
      expect(loader.errors).toEqual([failure])

      await loader.read([{ id: 'app', name: 'working' }])
      expect(loader.errors).toEqual([])
      expect(loader.store.app.innerFiber?.state).toBe(FiberState.ACTIVE)
    } finally {
      await ctx.fiber.dispose()
    }
    expect(cleaned).toBe(true)
  })

  it('clear a configuration expression diagnostic when that configuration is replaced', async () => {
    const { ctx, loader } = await setup()
    loader.modules.app = { apply() {} }
    try {
      await loader.read([{ id: 'app', name: 'app', disabled: { __jsExpr: 'unbound.value' } }])
      expect(loader.errors).toHaveLength(1)
      expect(loader.store.app.innerFiber).toBeUndefined()

      await loader.read([{ id: 'app', name: 'app', disabled: false }])
      expect(loader.errors).toEqual([])
      expect(loader.store.app.innerFiber?.state).toBe(FiberState.ACTIVE)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
