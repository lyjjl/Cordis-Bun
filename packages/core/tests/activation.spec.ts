import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Context, Fiber, FiberState, ReflectService } from '../src/index.ts'
import { serviceScope } from '../src/reflect.ts'

async function within<T>(value: PromiseLike<T>): Promise<T> {
  const deadline = Promise.withResolvers<never>()
  const timer = setTimeout(() => deadline.reject(new Error('activation remained in a lifecycle wait cycle')), 1000)
  try {
    return await Promise.race([value, deadline.promise])
  } finally {
    clearTimeout(timer)
  }
}

describe('Captured native activation ownership', () => {
  it('hands a later same-activation child off to a cached readiness receipt', async () => {
    const root = new Context()
    const beginChildren = Promise.withResolvers<void>()
    const childStarted = Promise.withResolvers<void>()
    const finishSetup = Promise.withResolvers<void>()
    let child!: Fiber
    let work!: Promise<void>
    let readiness!: Promise<Fiber>
    const parent = root.plugin(async (ctx) => {
      await beginChildren.promise
      child = await ctx.plugin(() => {})
      work = child.ctx.task(async (signal) => {
        const cancelled = Promise.withResolvers<void>()
        signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
        await cancelled.promise
        await readiness
      }, 'later child readiness waiter')
      childStarted.resolve()
      await finishSetup.promise
    })
    readiness = parent.await()
    beginChildren.resolve()
    await childStarted.promise
    const stopping = parent.dispose()
    finishSetup.resolve()
    try {
      await within(Promise.all([readiness, work, stopping]))
      expect(child.state).toBe(FiberState.DISPOSED)
      expect(parent.state).toBe(FiberState.DISPOSED)
    } finally {
      finishSetup.resolve()
    }
    await root.fiber.dispose()
  })

  it('resumes a healthy activation without replaying already-reported cleanup history', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const failure = new Error('reported obsolete cleanup')
    const starts: number[] = []
    const fiber = await root.plugin((ctx: Context, version: number) => {
      starts.push(version)
      ctx.resources.effect(() => { if (version === 1) throw failure })
    }, 1)
    const [update] = await Promise.allSettled([fiber.update(2)])
    expect(update.status).toBe('rejected')
    if (update.status === 'rejected') expect(update.reason.errors).toEqual([failure])
    expect(await Promise.allSettled([fiber._suspend()])).toEqual([{ status: 'fulfilled', value: undefined }])
    const [resumed] = await Promise.allSettled([fiber._resume()])
    expect(resumed.status).toBe('fulfilled')
    expect(starts).toEqual([1, 2, 2])
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(fiber.lastError).toMatchObject({ errors: [failure] })
    await root.fiber.dispose()
  })

  it.each([false, true])('keeps a replacement late descendant owned while an older parent continuation waits (replaced ancestor: %s)', async (replaceAncestor) => {
    const root = new Context()
    const finishSetup = Promise.withResolvers<void>()
    const finishContinuation = Promise.withResolvers<void>()
    const resources: { closed: boolean }[] = []
    const createResource = () => {
      const resource = { closed: false }
      resources.push(resource)
      return () => { resource.closed = true }
    }
    const parent = root.plugin(async () => { await finishSetup.promise })
    const continuation = parent.await().then(() => finishContinuation.promise)
    let work: Promise<void> | undefined
    let stopping: Promise<void> | undefined
    try {
      const late = await parent.ctx.plugin(createResource)
      await late.restart()
      const target = replaceAncestor ? await late.ctx.plugin(createResource) : late
      const resource = resources.at(-1)!
      let readClosed: boolean | undefined
      work = target.ctx.task(async () => {
        await continuation
        readClosed = resource.closed
      }, 'replacement resource waiter')
      finishSetup.resolve()
      await parent.await()
      let finished = false
      stopping = target.dispose().then(() => { finished = true })
      await setImmediate()
      const beforeContinuation = {
        closed: resource.closed,
        finished,
        pending: target.getTasks().map(task => task.label),
      }
      finishContinuation.resolve()
      await within(Promise.all([work, stopping]))
      expect(beforeContinuation).toEqual({
        closed: false,
        finished: false,
        pending: ['replacement resource waiter'],
      })
      expect(readClosed).toBe(false)
      expect(resource.closed).toBe(true)
    } finally {
      finishSetup.resolve()
      finishContinuation.resolve()
      await Promise.allSettled([work, stopping, continuation])
      await root.fiber.dispose()
    }
  })

  it('opens a fresh pending target for explicit restart and update after completed cleanup failure', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const failure = new Error('finished waiting activation cleanup')
    const starts: number[] = []
    const cleaned: number[] = []
    const remove = root.provide('pending-restart-dependency', true)
    const fiber = await root.plugin({
      inject: ['pending-restart-dependency'],
      apply(ctx: Context, version: number) {
        starts.push(version)
        ctx.resources.effect(() => {
          cleaned.push(version)
          if (version === 1) throw failure
        })
      },
    }, 1)
    const obsolete = fiber.ctx.resources
    try {
      const losing = remove()
      const original = fiber.await()
      const [retirement] = await Promise.allSettled([original, losing])
      const [restart] = await Promise.allSettled([fiber.restart()])
      const [update] = await Promise.allSettled([fiber.update(2)])
      const pending = {
        state: fiber.state,
        resourcesActive: fiber.ctx.resources.active,
        starts: [...starts],
        cleaned: [...cleaned],
      }
      root.provide('pending-restart-dependency', true)
      await fiber.await()
      expect(retirement.status).toBe('rejected')
      if (retirement.status === 'rejected') expect(retirement.reason.errors).toEqual([failure])
      expect([restart.status, update.status]).toEqual(['fulfilled', 'fulfilled'])
      expect(pending).toEqual({
        state: FiberState.PENDING,
        resourcesActive: true,
        starts: [1],
        cleaned: [1],
      })
      expect(await Promise.allSettled([original])).toEqual([retirement])
      expect(obsolete.diagnostics()).toMatchObject({ state: 'disposed', error: { errors: [failure] } })
      expect(starts).toEqual([1, 2])
      expect(fiber.state).toBe(FiberState.ACTIVE)
    } finally {
      await root.fiber.dispose()
    }
  })

  it.each([false, true])('preserves a captured setup failure while cleanup is still unloading (cleanup fails: %s)', async (cleanupFails) => {
    const root = new Context()
    root.logger.error = () => {}
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const setupError = new Error('original setup failure before cleanup finishes')
    const cleanupError = new Error('current cleanup failure after target capture')
    let oldCalls = 0
    let candidateCalls = 0
    const old = (ctx: Context) => {
      oldCalls++
      if (oldCalls !== 1) return
      ctx.resources.effect(async () => {
        entered.resolve()
        await release.promise
        if (cleanupFails) throw cleanupError
      })
      throw setupError
    }
    const candidate = () => { candidateCalls++ }
    const fiber = root.plugin(old).ctx.fiber
    const original = Promise.allSettled([fiber.await()])
    const resources = fiber.ctx.resources
    try {
      await entered.promise
      const captured = { state: fiber.state, error: fiber.lastError }
      const target = fiber._captureTarget()
      const targets = new Map([[fiber, target]])
      const suspension = Promise.allSettled([fiber._suspend()])
      release.resolve()
      const [initial] = await original
      const [stopped] = await suspension
      root.registry.replace(old, candidate)
      await Promise.allSettled([fiber.await()])
      await fiber._suspend()
      root.registry.replace(candidate, old, targets)
      const [restoration] = await Promise.allSettled([fiber._resume(target)])
      const [restoredWait] = await Promise.allSettled([fiber.await()])
      expect(captured).toEqual({ state: FiberState.UNLOADING, error: setupError })
      expect(initial).toEqual({ status: 'rejected', reason: setupError })
      expect(stopped.status).toBe(cleanupFails ? 'rejected' : 'fulfilled')
      if (stopped.status === 'rejected') expect(stopped.reason.errors).toEqual([cleanupError])
      expect(restoration.status).toBe('fulfilled')
      expect(restoredWait.status).toBe('rejected')
      if (restoredWait.status === 'rejected') expect(restoredWait.reason).toBe(setupError)
      expect(oldCalls).toBe(1)
      expect(candidateCalls).toBe(1)
      expect(fiber.state).toBe(FiberState.FAILED)
      expect(fiber.lastError).toBe(setupError)
      expect(fiber._hasTargetError(target)).toBe(true)
      expect(fiber.accepting).toBe(false)
      expect(fiber.ctx.resources.active).toBe(false)
      if (cleanupFails) expect(resources.diagnostics().error).toMatchObject({ errors: [cleanupError] })
      else expect(resources.diagnostics().error).toBeUndefined()
    } finally {
      release.resolve()
      await original
      await root.fiber.dispose()
    }
  })

  it('keeps captured self-provisions out of replacement reads and writes', async () => {
    const root = new Context()
    const contexts: Context[] = []
    const fiber = await root.plugin((ctx: Context, version: number) => {
      contexts.push(ctx)
      ctx.provide('activation-self', version)
    }, 1)
    const obsolete = contexts[0]!
    await fiber.update(2)
    expect(() => ReflectService.getBinding(obsolete, 'activation-self')).toThrow('without inject')
    expect(() => obsolete.set('activation-self', 3)).toThrow()
    expect(ReflectService.getBinding(fiber.ctx, 'activation-self')).toBe(2)
    await root.fiber.dispose()
  })

  it.each(['constructor', 'toString', '__proto__'])('does not admit undeclared prototype service %s', async (name) => {
    const root = new Context()
    const fiber = await root.plugin(() => {})
    try {
      expect(() => ReflectService.getBinding(fiber.ctx, name)).toThrow('without inject')
    } finally {
      await root.fiber.dispose()
    }
  })

  it('reclaims empty scoped keys before gated consumers finish binding retirement', async () => {
    const root = new Context()
    const local = root.scope('mapping owner')
    await local.fiber.await()
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const values: number[] = []
    const remove = local.provide('transient-slot', 1)
    const consumer = await local.inject(['transient-slot'], ctx => async () => {
      entered.resolve()
      await release.promise
      values.push(ReflectService.getBinding(ctx, 'transient-slot') as number)
    })
    const isolation = local[Context.isolate]['transient-slot']!
    const key = local[serviceScope].keys.get(isolation)!
    expect(local.reflect.store[key]).toBeDefined()
    const retiring = remove()
    try {
      await entered.promise
      expect(local.reflect.store[key]).toBeUndefined()
      expect(local[serviceScope].keys.has(isolation)).toBe(false)
      const replacement = local.provide('transient-slot', 2)
      release.resolve()
      await retiring
      await consumer.await()
      expect(values).toEqual([1])
      expect(ReflectService.getBinding(consumer.ctx, 'transient-slot')).toBe(2)
      await replacement()
      await consumer.await()
      expect(local[serviceScope].keys.size).toBe(0)
    } finally {
      release.resolve()
      await root.fiber.dispose()
    }
    await setImmediate()
  })
})
