import { Context, Fiber, FiberState } from '../src/index.ts'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'

declare module '../src/context.ts' {
  interface Context {
    'event-task-resource': { read(): boolean }
  }
}

async function completeWithin<T>(promise: Promise<T>, operation: string): Promise<T> {
  const deadline = Promise.withResolvers<never>()
  const timeout = setTimeout(() => {
    deadline.reject(new Error(`${operation} remained in its lifecycle wait cycle`))
  }, 1000)
  try {
    return await Promise.race([promise, deadline.promise])
  } finally {
    clearTimeout(timeout)
  }
}

describe('Event task ownership', () => {
  it('retains plugin resources until a blocked event handler completes', async () => {
    const root = new Context()
    const event = Symbol('blocked resource user')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const order: string[] = []
    const fiber = await root.plugin((ctx) => {
      let resourceActive = true
      ctx.on(event, async () => {
        entered.resolve()
        await release.promise
        order.push(resourceActive ? 'handled' : 'released while handling')
      })
      return () => {
        resourceActive = false
        order.push('disposed')
      }
    })

    const dispatch = root.parallel(event)
    await entered.promise
    const stopping = fiber.dispose()
    try {
      await Promise.resolve()
      expect(order).to.deep.equal([])
    } finally {
      release.resolve()
      await Promise.all([dispatch, stopping])
    }
    expect(order).to.deep.equal(['handled', 'disposed'])
  })

  it('stops admitting new dispatch while an earlier event handler drains', async () => {
    const root = new Context()
    const event = Symbol('stopping dispatch')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    const fiber = await root.plugin((ctx) => {
      ctx.on(event, async () => {
        calls++
        entered.resolve()
        await release.promise
      })
    })

    const dispatch = root.parallel(event)
    await entered.promise
    const stopping = fiber.dispose()
    const laterDispatch = root.parallel(event)
    try {
      expect(calls).to.equal(1)
    } finally {
      release.resolve()
      await Promise.all([dispatch, laterDispatch, stopping])
    }
  })
})

describe('Event task dispatch', () => {
  it('attributes pending handlers to their registering fiber', async () => {
    const root = new Context()
    const event = Symbol('owned handler')
    const release = Promise.withResolvers<void>()
    const fiber = await root.plugin((ctx) => {
      ctx.on(event, () => release.promise)
    })

    const dispatch = root.parallel(event)
    const [task] = fiber.getTasks()
    expect(task.signal.aborted).to.equal(false)
    expect(root.fiber.getTasks()).to.deep.equal([])
    const stopping = fiber.dispose()
    try {
      expect(task.signal.aborted).to.equal(true)
    } finally {
      release.resolve()
      await Promise.all([dispatch, stopping])
    }
    expect(fiber.getTasks()).to.deep.equal([])
  })

  it.each(['emit', 'parallel', 'serial', 'bail', 'waterfall'] as const)(
    '%s rechecks admission for listeners in an earlier snapshot',
    async (mode) => {
      const root = new Context()
      const event = Symbol('captured dispatch')
      const hold = Symbol('hold owner open')
      const release = Promise.withResolvers<void>()
      let calls = 0
      let stopping: Promise<void> | undefined
      let stopOwner!: () => Promise<void>
      root.on(event, (next?: () => number) => {
        stopping = stopOwner()
        return next?.()
      })
      const fiber = await root.plugin((ctx) => {
        ctx.on(hold, () => release.promise)
        ctx.on(event, () => { calls++ })
      })
      stopOwner = fiber.dispose
      const pending = root.parallel(hold)

      try {
        if (mode === 'waterfall') {
          expect(root.waterfall(event, () => 42)).to.equal(42)
        } else {
          await root[mode](event)
        }
        expect(calls).to.equal(0)
        expect(fiber.getTasks()).to.have.length(1)
      } finally {
        release.resolve()
        await Promise.all([pending, stopping ?? fiber.dispose()])
      }
    },
  )

  it('rechecks admission in callbacks captured by deprecated dispatch', async () => {
    const root = new Context()
    const event = Symbol('legacy snapshot')
    const hold = Symbol('legacy owner hold')
    const release = Promise.withResolvers<void>()
    let calls = 0
    const fiber = await root.plugin((ctx) => {
      ctx.on(hold, () => release.promise)
      ctx.on(event, () => { calls++ })
    })
    const [invoke] = root.events.dispatch('bail', [event])
    const [waterfall] = root.events.dispatch('waterfall', [event])
    const pending = root.parallel(hold)
    const stopping = fiber.dispose()

    try {
      expect(invoke()).to.equal(undefined)
      expect(waterfall(() => 42)).to.equal(42)
      expect(calls).to.equal(0)
    } finally {
      release.resolve()
      await Promise.all([pending, stopping])
    }
  })

  it('keeps internal hooks callable and untracked while business work drains', async () => {
    const root = new Context()
    const hold = Symbol('business task')
    const release = Promise.withResolvers<void>()
    let internalCalls = 0
    const fiber = await root.plugin((ctx) => {
      ctx.on(hold, () => release.promise)
      ctx.on('internal/dispatch', () => {
        internalCalls++
        expect(ctx.fiber.getTasks()).to.have.length(ctx.fiber.accepting ? 0 : 1)
      })
    })
    const pending = root.parallel(hold)
    const stopping = fiber.dispose()

    try {
      root.emit(Symbol('inspection'))
      expect(internalCalls).to.equal(2)
      expect(fiber.getTasks()).to.have.length(1)
    } finally {
      release.resolve()
      await Promise.all([pending, stopping])
    }
  })

  it('preserves synchronous receivers, values, and exceptions', async () => {
    const root = new Context()
    const event = Symbol('sync callback')
    const receiver = {}
    const value = {}
    root.on(event, function (this: object) {
      expect(this).to.equal(receiver)
      expect(root.fiber.getTasks()).to.have.length(1)
      return value
    })
    expect(root.bail(receiver, event)).to.equal(value)
    expect(root.fiber.getTasks()).to.deep.equal([])

    const waterfall = Symbol('sync waterfall')
    root.on(waterfall, function (this: object, next: () => object) {
      expect(this).to.equal(receiver)
      return next()
    })
    expect(root.waterfall(receiver, waterfall, () => value)).to.equal(value)
    const reason = new Error('synchronous event')
    root.on(Symbol.for('throwing task'), () => { throw reason })
    expect(() => root.emit(Symbol.for('throwing task'))).to.throw(reason)
    expect(root.fiber.getTasks()).to.deep.equal([])
    await root.fiber.dispose()
  })

  it('keeps parallel listener failures at the dispatch boundary during stop', async () => {
    const root = new Context()
    const event = Symbol('rejecting event')
    const release = Promise.withResolvers<void>()
    const reason = new Error('listener rejection')
    const fiber = await root.plugin((ctx) => {
      ctx.on(event, async () => {
        await release.promise
        throw reason
      })
    })
    const dispatch = root.parallel(event)
    const observed = dispatch.catch(error => error)
    const stopping = fiber.dispose()
    release.resolve()

    const error = await observed
    expect(error).to.be.instanceof(AggregateError)
    expect(error.errors).to.deep.equal([reason])
    await stopping
    expect(fiber.getTasks()).to.deep.equal([])
  })
})

describe('Retiring consumer event tasks', () => {
  it('retains the old service through an asynchronous final consumer notification', async () => {
    const root = new Context()
    const event = Symbol('final consumer notification')
    const release = Promise.withResolvers<void>()
    const consumerNotified = Promise.withResolvers<void>()
    const order: string[] = []
    let resourceActive = true
    let calls = 0
    const resource = { read: () => resourceActive }
    const provider = await root.plugin((ctx) => {
      ctx.provide('event-task-resource', resource)
      ctx.on(event, async (service: typeof resource) => {
        calls++
        order.push('notification started')
        await release.promise
        order.push(service.read() ? 'notification read open' : 'notification read closed')
      })
      return () => {
        resourceActive = false
        order.push('provider closed')
      }
    })
    const consumer = await root.inject(['event-task-resource'], ctx => () => {
      ctx.emit(event, ctx['event-task-resource'])
      consumerNotified.resolve()
    })
    const stopping = provider.dispose()
    let freshDispatch: Promise<void> | undefined

    try {
      await consumerNotified.promise
      expect(calls).to.equal(1)
      await consumer.dispose()
      const [task] = provider.getTasks()
      expect(task.signal).to.be.instanceof(AbortSignal)
      expect(resource.read()).to.equal(true)
      expect(order).to.deep.equal(['notification started'])
      freshDispatch = root.parallel(event, resource)
      expect(calls).to.equal(1)
    } finally {
      release.resolve()
      await Promise.all([stopping, consumer.dispose(), freshDispatch])
      await root.fiber.dispose()
    }
    expect(order).to.deep.equal([
      'notification started',
      'notification read open',
      'provider closed',
    ])
  })
})

describe('Event handler lifecycle handoff', () => {
  it.each([
    ['dispose', false],
    ['dispose', true],
    ['restart', false],
    ['restart', true],
    ['update', false],
    ['update', true],
  ] as const)('completes self-%s after await=%s while draining concurrent work', async (operation, afterAwait) => {
    const root = new Context()
    const change = Symbol('self lifecycle')
    const hold = Symbol('concurrent work')
    const resume = Promise.withResolvers<void>()
    const lifecycleRequested = Promise.withResolvers<void>()
    const releaseOther = Promise.withResolvers<void>()
    const order: string[] = []
    const configurations: number[] = []
    const fiber = await root.plugin((ctx, config: { version: number }) => {
      configurations.push(config.version)
      ctx.on(hold, async () => {
        await releaseOther.promise
        order.push('concurrent completed')
      })
      ctx.on(change, async () => {
        if (afterAwait) await resume.promise
        const changing = operation === 'update'
          ? ctx.fiber.update({ version: 2 })
          : ctx.fiber[operation]()
        lifecycleRequested.resolve()
        await changing
        order.push('lifecycle completed')
      })
      return () => { order.push('cleanup completed') }
    }, { version: 1 })
    const concurrent = root.parallel(hold)
    const dispatch = root.parallel(change)
    let completed = false
    resume.resolve()

    try {
      await lifecycleRequested.promise
      await setImmediate()
      expect(order).toEqual([])
      releaseOther.resolve()
      await completeWithin(Promise.all([concurrent, dispatch]), `self-${operation}`)
      completed = true
      expect(order).toEqual(['concurrent completed', 'cleanup completed', 'lifecycle completed'])
      expect(configurations).toEqual(operation === 'dispose' ? [1] : operation === 'restart' ? [1, 1] : [1, 2])
      expect(fiber.state).toBe(operation === 'dispose' ? FiberState.DISPOSED : FiberState.ACTIVE)
    } finally {
      resume.resolve()
      releaseOther.resolve()
      const cleanup = root.fiber.dispose()
      if (completed) await cleanup
    }
  })

  it.each(['cached dispose', 'await'] as const)(
    'hands off an admitted handler joining external disposal through %s',
    async (operation) => {
      const root = new Context()
      const event = Symbol('join external lifecycle')
      const entered = Promise.withResolvers<void>()
      const join = Promise.withResolvers<void>()
      const cleanupEntered = Promise.withResolvers<void>()
      const releaseCleanup = Promise.withResolvers<void>()
      const order: string[] = []
      let resourceActive = true
      const fiber = await root.plugin((ctx) => {
        const dispose = ctx.fiber.dispose
        ctx.on(event, async () => {
          entered.resolve()
          await join.promise
          await (operation === 'cached dispose' ? dispose() : ctx.fiber.await())
          order.push(resourceActive ? 'joined before cleanup' : 'joined after cleanup')
        })
        return async () => {
          order.push('cleanup started')
          cleanupEntered.resolve()
          await releaseCleanup.promise
          resourceActive = false
          order.push('cleanup completed')
        }
      })
      const dispatch = root.parallel(event)
      await entered.promise
      const stopping = fiber.dispose()
      let completed = false

      try {
        expect(fiber.accepting).toBe(false)
        join.resolve()
        await completeWithin(cleanupEntered.promise, `${operation} joining external disposal`)
        expect(order).toEqual(['cleanup started'])
        releaseCleanup.resolve()
        await completeWithin(Promise.all([dispatch, stopping]), `${operation} observing external cleanup`)
        completed = true
        expect(order).toEqual(['cleanup started', 'cleanup completed', 'joined after cleanup'])
        expect(fiber.state).toBe(FiberState.DISPOSED)
      } finally {
        join.resolve()
        releaseCleanup.resolve()
        const cleanup = root.fiber.dispose()
        if (completed) await cleanup
      }
    },
  )

  it.each(['parallel', 'serial'] as const)(
    'retains independent outer work after fire-and-forget nested %s dispatch',
    async (mode) => {
      const root = new Context()
      const outer = Symbol('independent outer handler')
      const inner = Symbol('forked lifecycle caller')
      const lifecycleRequested = Promise.withResolvers<void>()
      const releaseOuter = Promise.withResolvers<void>()
      const order: string[] = []
      let resourceActive = true
      let forked: Promise<unknown> | undefined
      const fiber = await root.plugin((ctx) => {
        ctx.on(outer, async () => {
          forked = root[mode](inner)
          await releaseOuter.promise
          order.push(resourceActive ? 'outer read open' : 'outer read closed')
        })
        ctx.on(inner, async () => {
          const stopping = ctx.fiber.dispose()
          lifecycleRequested.resolve()
          await stopping
          order.push('inner completed')
        })
        return () => {
          resourceActive = false
          order.push('cleanup completed')
        }
      })
      const dispatch = root[mode](outer)
      let completed = false

      try {
        await lifecycleRequested.promise
        await setImmediate()
        expect(resourceActive).toBe(true)
        expect(order).toEqual([])
        expect(fiber.getTasks()).toHaveLength(1)
        releaseOuter.resolve()
        await completeWithin(Promise.all([dispatch, forked]), `forked ${mode} self-dispose`)
        completed = true
        expect(order).toEqual(['outer read open', 'cleanup completed', 'inner completed'])
        expect(fiber.state).toBe(FiberState.DISPOSED)
      } finally {
        releaseOuter.resolve()
        const cleanup = root.fiber.dispose()
        if (completed) await cleanup
      }
    },
  )

  it.each(['parallel', 'serial'] as const)(
    'hands off declared nested %s joins',
    async (mode) => {
      const root = new Context()
      const outer = Symbol('outer lifecycle caller')
      const inner = Symbol('inner lifecycle caller')
      const resume = Promise.withResolvers<void>()
      const order: string[] = []
      const fiber = await root.plugin((ctx) => {
        ctx.on(outer, async () => {
          await ctx.join(root[mode](inner))
          order.push('outer completed')
        })
        ctx.on(inner, async () => {
          await resume.promise
          await ctx.fiber.dispose()
          order.push('inner completed')
        })
        return () => { order.push('cleanup completed') }
      })
      const dispatch = root[mode](outer)
      let completed = false
      resume.resolve()

      try {
        await completeWithin(dispatch, `declared nested ${mode} self-dispose`)
        completed = true
        expect(order).toEqual(['cleanup completed', 'inner completed', 'outer completed'])
        expect(fiber.state).toBe(FiberState.DISPOSED)
      } finally {
        resume.resolve()
        const cleanup = root.fiber.dispose()
        if (completed) await cleanup
      }
    },
  )

  it.each(['parallel', 'serial'] as const)(
    'hands off a late %s join after its inner handler requests self-disposal',
    async (mode) => {
      const root = new Context()
      const outer = Symbol('late joining outer handler')
      const inner = Symbol('already waiting lifecycle caller')
      const lifecycleRequested = Promise.withResolvers<void>()
      const joinInner = Promise.withResolvers<void>()
      const order: string[] = []
      const fiber = await root.plugin((ctx) => {
        ctx.on(outer, async () => {
          const nested = root[mode](inner)
          await joinInner.promise
          await ctx.join(nested)
          order.push('outer completed')
        })
        ctx.on(inner, async () => {
          const stopping = ctx.fiber.dispose()
          lifecycleRequested.resolve()
          await stopping
          order.push('inner completed')
        })
        return () => { order.push('cleanup completed') }
      })
      const dispatch = root[mode](outer)
      let completed = false

      try {
        await lifecycleRequested.promise
        await setImmediate()
        expect(order).toEqual([])
        expect(fiber.getTasks()).toHaveLength(1)
        joinInner.resolve()
        await completeWithin(dispatch, `late ${mode} lifecycle join`)
        completed = true
        expect(order).toEqual(['cleanup completed', 'inner completed', 'outer completed'])
        expect(fiber.state).toBe(FiberState.DISPOSED)
      } finally {
        joinInner.resolve()
        const cleanup = root.fiber.dispose()
        if (completed) await cleanup
      }
    },
  )
})

describe('Emitted asynchronous listener errors', () => {
  it('reports a rejected Promise through the registering owner logger', async () => {
    const root = new Context()
    const event = Symbol('emitted rejection')
    const pending = Promise.withResolvers<void>()
    const reason = new Error('emitted listener rejection')
    const owner = await root.plugin((ctx) => {
      ctx.intercept('logger', { name: 'registered-owner' }).on(event, () => pending.promise)
    })

    root.intercept('logger', { name: 'dispatch-caller' }).emit(event)
    const stopping = owner.dispose()
    pending.reject(reason)
    await stopping
    const errors = root.logger.buffer.filter(message => message.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].args).toEqual([reason])
    expect(errors[0].name).toBe('registered-owner')
    expect(errors[0].fiber?.deref()).toBe(owner)
    await root.fiber.dispose()
  })

  it('observes an emitted arbitrary thenable once and reports its rejection once', async () => {
    const root = new Context()
    const event = Symbol('emitted thenable')
    const subscribed = Promise.withResolvers<void>()
    const reason = new Error('emitted thenable rejection')
    let reads = 0
    let subscriptions = 0
    let reject!: (error: unknown) => void
    const thenable = {
      get then() {
        reads++
        return (_resolve: (value: unknown) => void, onRejected: (error: unknown) => void) => {
          subscriptions++
          reject = onRejected
          subscribed.resolve()
        }
      },
    }
    const owner = await root.plugin((ctx) => {
      ctx.on(event, () => thenable)
    })

    root.emit(event)
    await subscribed.promise
    const stopping = owner.dispose()
    reject(reason)
    reject(new Error('later settlement'))
    await stopping
    expect(reads).toBe(1)
    expect(subscriptions).toBe(1)
    const errors = root.logger.buffer.filter(message => message.type === 'error')
    expect(errors.map(message => message.args)).toEqual([[reason]])
    expect(errors[0].fiber?.deref()).toBe(owner)
    await root.fiber.dispose()
  })

  it.each(['resolve', 'reject'] as const)(
    'joins self-disposal from an emitted custom thenable with %s settlement',
    async (settlement) => {
      const root = new Context()
      const event = Symbol('emitted thenable lifecycle')
      const settled = Promise.withResolvers<void>()
      const reason = new Error('thenable lifecycle rejection')
      const order: string[] = []
      let reads = 0
      let subscriptions = 0
      const owner = await root.plugin((ctx) => {
        ctx.on(event, () => ({
          get then() {
            reads++
            return (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
              subscriptions++
              void ctx.fiber.dispose().then(() => {
                order.push('lifecycle completed')
                if (settlement === 'reject') reject(reason)
                else resolve(undefined)
                reject(new Error('later settlement'))
                settled.resolve()
              }, reject)
            }
          },
        }))
        return () => { order.push('cleanup completed') }
      })
      root.emit(event)
      let completed = false

      try {
        await completeWithin(settled.promise, `custom thenable ${settlement} self-dispose`)
        completed = true
        await setImmediate()
        expect(reads).toBe(1)
        expect(subscriptions).toBe(1)
        expect(order).toEqual(['cleanup completed', 'lifecycle completed'])
        expect(owner.state).toBe(FiberState.DISPOSED)
        const errors = root.logger.buffer.filter(message => message.type === 'error')
        expect(errors.map(message => message.args)).toEqual(settlement === 'reject' ? [[reason]] : [])
        if (settlement === 'reject') expect(errors[0].fiber?.deref()).toBe(owner)
      } finally {
        const cleanup = root.fiber.dispose()
        if (completed) await cleanup
      }
    },
  )

  it.each(['parallel', 'serial', 'bail', 'waterfall'] as const)(
    'keeps %s rejection at the returning dispatch boundary',
    async (mode) => {
      const root = new Context()
      const event = Symbol('returned listener rejection')
      const pending = Promise.withResolvers<void>()
      const reason = new Error('returned dispatch rejection')
      const owner = await root.plugin((ctx) => {
        ctx.on(event, () => pending.promise)
      })
      const result = mode === 'waterfall' ? root.waterfall(event, () => undefined) : root[mode](event)
      const observed = Promise.resolve(result).catch(error => error)
      pending.reject(reason)
      const error = await observed
      if (mode === 'parallel') {
        expect(error).toBeInstanceOf(AggregateError)
        expect(error.errors).toEqual([reason])
      } else {
        expect(error).toBe(reason)
      }
      await owner.dispose()
      expect(root.logger.buffer.filter(message => message.type === 'error')).toEqual([])
      await root.fiber.dispose()
    },
  )

  it('propagates emitted synchronous exceptions without reporting them as asynchronous errors', async () => {
    const root = new Context()
    const event = Symbol('emitted synchronous exception')
    const reason = new Error('synchronous listener exception')
    await root.plugin((ctx) => {
      ctx.on(event, () => { throw reason })
    })
    expect(() => root.emit(event)).toThrow(reason)
    expect(root.logger.buffer.filter(message => message.type === 'error')).toEqual([])
    await root.fiber.dispose()
  })
})

describe('Inherited retiring consumer notifications', () => {
  it.each([
    ['inherited child', true],
    ['isolated child', false],
    ['isolated consumer', false],
    ['same-label isolated consumer', false],
  ] as const)('routes the %s view to the exact retained provider', async (view, accepted) => {
    const root = new Context()
    const event = Symbol('inherited final notification')
    const realm = Symbol('retained service realm')
    const releaseNotification = Promise.withResolvers<void>()
    const resumeCleanup = Promise.withResolvers<void>()
    const notified = Promise.withResolvers<void>()
    const order: string[] = []
    let resourceActive = true
    const resource = { read: () => resourceActive }
    const provider = await root.isolate('event-task-resource', realm).plugin((ctx) => {
      ctx.provide('event-task-resource', resource)
      ctx.on(event, async () => {
        order.push('notification started')
        await releaseNotification.promise
        order.push(resource.read() ? 'notification read open' : 'notification read closed')
      })
      return () => {
        resourceActive = false
        order.push('provider closed')
      }
    })
    let child!: Fiber
    const consumer = await root.isolate('event-task-resource', realm).inject(['event-task-resource'], (ctx) => {
      const cleanup = (sender: Context) => async () => {
        await resumeCleanup.promise
        sender.emit(event)
        notified.resolve()
      }
      child = ctx.plugin((childCtx) => {
        if (view === 'inherited child') return cleanup(childCtx)
        if (view === 'isolated child') return cleanup(childCtx.isolate('event-task-resource'))
      })
      if (view === 'isolated consumer') return cleanup(ctx.isolate('event-task-resource'))
      if (view === 'same-label isolated consumer') return cleanup(ctx.isolate('event-task-resource', realm))
    })
    await child.await()
    const stopping = provider.dispose()
    resumeCleanup.resolve()

    try {
      await notified.promise
      await consumer.dispose()
      expect(order.filter(entry => entry === 'notification started')).toHaveLength(accepted ? 1 : 0)
      await root.parallel(event)
      expect(order.filter(entry => entry === 'notification started')).toHaveLength(accepted ? 1 : 0)
      if (accepted) {
        expect(resource.read()).toBe(true)
        expect(order).toEqual(['notification started'])
      }
    } finally {
      resumeCleanup.resolve()
      releaseNotification.resolve()
      await Promise.all([stopping, consumer.dispose()])
      await root.fiber.dispose()
    }
    expect(order).toEqual(accepted
      ? ['notification started', 'notification read open', 'provider closed']
      : ['provider closed'])
  })
})
