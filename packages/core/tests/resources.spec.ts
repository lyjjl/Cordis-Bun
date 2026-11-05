import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it } from 'vitest'
import { executionContext, invoke } from '../src/execution.ts'
import type { ExecutionUnit } from '../src/execution.ts'
import { ResourceScope } from '../src/resources.ts'
import type { ResourceOwner } from '../src/resources.ts'

const graph = new AsyncLocalStorage<RetainedUnit | undefined>()

class RetainedUnit implements ExecutionUnit {
  references = 0
  disposed = false
  private closing = false

  constructor(readonly name: string) {}

  invoke<T>(execute: () => T): T {
    if (this.disposed) throw new Error(`execution after disposal: ${this.name}`)
    return graph.run(this, execute)
  }

  host<T>(execute: () => T): T {
    return graph.run(undefined, execute)
  }

  retain(): () => void {
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

  dispose(): void {
    this.closing = true
    this.finishDisposal()
  }

  private finishDisposal(): void {
    if (this.closing && !this.references) this.disposed = true
  }
}

function current(): string {
  return graph.getStore()?.name ?? 'host'
}

describe('resource ownership', () => {
  it('exposes a strict lease barrier without running cleanup or releasing code', async () => {
    const unit = new RetainedUnit('lease barrier')
    const scope = new ResourceScope('parent resources', unit)
    const order: string[] = []
    scope.effect(() => { order.push('cleanup') }, 'connection')
    const release = scope.acquire()!
    scope.retire()
    unit.dispose()
    const drain = scope._waitForLeases()
    expect(drain.constructor).toBe(Promise)
    let drained = false
    void drain.then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(order).toEqual([])
    expect(unit.disposed).toBe(false)
    release()
    await drain
    expect(scope.diagnostics().state).toBe('retiring')
    expect(scope.diagnostics().leases).toBe(0)
    expect(scope.diagnostics().resources).toEqual([{ label: 'connection' }])
    expect(order).toEqual([])
    expect(unit.disposed).toBe(false)
    order.push('child teardown')
    await scope.dispose()
    expect(order).toEqual(['child teardown', 'cleanup'])
    expect(unit.disposed).toBe(true)
  })

  it('retires admission and detaches synchronously without beginning final cleanup', async () => {
    const scope = new ResourceScope('subscriber')
    const owner: ResourceOwner = scope
    const order: string[] = []
    owner.signal.addEventListener('abort', () => {
      expect(owner.active).toBe(false)
      expect(owner.acquire()).toBeUndefined()
      order.push('abort')
    })
    owner.onRetire(() => {
      expect(owner.signal.aborted).toBe(true)
      order.push('detach')
    })
    const unregister = owner.onRetire(() => { order.push('removed') })
    unregister()
    unregister()
    owner.effect(() => { order.push('cleanup') }, 'subscription')

    scope.retire()
    scope.retire()
    expect(owner.active).toBe(false)
    expect(owner.signal.aborted).toBe(true)
    expect(owner.acquire()).toBeUndefined()
    expect(() => owner.effect(() => {})).toThrow()
    expect(order).toEqual(['abort', 'detach'])
    expect(scope.diagnostics()).toEqual({
      label: 'subscriber', state: 'retiring', active: false, leases: 0,
      resources: [{ label: 'subscription' }], error: undefined,
    })
    const removeLate = owner.onRetire(() => { order.push('late detach') })
    removeLate()
    removeLate()
    expect(order).toEqual(['abort', 'detach', 'late detach'])

    await scope.dispose()
    expect(order).toEqual(['abort', 'detach', 'late detach', 'cleanup'])
    expect(scope.diagnostics().state).toBe('disposed')
  })

  it('holds resources until every strict lease drains and releases each lease once', async () => {
    const scope = new ResourceScope('accepted plan')
    const cleaned: string[] = []
    scope.effect(() => { cleaned.push('connection') }, 'connection')
    const releaseFirst = scope.acquire()!
    const releaseLast = scope.acquire()!
    const disposal = scope.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    expect(scope.dispose()).toBe(disposal)
    releaseFirst()
    releaseFirst()
    await Promise.resolve()
    expect(scope.diagnostics().leases).toBe(1)
    expect(disposed).toBe(false)
    expect(cleaned).toEqual([])

    releaseLast()
    await disposal
    releaseLast()
    expect(cleaned).toEqual(['connection'])
    expect(scope.diagnostics()).toEqual({
      label: 'accepted plan', state: 'disposed', active: false, leases: 0,
      resources: [], error: undefined,
    })
    expect(scope.dispose()).toBe(disposal)
  })

  it('collects cleanup returned by admitted asynchronous startup after retirement', async () => {
    const scope = new ResourceScope('startup')
    const startup = Promise.withResolvers<() => void>()
    const order: string[] = []
    scope.effect(() => { order.push('initial resource') })
    const releaseStartup = scope.acquire()!
    const setup = scope.run(async () => {
      try {
        const cleanup = await startup.promise
        expect(scope.active).toBe(false)
        expect(() => scope.effect(cleanup)).toThrow()
        scope._collectCleanup(cleanup, 'returned cleanup')
      } finally {
        releaseStartup()
      }
    })
    const disposal = scope.dispose()
    expect(scope.signal.aborted).toBe(true)
    expect(order).toEqual([])
    startup.resolve(() => { order.push('returned cleanup') })
    await Promise.all([setup, disposal])
    expect(order).toEqual(['returned cleanup', 'initial resource'])
    expect(() => scope._collectCleanup(() => {}, 'too late')).toThrow()
  })

  it('joins manually started asynchronous cleanup without invoking it twice', async () => {
    const scope = new ResourceScope('manual cleanup')
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let calls = 0
    const remove = scope.effect(async () => {
      calls++
      entered.resolve()
      await finish.promise
    }, 'transport')
    const removed = remove()
    expect(remove()).toBe(removed)
    await entered.promise
    const disposal = scope.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(scope.diagnostics().resources).toEqual([{ label: 'transport' }])
    finish.resolve()
    await Promise.all([removed, disposal])
    expect(remove()).toBe(removed)
    expect(calls).toBe(1)
    expect(scope.diagnostics().resources).toEqual([])
  })

  it('does not manually clean a resource while an admitted lease remains', async () => {
    const scope = new ResourceScope()
    let cleanups = 0
    const remove = scope.effect(() => { cleanups++ })
    const removed = remove()
    // Admission may happen after removal is requested but before cleanup starts.
    const release = scope.acquire()!
    await Promise.resolve()
    expect(cleanups).toBe(0)
    release()
    await removed
    await scope.dispose()
    expect(cleanups).toBe(1)
  })

  it('uses strict LIFO order and reports every detachment and cleanup failure once', async () => {
    const scope = new ResourceScope('failing owner')
    const order: string[] = []
    const detachFailure = new Error('detach failed')
    const firstFailure = new Error('first cleanup failed')
    const secondFailure = new Error('second cleanup failed')
    scope.onRetire(() => { order.push('detach failure'); throw detachFailure })
    scope.onRetire(() => { order.push('remaining detach') })
    scope.effect(() => { order.push('first'); throw firstFailure }, 'first')
    scope.effect(async () => { order.push('second'); throw secondFailure }, 'second')
    scope.effect(() => { order.push('third') }, 'third')

    scope.retire()
    expect(order).toEqual(['detach failure', 'remaining detach'])
    const disposal = scope.dispose()
    const failure = await disposal.catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([detachFailure, secondFailure, firstFailure])
    expect(order).toEqual(['detach failure', 'remaining detach', 'third', 'second', 'first'])
    expect(scope.diagnostics().error).toBe(failure)
    expect(scope.diagnostics().state).toBe('disposed')
    expect(scope.dispose()).toBe(disposal)
    expect(await scope.dispose().catch(error => error)).toBe(failure)
  })

  it('retains already-observed manual cleanup failures for final owner diagnostics', async () => {
    const scope = new ResourceScope()
    const failure = new Error('manual cleanup failed')
    let cleanups = 0
    const remove = scope.effect(() => { cleanups++; throw failure }, 'manual failure')
    await expect(remove()).rejects.toBe(failure)
    expect(scope.diagnostics().resources).toEqual([])
    const disposal = scope.dispose()
    const error = await disposal.catch(error => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([failure])
    expect(cleanups).toBe(1)
  })

  it('collects cleanup added by framework teardown before consuming older resources', async () => {
    const scope = new ResourceScope()
    const order: string[] = []
    scope.effect(() => { order.push('oldest') })
    scope.effect(() => {
      order.push('framework teardown')
      scope._collectCleanup(() => { order.push('late cleanup') }, 'late cleanup')
    })
    await scope.dispose()
    expect(order).toEqual(['framework teardown', 'late cleanup', 'oldest'])
  })

  it('finishes reentrant disposal only after every synchronous detachment', async () => {
    const scope = new ResourceScope()
    const order: string[] = []
    let nested: Promise<void> | undefined
    scope.onRetire(() => {
      order.push('first detach')
      nested = scope.dispose()
    })
    scope.onRetire(() => { order.push('last detach') })
    scope.effect(() => { order.push('cleanup') })
    scope.retire()
    expect(order).toEqual(['first detach', 'last detach'])
    expect(scope.dispose()).toBe(nested)
    await nested
    expect(order).toEqual(['first detach', 'last detach', 'cleanup'])
  })

  it('runs admitted old-generation callbacks and cleanup in the captured execution unit', async () => {
    const oldUnit = new RetainedUnit('old generation')
    const newUnit = new RetainedUnit('new generation')
    const scope = new ResourceScope('old activation', oldUnit)
    const seen: string[] = []
    const release = scope.acquire()!
    scope.onRetire(() => { seen.push(`detach:${current()}`) })
    scope.effect(async () => {
      seen.push(`cleanup:${current()}`)
      await Promise.resolve()
      seen.push(`cleanup resumed:${current()}`)
      expect(oldUnit.disposed).toBe(false)
    })
    expect(oldUnit.references).toBe(1)
    oldUnit.dispose()
    const disposal = scope.dispose()
    expect(oldUnit.disposed).toBe(false)
    expect(scope.acquire()).toBeUndefined()
    const operation = invoke(newUnit, () => scope.run(async () => {
      expect(executionContext.getStore()?.unit).toBe(oldUnit)
      seen.push(`callback:${current()}`)
      await Promise.resolve()
      seen.push(`callback resumed:${current()}`)
      expect(oldUnit.disposed).toBe(false)
      release()
      return 42
    }))
    expect(await operation).toBe(42)
    await disposal
    expect(seen).toEqual([
      'detach:old generation', 'callback:old generation', 'callback resumed:old generation',
      'cleanup:old generation', 'cleanup resumed:old generation',
    ])
    expect(oldUnit.references).toBe(0)
    expect(oldUnit.disposed).toBe(true)
    expect(() => scope.run(() => { throw new Error('must not execute') })).toThrow()
    newUnit.dispose()
  })

  it('does not invent task ownership or wait for leases belonging to another scope', async () => {
    const unit = new RetainedUnit('unrelated')
    const scope = new ResourceScope('current', unit)
    const other = new ResourceScope('other')
    const releaseOther = other.acquire()!
    const pending = Promise.withResolvers<void>()
    expect(scope.run(() => pending.promise)).toBe(pending.promise)
    expect(scope.diagnostics().leases).toBe(0)
    unit.dispose()
    await scope.dispose()
    expect(unit.disposed).toBe(true)
    pending.resolve()
    releaseOther()
    await other.dispose()
  })

  it('releases the captured unit even when cleanup throws and late hooks only detach', async () => {
    const unit = new RetainedUnit('failed cleanup')
    const scope = new ResourceScope(undefined, unit)
    const failure = new Error('cleanup failed')
    scope.effect(() => { throw failure })
    unit.dispose()
    const error = await scope.dispose().catch(error => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([failure])
    expect(unit.references).toBe(0)
    expect(unit.disposed).toBe(true)
    let detached = 0
    scope.onRetire(() => { detached++ })()
    expect(detached).toBe(1)
  })

  it('preserves synchronous results and errors while standalone scopes enter the host', async () => {
    const unit = new RetainedUnit('caller')
    const scope = new ResourceScope()
    const failure = new Error('synchronous callback')
    expect(invoke(unit, () => scope.run(() => current()))).toBe('host')
    expect(scope.run(() => 42)).toBe(42)
    expect(() => scope.run(() => { throw failure })).toThrow(failure)
    await scope.dispose()
    unit.dispose()
  })
})
