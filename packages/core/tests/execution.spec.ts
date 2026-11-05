import { AsyncLocalStorage } from 'node:async_hooks'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { asHost, bindExecution, Context, ExecutionUnit, FiberState, invoke, resolveExecution, TaskScope } from '../src/index.ts'
import { executionContext } from '../src/execution.ts'

declare module '../src/events.ts' {
  interface Events {
    'internal/execution'(): Promise<string>
    'internal/execution-sync'(): number
    'internal/execution-throw'(): never
  }
}

const graph = new AsyncLocalStorage<FakeUnit | undefined>()

class FakeUnit implements ExecutionUnit {
  references = 0
  disposed = false
  private closing = false
  private readonly disposal = Promise.withResolvers<void>()

  constructor(readonly name: string) {}

  invoke<T>(execute: () => T): T {
    if (this.disposed) throw new Error(`execution after disposal: ${this.name}`)
    return graph.run(this, execute)
  }

  host<T>(execute: () => T): T {
    return graph.run(undefined, execute)
  }

  retain() {
    if (this.disposed) throw new Error(`retention after disposal: ${this.name}`)
    this.references++
    let released = false
    return () => {
      if (released) return
      released = true
      this.references--
      this.finishDisposal()
    }
  }

  dispose() {
    this.closing = true
    this.finishDisposal()
  }

  whenDisposed() {
    return this.disposal.promise
  }

  private finishDisposal() {
    if (!this.closing || this.references) return
    this.disposed = true
    this.disposal.resolve()
  }
}

function current() {
  return graph.getStore()?.name ?? 'host'
}

async function within<T>(value: PromiseLike<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new Error('execution remained pending')), 1000)
  try {
    return await Promise.race([value, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

describe('execution ownership', () => {
  it('keeps separate bindings of one constructor and its public declarations', async () => {
    const root = new Context()
    const left = new FakeUnit('left')
    const right = new FakeUnit('right')
    const seen: string[] = []
    class Shared {
      static #dependencies = ['ready']
      static get inject() { return this.#dependencies }
      static provide = 'shared'
      static Config = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value: String(value) }) } }
      constructor(ctx: Context, value: string) {
        seen.push(`${value}:${current()}`)
      }
    }
    root.provide('ready', {})
    const a = bindExecution(Shared, left)
    const b = bindExecution(Shared, right)
    const resident = bindExecution(Shared, undefined)
    expect(a.Config).toBe(Shared.Config)
    expect(a.inject).toBe(Shared.inject)
    expect(a.provide).toBe('shared')
    expect(resolveExecution(a, right)).toBe(left)
    expect(resolveExecution(resident, left)).toBeUndefined()
    try {
      const first = await root.plugin(a, 'a')
      const second = await root.plugin(b, 'b')
      await invoke(left, () => root.plugin(resident, 'resident'))
      expect(first.runtime!.callback).toBe(Shared)
      expect(second.runtime!.callback).toBe(Shared)
      expect(first.execution).toBe(left)
      expect(second.execution).toBe(right)
      expect(seen).toEqual(['a:left', 'b:right', 'resident:host'])
    } finally {
      await root.fiber.dispose()
    }
  })

  it('runs apply, event, task, effect setup and cleanup in the owning unit', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const event = Symbol('execution')
    const seen: string[] = []
    const owner = await root.plugin(bindExecution((ctx: Context) => {
      seen.push(`apply:${current()}`)
      ctx.effect(() => {
        seen.push(`setup:${current()}`)
        return () => { seen.push(`cleanup:${current()}`) }
      })
      ctx.on(event, async () => {
        seen.push(`event:${current()}`)
        await Promise.resolve()
        seen.push(`event-resumed:${current()}`)
      })
    }, unit))
    try {
      await root.parallel(event)
      expect(owner.ctx.task(() => {
        seen.push(`task:${current()}`)
        return 42
      })).toBe(42)
      const failure = new Error('synchronous task')
      expect(() => owner.ctx.task(() => { throw failure })).toThrow(failure)
      await owner.dispose()
      expect(seen).toEqual(['apply:plugin', 'setup:plugin', 'event:plugin', 'event-resumed:plugin', 'task:plugin', 'cleanup:plugin'])
    } finally {
      await root.fiber.dispose()
    }
  })

  it('keeps registered internal listeners in their unit through their actual asynchronous result', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const seen: string[] = []
    const failure = new Error('internal listener')
    const owner = await root.plugin(bindExecution((ctx: Context) => {
      ctx.on('internal/execution-sync', () => {
        seen.push(`sync:${current()}`)
        return 42
      })
      ctx.on('internal/execution-throw', () => { throw failure })
      ctx.on('internal/execution', async () => {
        seen.push(`internal:${current()}`)
        entered.resolve()
        await release.promise
        seen.push(`internal-resumed:${current()}`)
        return 'internal-complete'
      })
    }, unit))
    try {
      expect(root.bail('internal/execution-sync')).toBe(42)
      expect(() => root.bail('internal/execution-throw')).toThrow(failure)
      const result = root.bail('internal/execution')
      await entered.promise
      await owner.dispose()
      unit.dispose()
      expect(unit.disposed).toBe(false)
      release.resolve()
      expect(await within(result)).toBe('internal-complete')
      await setImmediate()
      expect(unit.disposed).toBe(true)
      expect(seen).toEqual(['sync:plugin', 'internal:plugin', 'internal-resumed:plugin'])
    } finally {
      release.resolve()
      await root.fiber.dispose()
    }
  })

  it('keeps config validation and update listeners in their registration unit', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const seen: string[] = []
    const owner = await root.plugin(bindExecution({
      Config: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate(value: unknown) {
            seen.push(`validate:${current()}`)
            return { value }
          },
        },
      },
      apply(ctx: Context) {
        ctx.on('internal/update', async () => {
          seen.push(`update:${current()}`)
          await Promise.resolve()
          seen.push(`update-resumed:${current()}`)
        })
      },
    }, unit), { value: 1 })
    try {
      await owner.update({ value: 2 })
      expect(owner.effective).toEqual({ value: 2 })
      expect(seen).toEqual(['validate:plugin', 'validate:plugin', 'update:plugin', 'update-resumed:plugin'])
    } finally {
      await root.fiber.dispose()
    }
  })

  it('pins a graph callback registered on a resident context until that registration is removed', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const event = Symbol('resident execution')
    const seen: string[] = []
    const remove = invoke(unit, () => root.on(event, () => {
      seen.push(current())
      return 42
    }))
    unit.dispose()
    try {
      expect(unit.disposed).toBe(false)
      expect(root.bail(event)).toBe(42)
      expect(seen).toEqual(['plugin'])
      await remove()
      expect(unit.disposed).toBe(true)
    } finally {
      await root.fiber.dispose()
    }
  })

  it('preserves the current wait node when entering host control', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const owner = await root.plugin(bindExecution(() => {}, unit))
    try {
      await owner.ctx.task(async () => {
        const node = executionContext.getStore()!.node
        asHost(() => {
          expect(current()).toBe('host')
          expect(executionContext.getStore()!.node).toBe(node)
          expect(executionContext.getStore()!.unit).toBe(unit)
        })
        expect(current()).toBe('plugin')
        await within(owner.dispose())
      })
    } finally {
      await root.fiber.dispose()
    }
  })

  it('reads and subscribes nested thenables in their task unit exactly once', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const subscribed = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<string>()
    const seen: string[] = []
    const owner = await root.plugin(bindExecution(() => {}, unit))
    try {
      const work = owner.ctx.task(() => ({
        get then() {
          seen.push(`get:${current()}`)
          return (resolve: (value: PromiseLike<string>) => void) => {
            seen.push(`subscribe:${current()}`)
            resolve({
              get then() {
                seen.push(`nested-get:${current()}`)
                return (accept: (value: string) => void) => {
                  seen.push(`nested-subscribe:${current()}`)
                  gate.promise.then(accept)
                  subscribed.resolve()
                }
              },
            })
          }
        },
      }))
      await subscribed.promise
      gate.resolve('complete')
      expect(await work).toBe('complete')
      expect(seen).toEqual(['get:plugin', 'subscribe:plugin', 'nested-get:plugin', 'nested-subscribe:plugin'])
    } finally {
      gate.resolve('complete')
      await root.fiber.dispose()
    }
  })

  it('keeps a synchronous subscription alive through the code following its first settlement', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const scope = new TaskScope(root.fiber, unit)
    const seen: string[] = []
    const work = scope.run(() => ({
      then(resolve: (value: string) => void) {
        unit.dispose()
        resolve('payload')
        if (unit.disposed) throw new Error('subscription closed before returning')
        seen.push(`subscription-tail:${current()}`)
      },
    }))
    try {
      expect(await work).toBe('payload')
      expect(seen).toEqual(['subscription-tail:plugin'])
      expect(unit.disposed).toBe(true)
    } finally {
      await root.fiber.dispose()
    }
  })

  it('retains an asynchronous subscription tail independently of its published value', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const scope = new TaskScope(root.fiber, unit)
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const seen: string[] = []
    const work = scope.run(() => ({
      async then(resolve: (value: string) => void) {
        unit.dispose()
        resolve('published')
        await release.promise
        if (unit.disposed) throw new Error('asynchronous subscription closed before returning')
        seen.push(`subscription-tail:${current()}`)
        finished.resolve()
      },
    }))
    try {
      expect(await within(work)).toBe('published')
      expect(scope.getTasks()).toEqual([])
      expect(unit.disposed).toBe(false)
      release.resolve()
      await within(finished.promise)
      await setImmediate()
      expect(unit.disposed).toBe(true)
      expect(seen).toEqual(['subscription-tail:plugin'])
    } finally {
      release.resolve()
      await root.fiber.dispose()
    }
  })

  it('retains actual task and chain execution after business handoff and settles host receipts before disposal', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const bodyEntered = Promise.withResolvers<void>()
    const releaseBody = Promise.withResolvers<void>()
    const chainEntered = Promise.withResolvers<void>()
    const releaseChain = Promise.withResolvers<void>()
    const seen: string[] = []
    const owner = await root.plugin(bindExecution(() => {}, unit))
    const work = owner.ctx.task(async () => {
      await owner.dispose()
      seen.push(`body:${current()}`)
      bodyEntered.resolve()
      await releaseBody.promise
      return 'payload'
    })
    const chain = invoke(unit, () => work.then(async value => {
      seen.push(`then:${current()}:${value}`)
      chainEntered.resolve()
      await releaseChain.promise
      return value
    }).finally(() => { seen.push(`finally:${current()}`) }))
    unit.dispose()
    try {
      await within(bodyEntered.promise)
      expect(owner.getTasks()).toEqual([])
      expect(unit.disposed).toBe(false)
      releaseBody.resolve()
      await within(chainEntered.promise)
      expect(unit.disposed).toBe(false)
      releaseChain.resolve()
      expect(await within(chain)).toBe('payload')
      await setImmediate()
      expect(unit.disposed).toBe(true)
      expect(unit.references).toBe(0)
      expect(seen).toEqual(['body:plugin', 'then:plugin:payload', 'finally:plugin'])
    } finally {
      releaseBody.resolve()
      releaseChain.resolve()
      await Promise.allSettled([work, chain])
      await root.fiber.dispose()
    }
  })

  it('keeps pending task ownership and its signal through the first activation', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const gate = Promise.withResolvers<void>()
    const seen: string[] = []
    let signal!: AbortSignal
    const owner = root.plugin(bindExecution({
      inject: ['ready'],
      apply() {
        seen.push(`apply:${current()}`)
        return () => { seen.push(`cleanup:${current()}`) }
      },
    }, unit))
    const work = owner.ctx.task(async (taskSignal) => {
      signal = taskSignal
      seen.push(`pending:${current()}`)
      await gate.promise
      seen.push(`pending-resumed:${current()}`)
    })
    try {
      root.provide('ready', {})
      await owner.await()
      expect(signal.aborted).toBe(false)
      gate.resolve()
      await work
      await owner.dispose()
      expect(seen).toEqual(['pending:plugin', 'apply:plugin', 'pending-resumed:plugin', 'cleanup:plugin'])
    } finally {
      gate.resolve()
      await root.fiber.dispose()
    }
  })

  it('keeps suspended identity and configuration while notifications wait for resume', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const seen: string[] = []
    const config = { value: 1 }
    root.provide('ready', {})
    const owner = await root.plugin(bindExecution({
      inject: ['ready'],
      apply() {
        seen.push(`apply:${current()}`)
        return () => { seen.push(`cleanup:${current()}`) }
      },
    }, unit), config)
    const uid = owner.uid
    try {
      await owner._suspend()
      root.reflect.notify(['ready'])
      await owner.await()
      expect(owner.state).toBe(FiberState.PENDING)
      expect(owner.uid).toBe(uid)
      expect(owner.config).toBe(config)
      expect(seen).toEqual(['apply:plugin', 'cleanup:plugin'])
      await owner._resume()
      expect(owner.state).toBe(FiberState.ACTIVE)
      expect(owner.uid).toBe(uid)
      expect(seen).toEqual(['apply:plugin', 'cleanup:plugin', 'apply:plugin'])
    } finally {
      await root.fiber.dispose()
    }
  })

  it('keeps old cleanup in its activation unit and adopts a replacement after suspension', async () => {
    const root = new Context()
    const oldUnit = new FakeUnit('old')
    const nextUnit = new FakeUnit('next')
    const cleanupEntered = Promise.withResolvers<void>()
    const releaseCleanup = Promise.withResolvers<void>()
    const seen: string[] = []
    const old = bindExecution(() => async () => {
      seen.push(`cleanup:${current()}`)
      cleanupEntered.resolve()
      await releaseCleanup.promise
      seen.push(`cleanup-resumed:${current()}`)
    }, oldUnit)
    const next = bindExecution(() => { seen.push(`apply:${current()}`) }, nextUnit)
    const owner = await root.plugin(old)
    const uid = owner.uid
    const suspended = owner._suspend()
    try {
      await cleanupEntered.promise
      root.registry.replace(old, next)
      oldUnit.dispose()
      expect(owner.execution).toBe(oldUnit)
      releaseCleanup.resolve()
      await suspended
      await owner.await()
      expect(owner.uid).toBe(uid)
      expect(owner.execution).toBe(nextUnit)
      expect(owner.state).toBe(FiberState.ACTIVE)
      expect(seen).toEqual(['cleanup:old', 'cleanup-resumed:old', 'apply:next'])
      await setImmediate()
      expect(oldUnit.disposed).toBe(true)
    } finally {
      releaseCleanup.resolve()
      await root.fiber.dispose()
    }
  })

  it('keeps native final-value adoption in its unit until the public receipt actually settles', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const scope = await root.plugin(bindExecution(() => {}, unit))
    const subscribed = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const seen: string[] = []
    let reads = 0
    const payload = {
      get then() {
        seen.push(`get:${current()}`)
        if (!reads++) return undefined
        return (resolve: (value: string) => void) => {
          seen.push(`subscribe:${current()}`)
          gate.promise.then(() => resolve('native result'))
          subscribed.resolve()
        }
      },
    }
    const work = scope.ctx.task(() => ({
      then(resolve: (value: unknown) => void) { resolve(payload) },
    }))
    let received: unknown
    const observed = Promise.prototype.then.call(work, (value: unknown) => { received = value })
    try {
      await within(subscribed.promise)
      expect(scope.getTasks()).toHaveLength(1)
      let drained = false
      const stopping = scope.dispose().then(() => { drained = true })
      await setImmediate()
      expect(drained).toBe(false)
      expect(scope.getTasks()).toHaveLength(1)
      unit.dispose()
      expect(unit.disposed).toBe(false)
      gate.resolve()
      await Promise.all([within(observed), stopping])
      expect(drained).toBe(true)
      expect(received).toBe('native result')
      expect(seen).toEqual(['get:plugin', 'get:plugin', 'subscribe:plugin'])
      await within(unit.whenDisposed())
    } finally {
      gate.resolve()
      await observed
      await root.fiber.dispose()
    }
  })

  it('publishes the exact final object without changing its then property', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const scope = new TaskScope(root.fiber, unit)
    const seen: string[] = []
    const payload = Object.freeze({
      get then() {
        seen.push(current())
        return undefined
      },
    })
    const descriptor = Object.getOwnPropertyDescriptor(payload, 'then')
    const work = scope.run(() => ({
      then(resolve: (value: unknown) => void) { resolve(payload) },
    }))
    let received: unknown
    try {
      await Promise.prototype.then.call(work, (value: unknown) => { received = value })
      expect(received).toBe(payload)
      expect(Object.getOwnPropertyDescriptor(payload, 'then')).toEqual(descriptor)
      expect(seen.every(unit => unit === 'plugin')).toBe(true)
      expect(scope.getTasks()).toEqual([])
    } finally {
      await root.fiber.dispose()
    }
  })

  it('reports a native final-value getter rejection through the emitting owner', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const event = Symbol('native final-value rejection')
    const reason = new Error('native final-value getter')
    const seen: string[] = []
    let reads = 0
    const owner = await root.plugin(bindExecution((ctx: Context) => {
      ctx.intercept('logger', { name: 'registered-owner' }).on(event, () => ({
        then(resolve: (value: unknown) => void) {
          resolve({
            get then() {
              seen.push(current())
              if (reads++) throw reason
              return undefined
            },
          })
        },
      }))
    }, unit))
    try {
      root.intercept('logger', { name: 'dispatch-caller' }).emit(event)
      await setImmediate()
      const errors = root.logger.buffer.filter(message => message.type === 'error')
      expect(errors.map(message => message.args)).toEqual([[reason]])
      expect(errors[0].name).toBe('registered-owner')
      expect(errors[0].fiber?.deref()).toBe(owner)
      expect(seen.every(unit => unit === 'plugin')).toBe(true)
      expect(owner.getTasks()).toEqual([])
    } finally {
      await root.fiber.dispose()
    }
  })

  it('returns a graph internal listener effect as the same callable registration handle', async () => {
    const root = new Context()
    const unit = new FakeUnit('plugin')
    const event = Symbol('special listener')
    const cleanupEntered = Promise.withResolvers<void>()
    const releaseCleanup = Promise.withResolvers<void>()
    const seen: string[] = []
    let handle: unknown
    let listener: (() => void) | undefined
    const owner = await root.plugin(bindExecution((ctx: Context) => {
      ctx.on('internal/listener', function (name, callback) {
        if (name !== event) return
        const effect = this.effect(() => {
          seen.push(`setup:${current()}`)
          listener = callback
          return async () => {
            listener = undefined
            seen.push(`cleanup:${current()}`)
            cleanupEntered.resolve()
            await releaseCleanup.promise
            seen.push(`cleanup-tail:${current()}`)
          }
        }, 'special listener')
        handle = effect
        seen.push(`listener-tail:${current()}`)
        return effect
      })
    }, unit))
    try {
      const off = owner.ctx.on(event, () => { seen.push(`callback:${current()}`) })
      expect(off).toBe(handle)
      expect(typeof off).toBe('function')
      expect(owner.getEffects().some(effect => effect.label === 'special listener')).toBe(true)
      listener?.()
      const removing = off()
      await within(cleanupEntered.promise)
      expect(listener).toBeUndefined()
      const stopping = owner.dispose()
      unit.dispose()
      expect(unit.disposed).toBe(false)
      releaseCleanup.resolve()
      await Promise.all([removing, stopping])
      await within(unit.whenDisposed())
      expect(seen).toEqual([
        'setup:plugin', 'listener-tail:plugin', 'callback:host', 'cleanup:plugin', 'cleanup-tail:plugin',
      ])
    } finally {
      releaseCleanup.resolve()
      await root.fiber.dispose()
    }
  })

  it('hands committed pending replacements to the new unit and a fresh accepting task scope', async () => {
    const root = new Context()
    const oldUnit = new FakeUnit('old')
    const nextUnit = new FakeUnit('next')
    const seen: string[] = []
    const old = bindExecution({ inject: ['ready'], apply() { seen.push(`old-apply:${current()}`) } }, oldUnit)
    const next = bindExecution({ inject: ['ready'], apply() { seen.push(`next-apply:${current()}`) } }, nextUnit)
    const owner = root.plugin(old)
    const uid = owner.uid
    const signal = owner.signal
    try {
      await owner._suspend()
      oldUnit.dispose()
      expect(oldUnit.disposed).toBe(false)
      root.registry.replace(old, next)
      await owner.await()
      expect(owner.state).toBe(FiberState.PENDING)
      expect(owner.uid).toBe(uid)
      expect(owner.execution).toBe(nextUnit)
      expect(owner.accepting).toBe(true)
      expect(signal.aborted).toBe(true)
      expect(owner.signal).not.toBe(signal)
      expect(owner.signal.aborted).toBe(false)
      owner.ctx.task(() => { seen.push(`pending-task:${current()}`) })
      await within(oldUnit.whenDisposed())
      root.provide('ready', {})
      await owner.await()
      expect(owner.state).toBe(FiberState.ACTIVE)
      expect(seen).toEqual(['pending-task:next', 'next-apply:next'])
    } finally {
      await root.fiber.dispose()
    }
  })

  it.each([false, true])('reopens a committed suspended pending definition within the same unit (managed=%s)', async (managed) => {
    const root = new Context()
    const unit = managed ? new FakeUnit('shared') : undefined
    const expectedUnit = managed ? 'shared' : 'host'
    const seen: string[] = []
    const old = bindExecution({ inject: ['ready'], apply() { seen.push(`old-apply:${current()}`) } }, unit)
    const next = bindExecution({ inject: ['ready'], apply() { seen.push(`next-apply:${current()}`) } }, unit)
    const owner = root.plugin(old)
    const signal = owner.signal
    try {
      await owner._suspend()
      root.registry.replace(old, next)
      await owner.await()
      expect(owner.state).toBe(FiberState.PENDING)
      expect(owner.accepting).toBe(true)
      expect(owner.signal).not.toBe(signal)
      expect(signal.aborted).toBe(true)
      await owner.ctx.task(() => { seen.push(`pending-task:${current()}`) })
      owner.ctx.on('internal/execution-sync', () => {
        seen.push(`pending-listener:${current()}`)
        return 7
      })
      expect(root.bail('internal/execution-sync')).toBe(7)
      root.provide('ready', {})
      await owner.await()
      expect(owner.state).toBe(FiberState.ACTIVE)
      expect(seen).toEqual([
        `pending-task:${expectedUnit}`, `pending-listener:${expectedUnit}`, `next-apply:${expectedUnit}`,
      ])
    } finally {
      await root.fiber.dispose()
      unit?.dispose()
      if (unit) await within(unit.whenDisposed())
    }
  })

  it('reopens a same-unit pending replacement after already-running cleanup completes', async () => {
    const root = new Context()
    const unit = new FakeUnit('shared')
    const cleaning = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const seen: string[] = []
    const old = bindExecution({ inject: ['ready'], apply() { seen.push('old-apply') } }, unit)
    const next = bindExecution({ inject: ['ready'], apply() { seen.push(`next-apply:${current()}`) } }, unit)
    const owner = root.plugin(old)
    owner.ctx.effect(() => async () => {
      seen.push(`cleanup:${current()}`)
      cleaning.resolve()
      await release.promise
      seen.push(`cleaned:${current()}`)
    })
    let suspending: Promise<void> | undefined
    try {
      suspending = owner._suspend()
      await within(cleaning.promise)
      root.registry.replace(old, next)
      const replaced = owner.await()
      expect(owner.accepting).toBe(false)
      expect(seen).toEqual(['cleanup:shared'])
      release.resolve()
      await Promise.all([suspending, replaced])
      expect(owner.state).toBe(FiberState.PENDING)
      expect(owner.accepting).toBe(true)
      await owner.ctx.task(() => { seen.push(`pending-task:${current()}`) })
      root.provide('ready', {})
      await owner.await()
      expect(seen).toEqual(['cleanup:shared', 'cleaned:shared', 'pending-task:shared', 'next-apply:shared'])
    } finally {
      release.resolve()
      await suspending
      await root.fiber.dispose()
      unit.dispose()
      await within(unit.whenDisposed())
    }
  })

  it('retains a suspended pending definition for rollback before any replacement is committed', async () => {
    const root = new Context()
    const unit = new FakeUnit('old')
    const seen: string[] = []
    const owner = root.plugin(bindExecution({
      inject: ['ready'],
      apply() { seen.push(`apply:${current()}`) },
    }, unit))
    try {
      await owner._suspend()
      unit.dispose()
      expect(unit.disposed).toBe(false)
      expect(owner.execution).toBe(unit)
      await owner._resume()
      expect(owner.state).toBe(FiberState.PENDING)
      owner.ctx.task(() => { seen.push(`pending-task:${current()}`) })
      root.provide('ready', {})
      await owner.await()
      expect(seen).toEqual(['pending-task:old', 'apply:old'])
      expect(unit.disposed).toBe(false)
      await owner.dispose()
      await within(unit.whenDisposed())
    } finally {
      await root.fiber.dispose()
    }
  })

  it('hands a pending definition over while an independent old callback lease finishes later', async () => {
    const root = new Context()
    const oldUnit = new FakeUnit('old')
    const nextUnit = new FakeUnit('next')
    const enteredTail = Promise.withResolvers<void>()
    const releaseTail = Promise.withResolvers<void>()
    const seen: string[] = []
    const old = bindExecution(() => {}, oldUnit)
    const next = bindExecution({ inject: ['ready'], apply() { seen.push(`apply:${current()}`) } }, nextUnit)
    const owner = await root.plugin(old)
    const work = owner.ctx.task(async () => {
      await owner._suspend()
      enteredTail.resolve()
      await releaseTail.promise
      seen.push(`old-tail:${current()}`)
    })
    try {
      await within(enteredTail.promise)
      root.registry.replace(old, next)
      await owner.await()
      oldUnit.dispose()
      expect(owner.state).toBe(FiberState.PENDING)
      expect(owner.execution).toBe(nextUnit)
      expect(oldUnit.disposed).toBe(false)
      owner.ctx.task(() => { seen.push(`pending-task:${current()}`) })
      releaseTail.resolve()
      await work
      await within(oldUnit.whenDisposed())
      root.provide('ready', {})
      await owner.await()
      expect(seen).toEqual(['pending-task:next', 'old-tail:old', 'apply:next'])
    } finally {
      releaseTail.resolve()
      await work
      await root.fiber.dispose()
    }
  })
})
