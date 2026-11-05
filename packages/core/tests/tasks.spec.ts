import { Context } from '../src/index.ts'
import { TaskScope } from '../src/tasks.ts'
import { lifecycleCompletion } from '../src/completion.ts'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'

describe('TaskScope', () => {
  it('admits synchronous work before execution and preserves its return value', () => {
    const root = new Context()
    const scope = new TaskScope(root.fiber)
    const value = { active: true }
    expect(scope.owner).to.equal(root.fiber)

    const result = scope.run((signal) => {
      expect(scope.getTasks()).to.deep.equal([{ label: 'synchronous', signal }])
      expect(signal.aborted).to.equal(false)
      return value
    }, 'synchronous')

    expect(result).to.equal(value)
    expect(scope.getTasks()).to.deep.equal([])
    expect(scope.accepting).to.equal(true)
  })

  it('preserves synchronous exceptions and settles the admitted record', async () => {
    const scope = new TaskScope(new Context().fiber)
    const reason = new Error('task exception')
    expect(() => scope.run(() => { throw reason })).to.throw(reason)
    expect(scope.getTasks()).to.deep.equal([])
    await scope.stop()
  })

  it('preserves asynchronous rejection and drains work with settled semantics', async () => {
    const scope = new TaskScope(new Context().fiber)
    const pending = Promise.withResolvers<number>()
    const reason = new Error('task rejection')
    const task = scope.run(() => pending.promise, 'rejecting')
    const rejected = expect(task).rejects.toBe(reason)
    const stopping = scope.stop()
    expect(scope.getTasks()[0].signal.aborted).to.equal(true)

    pending.reject(reason)
    await rejected
    await stopping
    expect(scope.getTasks()).to.deep.equal([])
  })

  it('waits for a Promise returned after reentrant stop', async () => {
    const scope = new TaskScope(new Context().fiber)
    const pending = Promise.withResolvers<string>()
    let stopping!: Promise<void>
    let drained = false
    const task = scope.run((signal) => {
      stopping = scope.stop()
      stopping.then(() => { drained = true })
      expect(signal.aborted).to.equal(true)
      expect(scope.accepting).to.equal(false)
      return pending.promise
    }, 'late Promise')

    await Promise.resolve()
    expect(drained).to.equal(false)
    expect(scope.getTasks()).to.have.length(1)
    pending.resolve('complete')
    expect(await task).to.equal('complete')
    await stopping
    expect(drained).to.equal(true)
    expect(scope.getTasks()).to.deep.equal([])
  })

  it('shares stop completion with concurrent and abort-reentrant callers', async () => {
    const scope = new TaskScope(new Context().fiber)
    const pending = Promise.withResolvers<void>()
    let nestedStop!: Promise<void>
    scope.run((signal) => {
      signal.addEventListener('abort', () => { nestedStop = scope.stop() }, { once: true })
      return pending.promise
    })

    const stopping = scope.stop()
    expect(scope.stop()).to.equal(stopping)
    expect(nestedStop).to.equal(stopping)
    expect(scope.accepting).to.equal(false)
    expect(() => scope.run(() => {})).to.throw('inactive context')
    pending.resolve()
    await stopping
    expect(scope.stop()).to.equal(stopping)
  })

  it('waits for every admitted task rather than only the first settlement', async () => {
    const scope = new TaskScope(new Context().fiber)
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    scope.run(() => first.promise, 'first')
    scope.run(() => second.promise, 'second')
    let drained = false
    const stopping = scope.stop()
    stopping.then(() => { drained = true })

    first.resolve()
    await first.promise
    expect(scope.getTasks().map(task => task.label)).to.deep.equal(['second'])
    expect(drained).to.equal(false)
    second.resolve()
    await stopping
    expect(drained).to.equal(true)
  })

  it('keeps a reentrantly stopped throwing callback in the drain until it exits', async () => {
    const scope = new TaskScope(new Context().fiber)
    const reason = new Error('synchronous stop')
    let stopping!: Promise<void>
    expect(() => scope.run(() => {
      stopping = scope.stop()
      expect(scope.getTasks()).to.have.length(1)
      throw reason
    })).to.throw(reason)

    await stopping
    expect(scope.getTasks()).to.deep.equal([])
  })

  it('tracks nested thenable completion and exposes its resolved value', async () => {
    const scope = new TaskScope(new Context().fiber)
    const pending = Promise.withResolvers<string>()
    const subscribed = Promise.withResolvers<void>()
    const thenable = {
      then(resolve: (value: Promise<string>) => void) {
        subscribed.resolve()
        resolve(pending.promise)
      },
    }
    const task = scope.run(() => thenable, 'thenable')
    const stopping = scope.stop()
    let drained = false
    stopping.then(() => { drained = true })

    await subscribed.promise
    expect(drained).to.equal(false)
    expect(scope.getTasks()).to.have.length(1)
    pending.resolve('complete')
    await stopping
    expect(await task).toBe('complete')
    expect(scope.getTasks()).to.deep.equal([])
  })

  it('reads a thenable method once for observation', async () => {
    const scope = new TaskScope(new Context().fiber)
    const pending = Promise.withResolvers<void>()
    let reads = 0
    const thenable = {
      get then() {
        reads++
        return pending.promise.then.bind(pending.promise)
      },
    }
    const task = scope.run(() => thenable)
    expect(reads).to.equal(1)
    const stopping = scope.stop()
    pending.resolve()
    await stopping
    await task
    expect(reads).to.equal(1)
  })

  it('preserves a returned object whose then getter throws', async () => {
    const scope = new TaskScope(new Context().fiber)
    const reason = new Error('then getter')
    const value = {
      get then(): never { throw reason },
    }
    expect(scope.run(() => value)).to.equal(value)
    await expect(Promise.resolve(value)).rejects.toBe(reason)
    await scope.stop()
  })

  it('keeps task scopes independent', async () => {
    const first = new TaskScope(new Context().fiber)
    const second = new TaskScope(new Context().fiber)
    const pending = Promise.withResolvers<void>()
    let secondSignal!: AbortSignal
    second.run((signal) => {
      secondSignal = signal
      return pending.promise
    })

    await first.stop()
    expect(second.accepting).to.equal(true)
    expect(secondSignal.aborted).to.equal(false)
    expect(second.run(() => 42)).to.equal(42)
    pending.resolve()
    await second.stop()
  })

  it('hands off a lifecycle waiter while concurrent work drains', async () => {
    const scope = new TaskScope(new Context().fiber)
    const resume = Promise.withResolvers<void>()
    const releaseConcurrent = Promise.withResolvers<void>()
    const stopRequested = Promise.withResolvers<void>()
    const order: string[] = []
    const concurrent = scope.run(async (signal) => {
      expect(signal).toBe(scope.signal)
      await releaseConcurrent.promise
      order.push('concurrent completed')
    })
    const current = scope.run(async () => {
      await resume.promise
      const stopping = lifecycleCompletion(scope.stop(), candidate => candidate === scope)
      stopRequested.resolve()
      await stopping
      order.push('handoff completed')
    })
    resume.resolve()

    try {
      await Promise.race([stopRequested.promise, current])
      expect(scope.signal.aborted).toBe(true)
      await Promise.resolve()
      expect(order).toEqual([])
    } finally {
      releaseConcurrent.resolve()
    }
    await Promise.all([concurrent, current])
    expect(order).toEqual(['concurrent completed', 'handoff completed'])
  })

  it('releases declared matching waiters across another scope while retaining that scope', async () => {
    const root = new Context()
    const owner = new TaskScope(root.fiber)
    const bridge = new TaskScope(root.fiber)
    const resume = Promise.withResolvers<void>()
    const ownerStopped = Promise.withResolvers<void>()
    const releaseBridge = Promise.withResolvers<void>()
    let bridgeFinished = false
    const current = owner.run(() => bridge.run(() => owner.run(async () => {
      await resume.promise
      await lifecycleCompletion(owner.stop(), candidate => candidate === owner)
      ownerStopped.resolve()
      await releaseBridge.promise
    })))
    const bridgeStop = bridge.stop()
    bridgeStop.then(() => { bridgeFinished = true })
    resume.resolve()

    try {
      await Promise.race([ownerStopped.promise, current])
      await Promise.resolve()
      expect(owner.accepting).toBe(false)
      expect(bridgeFinished).toBe(false)
    } finally {
      releaseBridge.resolve()
    }
    await Promise.all([current, bridgeStop])
    expect(bridgeFinished).toBe(true)
  })

  it('reports asynchronous rejection through the same task observer', async () => {
    const scope = new TaskScope(new Context().fiber)
    const pending = Promise.withResolvers<number>()
    const reason = new Error('observed task rejection')
    const errors: unknown[] = []
    const task = scope.run(() => pending.promise, 'observed rejection', error => errors.push(error))
    const rejected = expect(task).rejects.toBe(reason)
    pending.reject(reason)
    await rejected
    await scope.stop()
    expect(errors).toEqual([reason])
  })

  it('preserves synchronous exceptions without invoking the asynchronous observer', async () => {
    const scope = new TaskScope(new Context().fiber)
    const reason = new Error('synchronous observed task')
    const errors: unknown[] = []
    expect(() => scope.run(() => { throw reason }, 'synchronous rejection', error => errors.push(error))).toThrow(reason)
    await scope.stop()
    expect(errors).toEqual([])
  })

  it('retains a forked task ancestor and its resources until its independent work finishes', async () => {
    const root = new Context()
    let resourceActive = true
    const fiber = await root.plugin(() => () => { resourceActive = false })
    const beginStop = Promise.withResolvers<void>()
    const releaseOuter = Promise.withResolvers<void>()
    const order: string[] = []
    let inner!: Promise<void>
    const outer = fiber.ctx.task(async () => {
      inner = fiber.ctx.task(async () => {
        await beginStop.promise
        await fiber.dispose()
        order.push('inner finished')
      }, 'independent self stop')
      await releaseOuter.promise
      order.push(resourceActive ? 'resource used' : 'resource already closed')
    }, 'fork ancestor')
    beginStop.resolve()

    try {
      await setImmediate()
      expect(fiber.getTasks().map(task => task.label)).toEqual(['fork ancestor'])
      expect(resourceActive).toBe(true)
      expect(order).toEqual([])
    } finally {
      releaseOuter.resolve()
      await Promise.all([outer, inner])
      await root.fiber.dispose()
    }
    expect(order).toEqual(['resource used', 'inner finished'])
  })

  it('tracks both invocations when callbacks return one shared Promise', async () => {
    const scope = new TaskScope(new Context().fiber)
    const source = Promise.withResolvers<string>()
    const first = scope.run(() => source.promise, 'first invocation')
    const second = scope.run(() => source.promise, 'second invocation')
    try {
      expect(scope.getTasks().map(task => task.label)).toEqual(['first invocation', 'second invocation'])
    } finally {
      source.resolve('shared value')
      expect(await Promise.all([first, second])).toEqual(['shared value', 'shared value'])
      await scope.stop()
    }
    expect(scope.getTasks()).toEqual([])
  })

  it('drains each admitted wave while keeping the scope open for teardown work', async () => {
    const scope = new TaskScope(new Context().fiber)
    const first = Promise.withResolvers<string>()
    const firstTask = scope.run(() => first.promise, 'first wave')
    const firstDrain = scope.drain()
    expect(scope.pending).toBe(1)
    first.resolve('first complete')
    await firstDrain
    expect(await firstTask).toBe('first complete')
    expect(scope.pending).toBe(0)
    expect(scope.accepting).toBe(true)
    expect(scope.signal.aborted).toBe(false)

    const second = Promise.withResolvers<string>()
    const secondTask = scope.run(() => second.promise, 'second wave')
    let drained = false
    const secondDrain = scope.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(scope.pending).toBe(1)
    expect(drained).toBe(false)
    second.resolve('second complete')
    await secondDrain
    expect(await secondTask).toBe('second complete')
    expect(scope.pending).toBe(0)
    await scope.stop()
  })

  it('closes admission and shares a pending drain with abort-reentrant stop callers', async () => {
    const scope = new TaskScope(new Context().fiber)
    const source = Promise.withResolvers<void>()
    let nestedStop!: Promise<void>
    scope.run((signal) => {
      signal.addEventListener('abort', () => { nestedStop = scope.stop() }, { once: true })
      return source.promise
    })
    let drainFinished = false
    const drain = scope.drain()
    drain.then(() => { drainFinished = true })
    const stopping = scope.stop()
    expect(nestedStop).toBe(stopping)
    expect(scope.accepting).toBe(false)
    expect(scope.signal.aborted).toBe(true)
    expect(drainFinished).toBe(false)
    source.resolve()
    await Promise.all([drain, stopping])
    expect(drainFinished).toBe(true)
    expect(scope.pending).toBe(0)
  })

  it('reports each registration of one shared rejected Promise once', async () => {
    const scope = new TaskScope(new Context().fiber)
    const source = Promise.withResolvers<void>()
    const reason = new Error('shared source rejection')
    const errors: string[] = []
    const first = scope.run(() => source.promise, 'first', () => errors.push('first'))
    const second = scope.run(() => source.promise, 'second', () => errors.push('second'))
    const results = Promise.allSettled([first, second])
    source.reject(reason)
    expect(await results).toEqual([
      { status: 'rejected', reason },
      { status: 'rejected', reason },
    ])
    await scope.stop()
    expect(errors).toEqual(['first', 'second'])
    expect(scope.pending).toBe(0)
  })
})
