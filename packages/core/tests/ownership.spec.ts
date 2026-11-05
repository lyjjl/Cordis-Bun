import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Context, Fiber } from '../src/index.ts'

// Admission closure must preserve the resource cleanup graph already registered.
describe('Child retirement ownership', () => {
  it('retains compound reverse order while the parent drains its business task', async () => {
    const root = new Context()
    const release = Promise.withResolvers<void>()
    const order: string[] = []
    const parent = await root.plugin(async (ctx) => {
      const child = await ctx.plugin(() => () => { order.push('child closed') })
      ctx.effect(function* () {
        yield child.dispose
        yield () => { order.push('later resource closed') }
      })
    })
    const work = parent.ctx.task(() => release.promise)
    const stopping = parent.dispose()
    await setImmediate()
    const beforeDrain = [...order]
    release.resolve()
    await Promise.all([work, stopping])

    expect(beforeDrain).toEqual([])
    expect(order).toEqual(['later resource closed', 'child closed'])
    await root.fiber.dispose()
  })

  it('includes independently owned child cleanup errors in the parent result', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const release = Promise.withResolvers<void>()
    const failure = new Error('child cleanup')
    const parent = await root.plugin(async (ctx) => {
      await ctx.plugin(() => () => { throw failure })
    })
    const work = parent.ctx.task(() => release.promise)
    const stopping = parent.dispose()
    const result = Promise.allSettled([stopping])
    await setImmediate()
    release.resolve()
    await work
    const [settled] = await result

    expect(settled.status).toBe('rejected')
    if (settled.status === 'rejected') {
      expect(settled.reason).toBeInstanceOf(AggregateError)
      expect(settled.reason.errors).toEqual([failure])
    }
    await root.fiber.dispose()
  })

  it.each(['emit', 'parallel'] as const)('drains inherited child teardown callbacks before provider resources (%s)', async (dispatch) => {
    const root = new Context()
    const gate = Promise.withResolvers<void>()
    const order: string[] = []
    let available = true
    let child: Fiber
    const parent = await root.plugin((ctx) => {
      ctx.provide('foo', {
        read() {
          order.push(available ? 'read open' : 'read closed')
        },
      })
      ctx.effect(() => () => {
        available = false
        order.push('provider closed')
      })
      ctx.effect(function* () {
        yield ctx.on('custom-event', async (value) => {
          order.push('callback started')
          await gate.promise
          value.read()
        })
        child = ctx.plugin(child => async () => {
          if (dispatch === 'parallel') await child.parallel('custom-event', child.foo)
          else child.emit('custom-event', child.foo)
        })
        yield child.dispose
      })
    })
    await child!.await()
    const stopping = parent.dispose()
    await setImmediate()
    const duringDrain = [...order]
    gate.resolve()
    await stopping

    expect(duringDrain).toEqual(['callback started'])
    expect(order).toEqual(['callback started', 'read open', 'provider closed'])
    await root.fiber.dispose()
  })

  it('keeps compound child cleanup at its owned position after an unchanged service notification', async () => {
    const root = new Context()
    root.provide('dep', {})
    const gate = Promise.withResolvers<void>()
    const order: string[] = []
    const parent = await root.plugin(async (ctx) => {
      const child = await ctx.inject(['dep'], () => () => { order.push('child closed') })
      ctx.effect(function* () {
        yield child.dispose
        yield () => { order.push('later resource closed') }
      })
    })
    const working = parent.ctx.task(() => gate.promise)
    const stopping = parent.dispose()
    try {
      root.reflect.notify(['dep'])
      await setImmediate()
      const beforeDrain = [...order]
      gate.resolve()
      await Promise.all([working, stopping])
      expect(beforeDrain).toEqual([])
      expect(order).toEqual(['later resource closed', 'child closed'])
    } finally {
      gate.resolve()
      await Promise.allSettled([working, stopping])
      await root.fiber.dispose()
    }
  })
})
