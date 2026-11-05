import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Context, FiberState, ReflectService } from '../src/index.ts'

// These gates distinguish completed cleanup from a merely requested stop.
describe('Owned lifecycle completion', () => {
  it('makes concurrent plugin stops wait for the same resource cleanup', async () => {
    const root = new Context()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let closed = false
    const fiber = await root.plugin(() => async () => {
      entered.resolve()
      await release.promise
      closed = true
    })
    const first = fiber.dispose()
    await entered.promise
    let secondFinished = false
    const second = Promise.resolve(fiber.dispose()).then(() => { secondFinished = true })
    await setImmediate()
    const finishedBeforeRelease = secondFinished
    release.resolve()
    await Promise.all([first, second])

    expect(finishedBeforeRelease).toBe(false)
    expect(closed).toBe(true)
    expect(fiber.state).toBe(FiberState.DISPOSED)
    await root.fiber.dispose()
  })

  it('retains an effect whose initializer stops its owner reentrantly', async () => {
    const root = new Context()
    const release = Promise.withResolvers<void>()
    let stopping!: Promise<void>
    let closed = false
    root.effect(() => {
      stopping = root.fiber.dispose()
      return async () => {
        await release.promise
        closed = true
      }
    })
    let finished = false
    stopping.then(() => { finished = true })
    await setImmediate()
    const finishedBeforeRelease = finished
    release.resolve()
    await stopping

    expect(finishedBeforeRelease).toBe(false)
    expect(closed).toBe(true)
  })

  it('keeps manually started asynchronous cleanup owned until completion', async () => {
    const root = new Context()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let disposeResource!: () => Promise<void>
    let closed = false
    const fiber = await root.plugin((ctx) => {
      disposeResource = ctx.effect(() => async () => {
        entered.resolve()
        await release.promise
        closed = true
      })
    })
    const resource = disposeResource()
    await entered.promise
    let finished = false
    const stopping = fiber.dispose().then(() => { finished = true })
    await setImmediate()
    const finishedBeforeRelease = finished
    release.resolve()
    await Promise.all([resource, stopping])

    expect(finishedBeforeRelease).toBe(false)
    expect(closed).toBe(true)
    await root.fiber.dispose()
  })

  it('attempts every composite cleanup in reverse order and aggregates their errors', async () => {
    const root = new Context()
    const timeline: string[] = []
    const syncError = new Error('sync cleanup')
    const asyncError = new Error('async cleanup')
    const dispose = root.effect(function* () {
      yield () => { timeline.push('first') }
      yield () => {
        timeline.push('second')
        throw syncError
      }
      yield async () => {
        timeline.push('third')
        throw asyncError
      }
    })
    const [result] = await Promise.allSettled([dispose()])

    expect(timeline).toEqual(['third', 'second', 'first'])
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') {
      expect(result.reason).toBeInstanceOf(AggregateError)
      expect(result.reason.errors).toEqual([asyncError, syncError])
    }
    await root.fiber.dispose()
  })

  it.each([true, false])('does not replay completed cleanup failures when disposing a replacement=%s owner', async (replace) => {
    const root = new Context()
    const reported: unknown[] = []
    root.logger.error = error => { reported.push(error) }
    const failure = new Error('obsolete activation cleanup')
    const cleaned: number[] = []
    const seen: number[] = []
    const removeDependency = root.provide('cleanup-recovery-dependency', true)
    const fiber = await root.plugin({
      inject: ['cleanup-recovery-dependency'],
      apply(ctx: Context, config: { version: number }) {
        const value = { version: config.version, closed: false }
        ctx.provide('cleanup-recovery-value', value)
        ctx.resources.effect(() => {
          cleaned.push(config.version)
          if (config.version === 1) throw failure
        })
        return () => { value.closed = true }
      },
    }, { version: 1 })
    const consumer = await root.inject(['cleanup-recovery-value'], ctx => {
      const value = ReflectService.getBinding(ctx, 'cleanup-recovery-value') as { version: number; closed: boolean }
      seen.push(value.version)
      return () => { expect(value.closed).toBe(false) }
    })
    const obsolete = fiber.ctx.resources
    if (!replace) await removeDependency()
    const [retirement] = await Promise.allSettled([replace ? fiber.update({ version: 2 }) : fiber.await()])
    expect(retirement.status).toBe('rejected')
    if (retirement.status === 'rejected') expect(retirement.reason.errors).toEqual([failure])
    await consumer.await()
    expect(seen).toEqual(replace ? [1, 2] : [1])
    expect(cleaned).toEqual([1])
    expect(fiber.state).toBe(replace ? FiberState.ACTIVE : FiberState.PENDING)
    expect(obsolete.diagnostics()).toMatchObject({ state: 'disposed', leases: 0, error: { errors: [failure] } })
    expect(fiber.diagnostics().lastError).toMatchObject({ errors: [failure] })
    expect(reported).toContain(fiber.lastError)
    if (replace) {
      expect(ReflectService.getBinding(root, 'cleanup-recovery-value')).toMatchObject({ version: 2, closed: false })
    }
    const release = replace ? fiber.ctx.resources.acquire()! : () => {}
    const shutdown = Promise.allSettled([root.fiber.dispose()])
    try {
      await setImmediate()
      expect(cleaned).toEqual([1])
    } finally {
      release()
    }
    expect(await shutdown).toEqual([{ status: 'fulfilled', value: undefined }])
    expect(cleaned).toEqual(replace ? [1, 2] : [1])
    expect(fiber.state).toBe(FiberState.DISPOSED)
    expect(obsolete.diagnostics().error).toMatchObject({ errors: [failure] })
    await setImmediate()
  })

  it('reports a new stop failure without charging it for an already-joined activation failure', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const first = new Error('first activation cleanup')
    const second = new Error('second activation cleanup')
    const fiber = await root.plugin((ctx: Context, config: { version: number }) => {
      ctx.resources.effect(() => { throw config.version === 1 ? first : second })
    }, { version: 1 })
    const [update] = await Promise.allSettled([fiber.update({ version: 2 })])
    expect(update.status).toBe('rejected')
    if (update.status === 'rejected') expect(update.reason.errors).toEqual([first])
    const [stop] = await Promise.allSettled([fiber.dispose()])
    expect(stop.status).toBe('rejected')
    if (stop.status === 'rejected') expect(stop.reason.errors).toEqual([second])
    expect(fiber.diagnostics().lastError).toMatchObject({ errors: [first, second] })
    await root.fiber.dispose()
    await setImmediate()
  })

  it('keeps diagnostic history without replaying it through a later clean suspension', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const failure = new Error('obsolete activation cleanup')
    const cleaned: number[] = []
    const fiber = await root.plugin((ctx: Context, config: { version: number }) => {
      ctx.resources.effect(() => {
        cleaned.push(config.version)
        if (config.version === 1) throw failure
      })
    }, { version: 1 })
    const [update] = await Promise.allSettled([fiber.update({ version: 2 })])
    expect(update.status).toBe('rejected')
    if (update.status === 'rejected') expect(update.reason.errors).toEqual([failure])
    expect(await Promise.allSettled([fiber._suspend()])).toEqual([{ status: 'fulfilled', value: undefined }])
    expect(cleaned).toEqual([1, 2])
    expect(fiber.diagnostics().lastError).toMatchObject({ errors: [failure] })
    expect(await Promise.allSettled([root.fiber.dispose()])).toEqual([{ status: 'fulfilled', value: undefined }])
    await setImmediate()
  })

  it('joins current descendant failures even when cleanup finishes before the owning stop reaches them', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const failure = new Error('current shutdown cleanup')
    const releaseRequest = Promise.withResolvers<void>()
    const retired = Promise.withResolvers<void>()
    const request = root.task(() => releaseRequest.promise, 'accepted host request')
    let cleanups = 0
    await root.plugin(ctx => { ctx.provide('shutdown-retirement-dependency', {}) })
    const consumer = await root.inject(['shutdown-retirement-dependency'], () => () => {
      cleanups++
      throw failure
    })
    root.on('internal/status', (fiber) => {
      if (fiber === consumer && fiber.state === FiberState.PENDING) retired.resolve()
    })
    const shutdown = Promise.allSettled([root.fiber.dispose()])
    try {
      await retired.promise
      expect(cleanups).toBe(1)
      expect(consumer.diagnostics()).toMatchObject({
        state: FiberState.PENDING, resources: { state: 'disposed' }, lastError: { errors: [failure] },
      })
    } finally {
      releaseRequest.resolve()
    }
    await request
    const [result] = await shutdown
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') expect(result.reason.errors).toEqual([failure])
    expect(cleanups).toBe(1)
    expect(consumer.state).toBe(FiberState.DISPOSED)
    await setImmediate()
  })

  it('closes resource admission while an instance is restarting', async () => {
    const root = new Context()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const fiber = await root.plugin(() => async () => {
      entered.resolve()
      await release.promise
    })
    const restarting = fiber.restart()
    await entered.promise
    let rejected = false
    let acquired = false
    try {
      fiber.ctx.effect(() => {
        acquired = true
        return () => {}
      })
    } catch {
      rejected = true
    }
    release.resolve()
    await restarting

    expect(rejected).toBe(true)
    expect(acquired).toBe(false)
    await root.fiber.dispose()
  })

  it('waits for asynchronous rollback after a synchronous initialization error', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let closed = false
    const fiber = root.plugin((ctx) => {
      ctx.effect(function* () {
        yield async () => {
          entered.resolve()
          await release.promise
          closed = true
        }
        throw new Error('setup interrupted')
      })
    })
    const loading = fiber.await().catch(() => {})
    await entered.promise
    let finished = false
    const stopping = fiber.dispose().then(() => { finished = true })
    await setImmediate()
    const finishedBeforeRelease = finished
    release.resolve()
    await Promise.all([loading, stopping])

    expect(finishedBeforeRelease).toBe(false)
    expect(closed).toBe(true)
    await root.fiber.dispose()
  })

  it('makes root disposal terminal and shares its cleanup completion', async () => {
    const root = new Context()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let closed = false
    root.effect(() => async () => {
      entered.resolve()
      await release.promise
      closed = true
    })
    const first = root.fiber.dispose()
    await entered.promise
    let secondFinished = false
    const second = Promise.resolve(root.fiber.dispose()).then(() => { secondFinished = true })
    await setImmediate()
    const finishedBeforeRelease = secondFinished
    release.resolve()
    await Promise.all([first, second])

    expect(finishedBeforeRelease).toBe(false)
    expect(closed).toBe(true)
    expect(() => root.effect(() => () => {})).toThrow()
    expect(() => root.plugin(() => {})).toThrow()
  })

  it('owns a published child before a lifecycle listener stops the parent', async () => {
    const root = new Context()
    let stopping: Promise<void> | undefined
    let started = false
    root.on('internal/plugin', (fiber) => {
      if (fiber.uid !== null) stopping = root.fiber.dispose()
    })
    const child = root.plugin(() => { started = true })
    await stopping

    expect(started).toBe(false)
    expect(child.state).toBe(FiberState.DISPOSED)
    expect(root.registry.size).toBe(0)
  })

  it('cancels children before waiting for parent work that depends on them', async () => {
    const root = new Context()
    let child!: Context['fiber']
    const parent = await root.plugin(async (ctx) => {
      child = await ctx.plugin(() => {})
    })
    const canceled = Promise.withResolvers<void>()
    let childCanceled = false
    const childWork = child.ctx.task((signal) => {
      signal.addEventListener('abort', () => {
        childCanceled = true
        canceled.resolve()
      }, { once: true })
      return canceled.promise
    }, 'child work')
    const parentWork = parent.ctx.task(() => childWork, 'parent work')
    await parent.dispose()
    await parentWork

    expect(childCanceled).toBe(true)
    expect(child.state).toBe(FiberState.DISPOSED)
    await root.fiber.dispose()
  })

  it('releases resources attached to an instance waiting for its dependencies', async () => {
    const root = new Context()
    const fiber = root.inject(['pending-service'], () => {})
    let closed = false
    fiber.ctx.effect(() => () => { closed = true })
    await fiber.dispose()

    expect(closed).toBe(true)
    expect(fiber.state).toBe(FiberState.DISPOSED)
    await root.fiber.dispose()
  })

  it('keeps a new activation owned while it waits for an older control continuation', async () => {
    const root = new Context()
    const releaseChain = Promise.withResolvers<void>()
    const begin = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const order: string[] = []
    let available = true
    const fiber = await root.plugin(() => {
      available = true
      return () => {
        available = false
        order.push('resource closed')
      }
    })
    const restarting = fiber.restart()
    const oldContinuation = restarting.then(() => releaseChain.promise)
    await restarting
    order.length = 0
    const working = fiber.ctx.task(async () => {
      await begin.promise
      entered.resolve()
      await oldContinuation
      order.push(available ? 'read open' : 'read closed')
    })
    const stopping = fiber.dispose()
    try {
      begin.resolve()
      await entered.promise
      await setImmediate()
      const availableDuringWait = available
      releaseChain.resolve()
      await Promise.all([working, stopping])
      expect(availableDuringWait).toBe(true)
      expect(order).toEqual(['read open', 'resource closed'])
    } finally {
      begin.resolve()
      releaseChain.resolve()
      await Promise.allSettled([working, stopping])
      await root.fiber.dispose()
    }
  })

  it('retains pending work and its cancellation signal through the first activation', async () => {
    const root = new Context()
    const gate = Promise.withResolvers<void>()
    const order: string[] = []
    let available = true
    let signal!: AbortSignal
    const fiber = root.inject(['dep'], () => () => {
      available = false
      order.push('resource closed')
    })
    const working = fiber.ctx.task(async (taskSignal) => {
      signal = taskSignal
      await gate.promise
      order.push(available ? 'read open' : 'read closed')
    })
    root.provide('dep', {})
    await fiber.await()
    const stopping = fiber.dispose()
    try {
      await setImmediate()
      const availableDuringWait = available
      const canceled = signal.aborted
      gate.resolve()
      await Promise.all([working, stopping])
      expect(canceled).toBe(true)
      expect(availableDuringWait).toBe(true)
      expect(order).toEqual(['read open', 'resource closed'])
    } finally {
      gate.resolve()
      await Promise.allSettled([working, stopping])
      await root.fiber.dispose()
    }
  })

  it('reevaluates an initialization wait when its activation starts retiring', async () => {
    const root = new Context()
    const setup = Promise.withResolvers<void>()
    let cleaned = false
    let completed = false
    const fiber = root.plugin(async () => {
      await setup.promise
      return () => { cleaned = true }
    })
    const waiting = fiber.ctx.task(async () => {
      await fiber.await()
      completed = true
    })
    await setImmediate()
    const stopping = fiber.dispose()
    try {
      setup.resolve()
      await setImmediate()
      expect(completed).toBe(true)
      expect(cleaned).toBe(true)
      await Promise.all([waiting, stopping])
    } finally {
      setup.resolve()
      const cleanup = root.fiber.dispose()
      if (completed) await cleanup
    }
  })

  it('aggregates an owned effect returned from apply once', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const failure = new Error('owned resource cleanup')
    let attempts = 0
    const fiber = await root.plugin(ctx => ctx.effect(() => () => {
      attempts++
      throw failure
    }))
    const [result] = await Promise.allSettled([fiber.dispose()])
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') expect(result.reason.errors).toEqual([failure])
    expect(attempts).toBe(1)
    await root.fiber.dispose()
  })
})
