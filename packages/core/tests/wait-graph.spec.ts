import { Context } from '../src/index.ts'
import { completion, createWaitNode, join, lifecycleCompletion, operation, runWithCompletion, runWithNode } from '../src/completion.ts'
import { TaskScope } from '../src/tasks.ts'
import { describe, expect, it } from 'vitest'

async function completeWithin<T>(value: PromiseLike<T>, label: string): Promise<T> {
  const deadline = Promise.withResolvers<never>()
  const timeout = setTimeout(() => deadline.reject(new Error(`${label} remained in its lifecycle wait cycle`)), 1000)
  try {
    return await Promise.race([value, deadline.promise])
  } finally {
    clearTimeout(timeout)
  }
}

describe('Completion wait graph', () => {
  it('keeps a fork ancestor admitted when it merely registers a normal then observer', async () => {
    const scope = new TaskScope(new Context().fiber)
    const beginStop = Promise.withResolvers<void>()
    const controlObserved = Promise.withResolvers<void>()
    const releaseOuter = Promise.withResolvers<void>()
    const order: string[] = []
    let inner!: Promise<string>
    const outer = scope.run(async () => {
      inner = scope.run(async () => {
        await beginStop.promise
        const stopping = lifecycleCompletion(scope.stop(), candidate => candidate === scope)
        const result = stopping.then(() => 'inner complete')
        controlObserved.resolve()
        return await result
      }, 'fork')
      inner.then(() => { order.push('observer finished') })
      await releaseOuter.promise
      order.push('outer finished')
    }, 'independent ancestor')
    beginStop.resolve()
    try {
      await completeWithin(controlObserved.promise, 'fork control observation')
      expect(scope.getTasks().map(task => task.label)).toEqual(['independent ancestor'])
      expect(order).toEqual([])
    } finally {
      releaseOuter.resolve()
      await completeWithin(Promise.all([outer, inner]), 'independent ancestor drain')
    }
    expect(order).toEqual(['outer finished', 'observer finished'])
  })

  it('hands off explicit nested joins while every returned value waits for control cleanup', async () => {
    const scope = new TaskScope(new Context().fiber)
    const beginStop = Promise.withResolvers<void>()
    const cleanupEntered = Promise.withResolvers<void>()
    const releaseCleanup = Promise.withResolvers<void>()
    let cleaned = false
    let returned = false
    const outer = scope.run(async () => {
      const inner = scope.run(async () => {
        await beginStop.promise
        const cleanup = scope.stop().then(async () => {
          cleanupEntered.resolve()
          await releaseCleanup.promise
          cleaned = true
        })
        await lifecycleCompletion(cleanup, candidate => candidate === scope)
        return 'inner'
      }, 'joined inner')
      return `${await join(inner)} joined`
    }, 'joined outer')
    outer.then(() => { returned = true })
    beginStop.resolve()
    try {
      await completeWithin(cleanupEntered.promise, 'explicit nested join')
      expect(scope.pending).toBe(0)
      expect(cleaned).toBe(false)
      expect(returned).toBe(false)
    } finally {
      releaseCleanup.resolve()
    }
    expect(await completeWithin(outer, 'joined task cleanup')).toBe('inner joined')
    expect(cleaned).toBe(true)
    expect(returned).toBe(true)
  })

  it('propagates a late join to an existing control wait and retains unrelated tasks and scopes', async () => {
    const root = new Context()
    const owner = new TaskScope(root.fiber)
    const foreign = new TaskScope(root.fiber)
    const beginStop = Promise.withResolvers<void>()
    const controlObserved = Promise.withResolvers<void>()
    const allowJoin = Promise.withResolvers<void>()
    const joinDeclared = Promise.withResolvers<void>()
    const releaseUnrelated = Promise.withResolvers<void>()
    const releaseForeign = Promise.withResolvers<void>()
    let cleaned = false
    const unrelated = owner.run(() => releaseUnrelated.promise, 'unrelated owner task')
    const other = foreign.run(() => releaseForeign.promise, 'foreign task')
    const outer = owner.run(async () => {
      const inner = owner.run(async () => {
        await beginStop.promise
        const control = lifecycleCompletion(owner.stop().then(() => { cleaned = true }), candidate => candidate === owner)
        const result = control.then(() => 'late result')
        controlObserved.resolve()
        return await result
      }, 'control waiter')
      await allowJoin.promise
      const result = join(inner)
      joinDeclared.resolve()
      return await result
    }, 'late joining outer')
    beginStop.resolve()
    try {
      await completeWithin(controlObserved.promise, 'existing control wait')
      expect(owner.getTasks().map(task => task.label)).toEqual(['unrelated owner task', 'late joining outer'])
      allowJoin.resolve()
      await completeWithin(joinDeclared.promise, 'late join declaration')
      expect(owner.getTasks().map(task => task.label)).toEqual(['unrelated owner task'])
      expect(foreign.getTasks().map(task => task.label)).toEqual(['foreign task'])
      expect(cleaned).toBe(false)
      releaseUnrelated.resolve()
      expect(await completeWithin(outer, 'late join handoff')).toBe('late result')
      expect(cleaned).toBe(true)
      expect(foreign.pending).toBe(1)
    } finally {
      allowJoin.resolve()
      releaseUnrelated.resolve()
      releaseForeign.resolve()
      await completeWithin(Promise.all([outer, unrelated, other, foreign.stop()]), 'late join cleanup')
    }
  })

  it('keeps separate registrations of a shared native source eligible for separate handoffs', async () => {
    const scope = new TaskScope(new Context().fiber)
    const source = Promise.withResolvers<string>()
    const beginStop = Promise.withResolvers<void>()
    const controlObserved = Promise.withResolvers<void>()
    let stopping!: Promise<void>
    const first = scope.run(() => {
      beginStop.promise.then(() => {
        stopping = lifecycleCompletion(scope.stop(), candidate => candidate === scope)
        stopping.then(() => {})
        controlObserved.resolve()
      })
      return source.promise
    }, 'observing registration')
    const second = scope.run(() => source.promise, 'independent registration')
    beginStop.resolve()
    try {
      await completeWithin(controlObserved.promise, 'shared source control observation')
      expect(scope.getTasks().map(task => task.label)).toEqual(['independent registration'])
    } finally {
      source.resolve('shared result')
      expect(await completeWithin(Promise.all([first, second]), 'shared source completion')).toEqual(['shared result', 'shared result'])
      await completeWithin(stopping, 'shared source stop')
    }
  })

  it('subscribes a custom thenable once in its task context while lifecycle cleanup remains pending', async () => {
    const scope = new TaskScope(new Context().fiber)
    const cleanupEntered = Promise.withResolvers<void>()
    const releaseCleanup = Promise.withResolvers<void>()
    let subscriptions = 0
    let cleaned = false
    let returned = false
    const thenable = {
      then(resolve: (value: string) => void, reject: (reason: unknown) => void) {
        subscriptions++
        const cleanup = scope.stop().then(async () => {
          cleanupEntered.resolve()
          await releaseCleanup.promise
          cleaned = true
        })
        lifecycleCompletion(cleanup, candidate => candidate === scope).then(() => resolve('thenable complete'), reject)
      },
    }
    const task = scope.run(() => thenable, 'thenable control waiter')
    const results = Promise.all([task, task]).then((value) => {
      returned = true
      return value
    })
    try {
      await completeWithin(cleanupEntered.promise, 'thenable lifecycle handoff')
      expect(scope.pending).toBe(0)
      expect(subscriptions).toBe(1)
      expect(returned).toBe(false)
      expect(cleaned).toBe(false)
    } finally {
      releaseCleanup.resolve()
    }
    expect(await completeWithin(results, 'thenable cleanup')).toEqual(['thenable complete', 'thenable complete'])
    expect(cleaned).toBe(true)
    expect(subscriptions).toBe(1)
  })

  it('reports one custom thenable subscription exception to all receipt consumers', async () => {
    const scope = new TaskScope(new Context().fiber)
    const reason = new Error('thenable subscription exception')
    const errors: unknown[] = []
    let subscriptions = 0
    const task = scope.run(() => ({
      then(_resolve: (value: string) => void) {
        subscriptions++
        throw reason
      },
    }), 'throwing thenable', error => errors.push(error))
    expect(await Promise.allSettled([task, task])).toEqual([
      { status: 'rejected', reason },
      { status: 'rejected', reason },
    ])
    await scope.stop()
    expect(errors).toEqual([reason])
    expect(subscriptions).toBe(1)
  })

  it('carries actual return dependencies through Promise chains and operation results', async () => {
    const scope = new TaskScope(new Context().fiber)
    const beginStop = Promise.withResolvers<void>()
    const cleanupEntered = Promise.withResolvers<void>()
    const releaseCleanup = Promise.withResolvers<void>()
    const inner = scope.run(async () => {
      await beginStop.promise
      await lifecycleCompletion(scope.stop().then(async () => {
        cleanupEntered.resolve()
        await releaseCleanup.promise
      }), candidate => candidate === scope)
      return 'inner'
    }, 'chain source')
    const group = operation(() => inner.then(value => `${value} chained`))
    const outer = scope.run(() => group, 'returned operation')
    beginStop.resolve()
    try {
      await completeWithin(cleanupEntered.promise, 'returned chain handoff')
      expect(scope.pending).toBe(0)
    } finally {
      releaseCleanup.resolve()
    }
    expect(await completeWithin(outer, 'returned chain cleanup')).toBe('inner chained')
  })

  it('tracks a finalizer returned task while preserving the original chain payload', async () => {
    const scope = new TaskScope(new Context().fiber)
    const beginStop = Promise.withResolvers<void>()
    const cleanupEntered = Promise.withResolvers<void>()
    const releaseCleanup = Promise.withResolvers<void>()
    const chain = operation(() => 'original value').finally(() => scope.run(async () => {
      await beginStop.promise
      await lifecycleCompletion(scope.stop().then(async () => {
        cleanupEntered.resolve()
        await releaseCleanup.promise
      }), candidate => candidate === scope)
      return 'finalizer value'
    }, 'finalizer task'))
    const outer = scope.run(() => chain, 'finalizer waiter')
    beginStop.resolve()
    try {
      await completeWithin(cleanupEntered.promise, 'finalizer dependency handoff')
      expect(scope.pending).toBe(0)
    } finally {
      releaseCleanup.resolve()
    }
    expect(await completeWithin(outer, 'finalizer cleanup')).toBe('original value')
  })

  it('keeps internal lifecycle subscriptions outside the invoking business task', async () => {
    const scope = new TaskScope(new Context().fiber)
    const source = Promise.withResolvers<void>()
    let stopping!: Promise<void>
    let cleaned = false
    const task = scope.run(() => {
      stopping = lifecycleCompletion(scope.stop(), candidate => candidate === scope)
      runWithCompletion(stopping, () => stopping.then(() => { cleaned = true }))
      return source.promise
    }, 'business lease')
    try {
      await Promise.resolve()
      expect(scope.getTasks().map(task => task.label)).toEqual(['business lease'])
      expect(cleaned).toBe(false)
    } finally {
      source.resolve()
      await completeWithin(Promise.all([task, stopping]), 'internal observer cleanup')
    }
    expect(cleaned).toBe(true)
  })

  it('detaches finished nodes from both sides of their declared dependencies', async () => {
    const source = Promise.withResolvers<string>()
    const sourceNode = createWaitNode(undefined, undefined, () => true)
    const sourceCompletion = completion(sourceNode, source.promise)
    const waiterNode = createWaitNode()
    const waiter = completion(waiterNode, runWithNode(waiterNode, () => join(sourceCompletion)))
    expect(waiterNode.dependencies.has(sourceNode)).toBe(true)
    expect(sourceNode.waiters.has(waiterNode)).toBe(true)
    source.resolve('finished')
    expect(await waiter).toBe('finished')
    expect(sourceNode.finished).toBe(true)
    expect(waiterNode.finished).toBe(true)
    expect(sourceNode.dependencies.size).toBe(0)
    expect(sourceNode.waiters.size).toBe(0)
    expect(sourceNode.selector).toBeUndefined()
    expect(waiterNode.dependencies.size).toBe(0)
    expect(waiterNode.waiters.size).toBe(0)
  })
})
