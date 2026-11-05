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

  it('retain a rejected in-place target until a healthy update replaces it', async () => {
    const { ctx, loader } = await setup()
    const failure = new Error('configuration update rejected')
    let accepted = 1
    loader.modules.app = {
      apply(ctx: Context) {
        ctx.on('internal/update', (config: number) => {
          if (config === 2) throw failure
          accepted = config
        })
      },
    }
    try {
      await loader.read([{ id: 'app', name: 'app', config: 1 }])
      await expect(loader.update('app', { config: 2 })).rejects.toBe(failure)
      expect(loader.errors).toEqual([failure])
      expect(accepted).toBe(1)
      await loader.update('app', { config: 3 })
      expect(accepted).toBe(3)
      expect(loader.errors).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ignore an obsolete target rejection after a newer update succeeded', async () => {
    const { ctx, loader } = await setup()
    const failure = new Error('obsolete configuration update')
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let accepted = 1
    loader.modules.app = {
      apply(ctx: Context) {
        ctx.on('internal/update', async (config: number) => {
          if (config === 2) {
            entered.resolve()
            await finish.promise
            throw failure
          }
          accepted = config
        })
      },
    }
    try {
      await loader.read([{ id: 'app', name: 'app', config: 1 }])
      const older = loader.update('app', { config: 2 }).then(() => undefined, error => error)
      await entered.promise
      await loader.update('app', { config: 3 })
      finish.resolve()
      expect(await older).toBe(failure)
      expect(accepted).toBe(3)
      expect(loader.store.app.innerFiber?.config).toBe(3)
      expect(loader.errors).toEqual([])
    } finally {
      finish.resolve()
      await ctx.fiber.dispose()
    }
  })

  it('clear a rejected activation target when a disabled expression withdraws it', async () => {
    const { ctx, loader } = await setup()
    const failure = new Error('withdrawn activation target')
    loader.modules.app = {
      apply(ctx: Context) {
        ctx.on('internal/update', () => { throw failure })
      },
    }
    try {
      await loader.read([{ id: 'app', name: 'app', config: 1 }])
      await expect(loader.update('app', { config: 2 })).rejects.toBe(failure)
      expect(loader.errors).toEqual([failure])
      await loader.read([{ id: 'app', name: 'app', config: 2, disabled: { __jsExpr: 'true' } }])
      expect(loader.store.app.disabled).toBe(true)
      expect(loader.errors).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
