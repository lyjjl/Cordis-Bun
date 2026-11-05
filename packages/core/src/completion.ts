import { asHost, executionContext, ExecutionUnit, invoke } from './execution.ts'
import type { TaskInfo, TaskResult, TaskScope } from './tasks.ts'
import type { ResourceOwner } from './resources.ts'

export type ScopeSelector = (scope: TaskScope) => boolean

export interface WaitNode {
  scope?: TaskScope
  task?: TaskInfo
  selector?: ScopeSelector
  // Lexical execution provenance, not an implicit join or wait dependency.
  caller?: WaitNode
  resourceOwner?: ResourceOwner
  unit?: ExecutionUnit
  release?: () => void
  readonly dependencies: Set<WaitNode>
  readonly waiters: Set<WaitNode>
  finished: boolean
}

const nativeThen = Promise.prototype.then

type Then = (...args: never[]) => unknown

export function createWaitNode(scope?: TaskScope, task?: TaskInfo, selector?: ScopeSelector, unit?: ExecutionUnit): WaitNode {
  return asHost(() => {
    const current = executionContext.getStore()
    return {
      scope,
      task,
      selector,
      unit,
      caller: current?.node,
      resourceOwner: current?.resourceOwner,
      release: unit?.retain(),
      dependencies: new Set(),
      waiters: new Set(),
      finished: false,
    }
  })
}

export function runWithNode<T, A extends unknown[]>(node: WaitNode, execute: (...args: A) => T, ...args: A): T {
  return executionContext.run({ ...executionContext.getStore(), node, resourceOwner: node.resourceOwner }, execute, ...args)
}

function releaseWaiters(node: WaitNode, selector: ScopeSelector) {
  const pending = [node]
  const visited = new Set<WaitNode>()
  while (pending.length) {
    const current = pending.pop()!
    if (current.finished || visited.has(current)) continue
    visited.add(current)
    if (current.scope && current.task && current.scope._has(current.task) && selector(current.scope)) {
      current.scope._release(current.task)
    }
    for (const waiter of current.waiters) pending.push(waiter)
  }
}

function addDependency(waiter: WaitNode, dependency: WaitNode) {
  if (waiter === dependency || waiter.finished || dependency.finished || waiter.dependencies.has(dependency)) return
  waiter.dependencies.add(dependency)
  dependency.waiters.add(waiter)
  refreshWaitNode(waiter, dependency)
}

export function refreshWaitNode(waiter: WaitNode, dependency = waiter): void {
  // A join can arrive after its child has already started waiting for control.
  const pending = [dependency]
  const visited = new Set<WaitNode>()
  while (pending.length) {
    const current = pending.pop()!
    if (current.finished || visited.has(current)) continue
    visited.add(current)
    if (current.selector) releaseWaiters(waiter, current.selector)
    for (const child of current.dependencies) pending.push(child)
  }
}

function consume(node: WaitNode, value: unknown) {
  if (!(value instanceof TaskCompletion)) return
  if (node === value.node && !node.finished) throw new TypeError('A completion cannot resolve to itself')
  addDependency(node, value.node)
}

export function finishWaitNode(node: WaitNode): void {
  if (node.finished) return
  node.finished = true
  if (node.scope && node.task) node.scope._release(node.task)
  for (const dependency of node.dependencies) dependency.waiters.delete(node)
  for (const waiter of node.waiters) waiter.dependencies.delete(node)
  node.dependencies.clear()
  node.waiters.clear()
  node.scope = undefined
  node.task = undefined
  node.selector = undefined
  node.caller = undefined
  node.resourceOwner = undefined
  node.unit = undefined
  const release = node.release
  node.release = undefined
  release?.()
}

export class TaskCompletion<T> extends Promise<T> {
  static get [Symbol.species]() {
    return Promise
  }

  constructor(
    readonly node: WaitNode,
    execute: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void,
  ) {
    super(execute)
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): TaskCompletion<TResult1 | TResult2> {
    const current = executionContext.getStore()
    if (current?.node && this.node.selector) addDependency(current.node, this.node)
    const node = createWaitNode(undefined, undefined, this.node.selector, current?.unit)
    addDependency(node, this.node)
    return asHost(() => {
      const deferred = deferredCompletion<TResult1 | TResult2>(node)
      const evaluate = (callback: Function | null | undefined, value: unknown, rejected: boolean) => {
        deferred.observe(() => {
          if (typeof callback !== 'function') {
            if (rejected) deferred.reject(value)
            else deferred.resolve(value)
            return
          }
          try {
            deferred.resolve(runWithNode(node, () => invoke(node.unit, () => callback(value))))
          } catch (error) {
            deferred.reject(error)
          }
        })
      }
      Reflect.apply(nativeThen, this, [
        (value: T) => evaluate(onfulfilled, value, false),
        (reason: unknown) => evaluate(onrejected, reason, true),
      ])
      return deferred.receipt as TaskCompletion<TResult1 | TResult2>
    })
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): TaskCompletion<T | TResult> {
    return this.then(undefined, onrejected)
  }

  finally(onfinally?: (() => void) | null): TaskCompletion<T> {
    if (typeof onfinally !== 'function') return this.then()
    return this.then(
      value => join(onfinally()).then(() => value),
      error => join(onfinally()).then(() => { throw error }),
    )
  }
}

function deferredCompletion<T>(node: WaitNode, onError?: (error: unknown) => void) {
  const unit = node.unit
  const resourceOwner = node.resourceOwner
  let settled = false
  let accept!: (value: Awaited<T> | PromiseLike<Awaited<T>>) => void
  let fail!: (reason?: unknown) => void
  const receipt = new TaskCompletion<Awaited<T>>(node, (resolve, reject) => {
    accept = resolve
    fail = reject
  })
  const observe = <R>(execute: () => R): R => asHost(() => executionContext.run({ node, unit, resourceOwner }, execute))
  const finish = (error?: unknown, rejected = false) => {
    if (node.finished) return
    try {
      if (rejected && onError) invoke(unit, () => onError(error))
    } finally {
      finishWaitNode(node)
    }
  }
  const reject = (error: unknown) => observe(() => {
    if (settled) return
    settled = true
    fail(error)
    finish(error, true)
  })
  const resolve = (value: unknown, capturedThen?: Then) => observe(() => {
    if (settled) return
    let then: unknown
    try {
      consume(node, value)
      if (value === receipt) throw new TypeError('A completion cannot resolve to itself')
      if (value && (typeof value === 'object' || typeof value === 'function')) {
        then = capturedThen ?? invoke(unit, () => (value as PromiseLike<unknown>).then)
      }
    } catch (error) {
      reject(error)
      return
    }
    if (typeof then !== 'function') {
      settled = true
      // Native materialization can adopt the object after reading its then again.
      // Keep that read in the unit and wait for the actual receipt settlement.
      invoke(unit, () => accept(value as Awaited<T>))
      if (!value || typeof value !== 'object' && typeof value !== 'function') finish()
      return
    }
    let resolved = false
    const fulfill = (result: unknown) => observe(() => {
      if (resolved) return
      resolved = true
      resolve(result)
    })
    const rejected = (error: unknown) => {
      if (resolved) return
      resolved = true
      reject(error)
    }
    const subscribe = () => {
      try {
        runWithNode(node, () => invoke(unit, () => {
          const result = Reflect.apply(then as Then, value, [fulfill, rejected])
          // Async thenable methods can keep executing after publishing their result.
          if (!(value instanceof Promise) && result instanceof Promise) {
            executeCompletion(createWaitNode(undefined, undefined, undefined, unit), () => result)
          }
        }))
      } catch (error) {
        rejected(error)
      }
    }
    // Native observers register immediately; user subscriptions keep Promise timing.
    if (then === nativeThen) subscribe()
    else queueMicrotask(subscribe)
  })
  // The source observer owns reporting even when callers drop their receipt.
  Reflect.apply(nativeThen, receipt, [
    () => observe(() => finish()),
    (error: unknown) => observe(() => finish(error, true)),
  ])
  return { receipt, resolve, reject, observe }
}

export function executeCompletion<T>(
  node: WaitNode,
  execute: () => T,
  onError?: (error: unknown) => void,
  preserveCallable = false,
): TaskResult<T> {
  return asHost(() => {
    let result: T
    let then: unknown
    try {
      result = runWithNode(node, () => invoke(node.unit, () => {
        const value = execute()
        if (preserveCallable && typeof value === 'function') return value
        try {
          if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
            then = value.then
          }
        } catch {
          // The original value retains its caller-facing throwing getter.
        }
        return value
      }))
    } catch (error) {
      finishWaitNode(node)
      throw error
    }
    if (typeof then !== 'function') {
      finishWaitNode(node)
      return result as TaskResult<T>
    }
    return completion(node, result as PromiseLike<Awaited<T>>, then as Then, onError) as TaskResult<T>
  })
}

export function completion<T>(
  node: WaitNode,
  value: T | PromiseLike<T>,
  capturedThen?: Then,
  onError?: (error: unknown) => void,
): TaskCompletion<Awaited<T>> {
  consume(node, value)
  return asHost(() => {
    const deferred = deferredCompletion<T>(node, onError)
    deferred.resolve(value, capturedThen)
    return deferred.receipt
  })
}

export function operation<T>(execute: () => T, selector?: ScopeSelector): TaskCompletion<Awaited<T>> {
  return invoke(undefined, () => {
    const node = createWaitNode(undefined, undefined, selector)
    return runWithNode(node, () => {
      const deferred = deferredCompletion<T>(node)
      try {
        deferred.resolve(execute())
      } catch (error) {
        deferred.reject(error)
      }
      return deferred.receipt
    })
  })
}

export function lifecycleCompletion<T>(value: PromiseLike<T>, selector: ScopeSelector): TaskCompletion<Awaited<T>> {
  return completion(createWaitNode(undefined, undefined, selector), value)
}

export function runWithCompletion<T>(value: PromiseLike<unknown>, execute: () => T): T {
  if (value instanceof TaskCompletion) return runWithNode(value.node, execute)
  return executionContext.run({ ...executionContext.getStore(), node: undefined }, execute)
}

export function join<T>(value: T | PromiseLike<T>): Promise<Awaited<T>> {
  const current = executionContext.getStore()
  if (current?.node) consume(current.node, value)
  return asHost(() => {
    const node = createWaitNode(undefined, undefined, undefined, current?.unit)
    if (current?.node) addDependency(current.node, node)
    const deferred = deferredCompletion<T>(node)
    deferred.resolve(value)
    return deferred.receipt
  })
}
