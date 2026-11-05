import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { EntryValidationError } from '../src/index.ts'
import MockLoader from './utils.ts'

describe('Loader: current group option failures', () => {
  it.each([false, true])('reports an invalid unregistered target and clears it on recovery (nested: %s)', async nested => {
    const ctx = new Context()
    await ctx.plugin(MockLoader)
    const loader = ctx.loader as MockLoader
    loader.modules.working = { apply() {} }
    const wrap = (config: unknown[]) => nested
      ? [{ id: 'group', name: '@cordisjs/plugin-group', group: true, config }]
      : config
    try {
      await loader.read(wrap([{ id: 'bad', name: 42 }]))
      expect(loader.store.bad).toBeUndefined()
      expect(loader.errors).toEqual([expect.objectContaining({ name: 'EntryValidationError' })])

      await loader.read(wrap([{ id: 'bad', name: 'working' }]))
      expect(loader.errors).toEqual([])
      expect(loader.store.bad.innerFiber?.accepting).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('withdraws invalid child diagnostics when a group is replaced by a live plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(MockLoader)
    const loader = ctx.loader as MockLoader
    loader.modules.working = { apply(ctx: Context) { ctx.on('test/working', () => true) } }
    try {
      await loader.read([{ id: 'outer', name: '@cordisjs/plugin-group', group: true, config: [{ id: 'bad', name: 42 }] }])
      expect(loader.errors).toEqual([expect.objectContaining({ name: 'EntryValidationError' })])
      const retired = loader.store.outer.subgroup!

      await loader.read([{ id: 'outer', name: 'working' }])
      expect(retired.ctx.resources.active).toBe(false)
      expect(ctx.bail('test/working')).toBe(true)
      expect(loader.errors).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('does not retain a registered activation error as a separate group option failure', async () => {
    const ctx = new Context()
    await ctx.plugin(MockLoader)
    const loader = ctx.loader as MockLoader
    const failure = new EntryValidationError([{ message: 'plugin refused the target', path: ['config'] }])
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
      await loader.read([{ id: 'app', name: 'app', config: 2 }])
      expect(loader.errors).toEqual([failure])
      // Correct only the registered entry, without replacing the group's
      // snapshot. Its canonical error must be the only retained rejection.
      await loader.update('app', { config: 3 })
      expect(accepted).toBe(3)
      expect(loader.errors).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('does not let an old asynchronous activation rejection poison a newer group snapshot', async () => {
    const ctx = new Context()
    await ctx.plugin(MockLoader)
    const loader = ctx.loader as MockLoader
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const failure = new EntryValidationError([{ message: 'obsolete plugin target', path: ['config'] }])
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
      const older = loader.read([
        { id: 'app', name: 'app', config: 2 },
        { id: 'bad', name: 42 },
      ])
      await entered.promise
      await loader.read([{ id: 'app', name: 'app', config: 3 }])
      finish.resolve()
      await older
      await loader.await()
      expect(accepted).toBe(3)
      expect(loader.root.data).toEqual([{ id: 'app', name: 'app', config: 3 }])
      expect(loader.errors).toEqual([])
    } finally {
      finish.resolve()
      await ctx.fiber.dispose()
    }
  })
})
