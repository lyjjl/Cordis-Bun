import { Awaitable, defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context.ts'
import { Plugin } from './registry.ts'
import { buildOuterStack, composeError, DisposableList, getTraceable, isConstructor, isObject, symbols } from './utils.ts'
import { activation, locate } from './reflect.ts'
import type { Impl } from './reflect.ts'
import { StandardSchemaV1 } from '@standard-schema/spec'
import { TaskInfo, TaskResult, TaskScope } from './tasks.ts'
import { completion, createWaitNode, finishWaitNode, join, lifecycleCompletion, operation, runWithCompletion, runWithNode } from './completion.ts'
import { ExecutionUnit, invoke } from './execution.ts'
import { ResourceScope } from './resources.ts'
import type { ScopeDiagnostics } from './resources.ts'

declare module './context.ts' {
  export interface Context extends Pick<Fiber, 'effect' | 'task' | 'join'> {
    fiber: Fiber
  }
}

const kValidationError = Symbol.for('ValidationError')

export class ValidationError extends TypeError {
  name = 'ValidationError'

  constructor(public issues: readonly StandardSchemaV1.Issue[]) {
    super(`invalid config:\n` + issues.map(issue => {
      if (issue.path?.length) {
        return `  - ${issue.message} (at ${ValidationError.formatPath(issue.path)})`
      } else {
        return `  - ${issue.message}`
      }
    }).join('\n'))
  }

  static is(error: unknown): error is ValidationError {
    return !!error?.[kValidationError]
  }

  static normalizePath(path: StandardSchemaV1.Issue['path'] = []) {
    return path.map(segment => typeof segment === 'object' ? segment.key : segment)
  }

  static formatPath(path: StandardSchemaV1.Issue['path']) {
    return ValidationError.normalizePath(path).map(String).join('.')
  }
}

Object.defineProperty(ValidationError.prototype, kValidationError, {
  value: true,
})

export function resolveConfig(runtime: Plugin.Runtime, config: any) {
  if (!runtime.Config) return config
  // TODO: async validation
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) {
    throw new TypeError('Async config validation is not supported')
  }
  if (result.issues) {
    throw new ValidationError(result.issues)
  } else {
    return result.value
  }
}

/** Callable cleanup whose thenable waits for the effect's actual initialization. */
export interface AsyncDisposable<T extends Awaitable<void> = Awaitable<void>> extends PromiseLike<() => T> {
  (): T
}

export type Disposable<T = any> = () => T

export type Effect<T = any> =
  | SyncEffect<T>
  | AsyncEffect<T>

type SyncEffect<T = any> =
  | Disposable<T>
  | Iterable<Disposable<T>, void, void>

type AsyncEffect<T = any> =
  | Promise<Disposable<T>>
  | AsyncIterable<Disposable<T>, void, void>

export interface EffectMeta {
  label: string
  children: EffectMeta[]
}

interface EffectRunner<T> {
  epoch: T
  execute: () => any
  collect: (dispose: Disposable) => void
  getOuterStack: () => string[]
  execution?: ExecutionUnit
}

export class Activation {
  readonly resources: ResourceScope
  readonly tasks: TaskScope
  readonly provisions = new Set<Impl>()
  ctx!: Context
  committed: Readonly<Dict<Impl>> | undefined
  teardownTasks: TaskScope | undefined
  teardownClosed = false
  closing = false
  finished = false
  error: AggregateError | undefined
  cleanupOwner: Activation | undefined

  constructor(
    readonly owner: Fiber,
    readonly parent: Activation | undefined,
    readonly inject: Dict,
    readonly optional: Dict,
    execution?: ExecutionUnit,
    readonly generation = 0,
  ) {
    this.resources = new ResourceScope(owner.runtime?.name ?? 'root', execution)
    this.tasks = new TaskScope(owner, execution, this)
  }

  get accepting() {
    return !this.closing && !this.finished && this.tasks.accepting
  }
}

export enum FiberState {
  PENDING,
  LOADING,
  ACTIVE,
  FAILED,
  DISPOSED,
  UNLOADING,
}

const kTargetOwner = Symbol('cordis.target.owner')
const kTargetIntent = Symbol('cordis.target.intent')
const kTargetError = Symbol('cordis.target.error')
const kTargetHistory = Symbol('cordis.target.history')

export interface FiberTarget {
  readonly [kTargetOwner]: Fiber
  readonly [kTargetIntent]: number
  readonly [kTargetError]: unknown
  readonly [kTargetHistory]: Activation | undefined
}

export class CordisError extends Error {
  constructor(public code: CordisError.Code, message?: string) {
    super(message ?? CordisError.Code[code])
  }
}

export namespace CordisError {
  export type Code = keyof typeof Code

  export const Code = {
    INACTIVE_EFFECT: 'cannot create effect on inactive context',
  } as const
}

const INACTIVE = '__INACTIVE__'
const completedEffects = new WeakSet<Disposable>()
const instanceEffects = new WeakMap<EffectMeta, Fiber>()

export interface DependencyDiagnostics {
  readonly name: string
  readonly optional: boolean
  readonly resolved: boolean
  readonly binding: number | undefined
  readonly owner: number | undefined
  readonly ownerName: string | undefined
  readonly targetBinding: number | undefined
}

export interface FiberDiagnostics {
  readonly id: number
  readonly uid: number | null
  readonly name: string
  readonly state: FiberState
  readonly config: unknown
  readonly effective: unknown
  readonly revision: number
  readonly lastError: unknown
  readonly resources: ScopeDiagnostics
  readonly tasks: readonly TaskInfo[]
  readonly leases: number
  readonly execution: string | undefined
  readonly provided: readonly { name: string; binding: number; available: boolean }[]
  readonly dependencies: readonly DependencyDiagnostics[]
}

export class Fiber {
  public uid: number | null
  public readonly id: number
  public ctx: Context
  public state = FiberState.PENDING
  public readonly dispose: () => Promise<void>
  get committed() { return this._activation.committed }
  get provisions() { return this._activation.provisions }
  public inertia: Promise<void> | undefined

  public readonly _hooks: Dict<DisposableList<Function>> = Object.create(null)
  public readonly _disposables = new DisposableList<Disposable>()

  // Same as `this.ctx`, but with a more specific type.
  protected context: Context

  private _error: any
  private _revision = 0
  private _targetRevision = 0
  private _intentRevision = 0
  private _effective: unknown
  private _acceptedConfig: unknown
  private _runner: EffectRunner<string>
  private _store: Dict<Impl> = Object.create(null)
  private _dependencies: readonly string[]
  private _release: (() => void) | undefined
  private _remove: (() => void) | undefined
  private _stopTask: Promise<void> | undefined
  private _cleanupErrors: unknown[] = []
  private _cleanupError: AggregateError | undefined
  // Diagnostics outlive activations; ownership and binding views do not.
  private _activation: Activation
  private _updateError: unknown
  private _children = new Set<Fiber>()
  private readonly _owner: Fiber | undefined
  private _execution: ExecutionUnit | undefined
  private _targetExecution: ExecutionUnit | undefined
  private _releaseExecution: (() => void) | undefined
  private _suspended = false
  // Definition replacement renews activation even when the code unit stays the same.
  private _replacementPending = false

  constructor(
    public parent: Context,
    public config: any,
    public inject: Dict<any>,
    public runtime: Plugin.Runtime | null,
    getOuterStack: () => string[],
    execution?: ExecutionUnit,
    public optional: Dict<unknown> = Object.create(null),
  ) {
    this._execution = this._targetExecution = execution
    this._dependencies = [...new Set([...Object.keys(this.inject), ...Object.keys(this.optional)])]
    this._activation = new Activation(this, parent[activation], this.inject, this.optional, execution)
    const collect = (dispose: Disposable) => {
      if (!dispose[symbols.effect] || !this._disposables.has(dispose)) this._disposables.push(dispose)
    }
    let disposeOwned: (() => Promise<void>) | undefined
    try {
      this._releaseExecution = execution?.retain()
      if (runtime) {
        const owner = this._owner = parent.fiber
        this.uid = this.id = parent.registry.counter
        this.ctx = this.context = parent.extend({
          fiber: this,
          resources: this._activation.resources,
          [activation]: this._activation,
        })
        this._activation.ctx = this.ctx
        Object.defineProperty(this.ctx, 'resources', { value: this._activation.resources, writable: false, configurable: false })
        this._runner = {
          epoch: INACTIVE,
          getOuterStack,
          execution,
          execute: function (this: Fiber) {
            const { callback } = this.runtime!
            const config = this._resolve(this.config)
            if (isConstructor(callback)) {
              // eslint-disable-next-line new-cap
              const instance = new callback(this.ctx, config)
              for (const hook of instance?.[symbols.initHooks] ?? []) hook()
              const initialize = instance?.[symbols.init]
              if (initialize != null) return Reflect.apply(initialize, instance, [])
              if (instance instanceof callback || instance?.[symbols.tracker]) return
              if (typeof instance === 'function' || isObject(instance) && (
                'then' in instance || Symbol.iterator in instance || Symbol.asyncIterator in instance
              )) return instance
            } else {
              return callback(this.ctx, config)
            }
          },
          collect,
        }
        this.dispose = disposeOwned = owner._effect(() => {
          this._remove = runtime.fibers.push(this)
          owner._children.add(this)
          return () => this._stop()
        }, 'ctx.plugin()', promise => lifecycleCompletion(promise, this._selectAffectedScopes()))
        instanceEffects.set(this.dispose[symbols.effect], this)
        // Dependency checks can stop the owner synchronously.
        for (const name of this._dependencies) this._checkImpl(name)
        this.assertActive()
        this.context.emit('internal/plugin', this)
        try {
          this._refresh()
        } catch (error) {
          this.ctx.logger.error(error)
          this._error = error
        }
      } else {
        this.uid = this.id = 0
        this.ctx = this.context = this._activation.ctx = parent
        Object.defineProperty(parent, 'resources', { value: this._activation.resources, enumerable: true })
        Object.defineProperty(parent, activation, { value: this._activation })
        this.state = FiberState.ACTIVE
        this._activation.committed = Object.create(null)
        this._runner = {
          epoch: '0',
          getOuterStack,
          execute: () => {},
          collect,
        }
        this.dispose = () => this._stop()
      }
    } catch (error) {
      if (disposeOwned) {
        disposeOwned().catch(() => {})
      } else {
        this._activation.resources.dispose().catch(error => parent.logger.error(error))
        this._releaseCode()
      }
      throw error
    }
  }

  get name() {
    let fiber: Fiber = this
    do {
      if (fiber.runtime?.name) return fiber.runtime.name
      fiber = fiber.parent.fiber
    } while (fiber !== fiber.parent.fiber)
    return 'root'
  }

  get execution(): ExecutionUnit | undefined {
    return this._execution
  }

  private _assertAlive() {
    if (this.uid !== null) return
    throw new CordisError('INACTIVE_EFFECT')
  }

  assertActive() {
    this._assertAlive()
    if (this._activation.closing) throw new CordisError('INACTIVE_EFFECT')
  }

  get accepting() {
    return this.uid !== null && this._activation.accepting
  }

  get signal() {
    return this._activation.tasks.signal
  }

  task<T>(execute: (signal: AbortSignal) => T, label?: string): TaskResult<T> {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    return fiber._activation.tasks.run(execute, label)
  }

  join<T>(value: T): Promise<Awaited<T>> {
    return join(value)
  }

  getTasks(): readonly TaskInfo[] {
    const tasks = this._activation.tasks.getTasks()
    return this._activation.teardownTasks ? [...tasks, ...this._activation.teardownTasks.getTasks()] : tasks
  }

  get effective() {
    return this._effective
  }

  get revision() {
    return this._targetRevision
  }

  get lastError() {
    return this._error ?? this._cleanupError ?? this._updateError
  }

  diagnostics(): FiberDiagnostics {
    const resources = this._activation.resources.diagnostics()
    const { inject, optional } = this._activation
    const names = new Set([...Object.keys(inject), ...Object.keys(optional)])
    return {
      id: this.id,
      uid: this.uid,
      name: this.name,
      state: this.state,
      config: this.config,
      effective: this.effective,
      revision: this.revision,
      lastError: this.lastError,
      resources,
      tasks: this.getTasks(),
      leases: resources.leases,
      execution: this._execution?.name,
      provided: [...this.provisions].map(impl => ({
        name: impl.name,
        binding: impl.uid,
        available: impl.ctx.isolate(impl.name, impl.isolate).reflect._getImpl(impl.name) === impl,
      })),
      dependencies: [...names].map(name => {
        const impl = this.committed?.[name]
        return {
          name,
          optional: !(name in inject),
          resolved: !!impl,
          binding: impl?.uid,
          owner: impl?.ctx.fiber.id,
          ownerName: impl?.ctx.fiber.name,
          targetBinding: this._store[name]?.uid,
        }
      }),
    }
  }

  private _clearErrors() {
    this._error = undefined
    this._cleanupErrors.length = 0
    this._cleanupError = undefined
    this._updateError = undefined
  }

  _collectAffectedFibers(target: Set<Fiber>, includeDependents = true): void {
    const pending: Fiber[] = [this]
    const visited = new Set<Fiber>()
    while (pending.length) {
      const fiber = pending.pop()!
      if (visited.has(fiber)) continue
      visited.add(fiber)
      target.add(fiber)
      pending.push(...fiber._children)
      if (includeDependents) {
        for (const impl of fiber.provisions) pending.push(...impl.dependents)
      }
    }
  }

  private _selectAffectedScopes() {
    const fibers = new Set<Fiber>()
    this._collectAffectedFibers(fibers)
    const captured = new Map([...fibers].map(fiber => [fiber, fiber._activation]))
    return (scope: TaskScope) => {
      const record = scope.activation
      if (!record || record.accepting) return false
      for (let current: Activation | undefined = record; current; current = current.parent) {
        const expected = captured.get(current.owner)
        if (expected) return expected === current
        // A late ownership path admits its original activations, not replacements.
        if (current.generation !== 0) return false
      }
      return false
    }
  }

  acceptsTasksFrom(caller: Context) {
    if (this.accepting) return true
    if (this._activation.teardownClosed) return false
    for (const impl of this.provisions) {
      if (locate(caller, impl.name)?.impl === impl) return true
    }
    return false
  }

  _taskFrom<T>(
    caller: Context,
    execute: (signal: AbortSignal) => T,
    label?: string,
    onError?: (error: unknown) => void,
  ): TaskResult<T> {
    if (this.accepting) return this._activation.tasks.run(execute, label, onError)
    if (!this.acceptsTasksFrom(caller)) throw new CordisError('INACTIVE_EFFECT')
    this._activation.teardownTasks ??= new TaskScope(this, this._execution, this._activation)
    return this._activation.teardownTasks.run(execute, label, onError)
  }

  private _close() {
    const wasAccepting = this._activation.tasks.accepting
    this._activation.closing = true
    this._activation.resources.retire()
    this._activation.tasks.stop()
    if (wasAccepting && this.state === FiberState.ACTIVE) this._notifyProvisions()
    for (const child of this._children) {
      const activation = child._activation
      if (!activation.finished) activation.cleanupOwner = this._activation
      child._close()
    }
  }

  private _stop(): Promise<void> {
    return invoke(undefined, () => {
      if (this._stopTask) return this._stopTask
      const activation = this._activation
      const pendingCleanup = !activation.finished
      const completion = Promise.withResolvers<void>()
      this._stopTask = lifecycleCompletion(completion.promise, this._selectAffectedScopes())
      completion.promise.catch(() => {})
      runWithCompletion(this._stopTask, () => {
        this.uid = null
        this._activation.closing = true
        if (this.runtime) {
          this._remove!()
          if (!this.runtime.fibers.length) this.ctx.registry._unregister(this.runtime)
          this.context.emit('internal/plugin', this)
        }
        this._setEpoch(INACTIVE)
        if (!this.inertia && pendingCleanup) {
          this._updateState(() => {
            this.inertia = this._unload()
            return FiberState.UNLOADING
          })
        }
        this._close()
        ;(async () => {
          while (this.inertia) await this.inertia
          await this._activation.tasks.stop()
          this._owner?._children.delete(this)
          this._updateState(() => {})
          if (activation.error && (pendingCleanup || activation.cleanupOwner && !activation.cleanupOwner.finished)) {
            throw activation.error
          }
        })().then(() => {
          completion.resolve()
          this._releaseCode()
        }, (error) => {
          completion.reject(error)
          this._releaseCode()
        })
      })
      return this._stopTask
    })
  }

  private _releaseCode() {
    const release = this._releaseExecution
    this._releaseExecution = undefined
    this._execution = this._targetExecution = undefined
    if (this._runner) this._runner.execution = undefined
    release?.()
  }

  private _resolve(config: any) {
    return this.context.waterfall('internal/config', this, () => config)
  }

  private _execute<T>(runner: EffectRunner<T>) {
    const oldEpoch = runner.epoch
    const unit = runner.execution
    return invoke(undefined, () => composeError((info) => {
      const safeCollect = (dispose: void | Disposable) => {
        if (typeof dispose === 'function') {
          runner.collect(dispose)
        } else if (!isNullable(dispose)) {
          throw new TypeError('Invalid effect')
        }
      }
      const effect: Effect = invoke(unit, () => runner.execute.call(this))
      if (typeof effect === 'function') {
        return runner.collect(effect)
      } else if (isNullable(effect)) {
        // return
      } else if (!isObject(effect)) {
        throw new TypeError('Invalid effect')
      } else if ('then' in effect) {
        return completion(createWaitNode(undefined, undefined, undefined, unit), effect).then(safeCollect)
      } else if (Symbol.iterator in effect) {
        info.error = new Error()
        const iter = invoke(unit, () => effect[Symbol.iterator]())
        while (true) {
          const result = invoke(unit, () => iter.next())
          safeCollect(result.value)
          if (result.done) return
        }
      } else if (Symbol.asyncIterator in effect) {
        const iter = invoke(unit, () => effect[Symbol.asyncIterator]())
        return (async () => {
          // force async stack trace
          await Promise.resolve()
          info.error = new Error()
          let done = false
          try {
            while (runner.epoch === oldEpoch) {
              const pending = invoke(unit, () => iter.next())
              const result = await completion(createWaitNode(undefined, undefined, undefined, unit), pending)
              done = !!result.done
              safeCollect(result.value)
              if (done) return
            }
          } finally {
            // close the iterator so that its finally blocks run
            if (!done) {
              const pending = invoke(unit, () => iter.return?.())
              await completion(createWaitNode(undefined, undefined, undefined, unit), pending)
            }
          }
        })()
      } else {
        throw new TypeError('Invalid effect')
      }
    }, runner.getOuterStack))
  }

  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
  effect(execute: () => Effect, label = 'anonymous'): AsyncDisposable<Promise<void>> {
    return this._effect(execute, label)
  }

  private _effect(
    execute: () => Effect,
    label: string,
    wrapCompletion?: (value: Promise<void>) => Promise<void>,
  ): AsyncDisposable<Promise<void>> {
    return invoke(undefined, () => {
      this.assertActive()
      const unit = this._execution
      const disposables: Disposable[] = []
      let task: void | Promise<void>
      let initialized = false
      let initializationFailed = false
      let initializationError: unknown
      let initialization: PromiseWithResolvers<void> | undefined
      let completion: PromiseWithResolvers<void> | undefined
      let completed: Promise<void> | undefined
      const drainCallbacks = () => this._activation.teardownTasks?.pending ? this._activation.teardownTasks.drain() : undefined
      const cleanup = () => {
        const errors: unknown[] = []
        let pending: Promise<void> | undefined
        const collectError = (error: unknown) => {
          if (error instanceof AggregateError) errors.push(...error.errors)
          else errors.push(error)
        }
        for (const dispose of disposables.splice(0).reverse()) {
          const run = (): Promise<void> | undefined => {
            try {
              const result = invoke(unit, dispose)
              if (!completedEffects.has(dispose) && isObject(result) && 'then' in result) {
                return invoke(unit, () => join(result as PromiseLike<void>)).then(drainCallbacks, (error) => {
                  collectError(error)
                  return drainCallbacks()
                })
              }
            } catch (error) {
              collectError(error)
            }
            return drainCallbacks()
          }
          pending = pending ? pending.then(run) : run()
        }
        const finish = () => {
          remove()
          if (errors.length) {
            completion!.reject(new AggregateError(errors, `Cleanup of effect ${label} failed`))
          } else if (initializationFailed) {
            completion!.reject(initializationError)
          } else {
            completedEffects.add(wrapper)
            completion!.resolve()
          }
        }
        if (pending) pending.then(finish)
        else finish()
      }

      const meta: EffectMeta = { label, children: [] }
      const runner: EffectRunner<boolean> = {
        execute,
        epoch: true,
        execution: unit,
        collect: (dispose) => {
          disposables.push(dispose)
          this._disposables.delete(dispose)
          if (dispose[symbols.effect]) {
            meta.children.push(dispose[symbols.effect])
          }
        },
        getOuterStack: buildOuterStack(),
      }

      const wrapper = defineProperty(() => invoke(undefined, () => {
        if (completion) return completed!
        completion = Promise.withResolvers<void>()
        completed = wrapCompletion?.(completion.promise) ?? completion.promise
        completion.promise.catch(() => {})
        runner.epoch = false
        runWithCompletion(completed, () => {
          if (initialized) {
            cleanup()
          } else {
            initialization ??= Promise.withResolvers<void>()
            initialization.promise.then(cleanup)
          }
        })
        return completed
      }), symbols.effect, meta) as AsyncDisposable<Promise<void>>
      // Awaiting an effect yields a plain disposer rather than its thenable wrapper.
      const disposeAsync = () => wrapper()
      wrapper.then = (onFulfilled, onRejected) => {
        return operation(async () => {
          await task
          return disposeAsync
        }).then(onFulfilled, onRejected)
      }
      const remove = this._disposables.push(wrapper)
      const finishInitialization = () => {
        initialized = true
        initialization?.resolve()
      }
      try {
        task = this._execute(runner)
      } catch (reason) {
        finishInitialization()
        wrapper().catch(error => this.ctx.logger.error(error))
        throw reason
      }
      if (task) {
        task.then(finishInitialization, (reason) => {
          initializationFailed = true
          initializationError = reason
          finishInitialization()
          wrapper().catch(error => {
            if (error !== reason) this.ctx.logger.error(error)
          })
        })
      } else {
        finishInitialization()
      }
      return wrapper
    })
  }

  getEffects() {
    return [...this._disposables]
      .map<EffectMeta>(dispose => dispose[symbols.effect])
      .filter(Boolean)
  }

  private _getState() {
    if (this.uid === null) return FiberState.DISPOSED
    if (this._error) return FiberState.FAILED
    if (this._runner.epoch !== INACTIVE) return FiberState.ACTIVE
    return FiberState.PENDING
  }

  private _updateState(callback: () => void | FiberState) {
    const oldState = this.state
    this.state = callback() ?? this._getState()
    if (oldState === this.state) return
    // FIXME internal/fiber-info
    this.context.emit('internal/status', this, oldState)

    // only notify changes between ACTIVE and NON-ACTIVE states
    if (oldState !== FiberState.ACTIVE && this.state !== FiberState.ACTIVE) return
    this._notifyProvisions()
  }

  private _notifyProvisions() {
    if (this.state === FiberState.ACTIVE && this.accepting) {
      for (const impl of this.provisions) impl.published = true
    }
    for (const impl of this.provisions) {
      impl.ctx.isolate(impl.name, impl.isolate).reflect.notify([impl.name])
    }
  }

  _checkImpl(name: string) {
    const impl = this.ctx.reflect._getImpl(name, true, this)
    if (!impl) return delete this._store[name]
    try {
      if (impl.check && !invoke(impl.ctx.fiber.execution, () => impl.check!.call(getTraceable(this.ctx, impl.value)))) {
        return delete this._store[name]
      }
    } catch (error) {
      impl.ctx.logger.error(error)
      return delete this._store[name]
    }
    this._store[name] = impl
  }

  _captureTarget(): FiberTarget {
    const fiber = this.ctx.fiber
    return {
      [kTargetOwner]: fiber,
      [kTargetIntent]: fiber._intentRevision,
      [kTargetError]: fiber._error,
      [kTargetHistory]: fiber._activation.finished ? fiber._activation : undefined,
    }
  }

  private _targetError(target?: FiberTarget): unknown {
    if (!target || target[kTargetOwner] !== this || target[kTargetIntent] !== this._intentRevision) return
    return target[kTargetError]
  }

  _hasTargetError(target?: FiberTarget): boolean {
    const fiber = this.ctx.fiber
    return !!fiber._error && fiber._error === fiber._targetError(target)
  }

  _replace(
    runtime: Plugin.Runtime,
    inject: Dict,
    execution?: ExecutionUnit,
    optional: Dict<unknown> = Object.create(null),
    target?: FiberTarget,
  ) {
    invoke(undefined, () => {
      if (this.uid === null) return
      if (runtime !== this.runtime) {
        this._remove!()
        this._remove = runtime.fibers.push(this)
        this.runtime = runtime
      }
      this.inject = inject
      this.optional = optional
      this._dependencies = [...new Set([...Object.keys(inject), ...Object.keys(optional)])]
      this._targetExecution = execution
      this._replacementPending = true
      this._suspended = false
      this.context.emit('internal/replace', this)
      this._store = Object.create(null)
      for (const name of this._dependencies) {
        this._checkImpl(name)
      }
      if (target?.[kTargetOwner] === this) this._error = this._targetError(target)
      else this._clearErrors()
      this._revision++
      if (this._error) this._setEpoch(INACTIVE)
      if (this._replacementPending && this._runner.epoch === INACTIVE && !this.inertia) {
        this._close()
        this._updateState(() => {
          this.inertia = this._unload()
          return FiberState.UNLOADING
        })
      }
      this._refresh()
    })
  }

  _suspend(): Promise<void> {
    const fiber = this.ctx.fiber
    return operation(async () => {
      fiber._assertAlive()
      const activation = fiber._activation.tasks
      const cleanup = fiber._activation
      const pendingCleanup = !cleanup.finished
      fiber._suspended = true
      fiber._setEpoch(INACTIVE)
      if (!fiber.inertia && pendingCleanup) {
        fiber._updateState(() => {
          fiber.inertia = fiber._unload()
          return FiberState.UNLOADING
        })
      }
      fiber._close()
      while (fiber.inertia) await fiber.inertia
      await activation.stop()
      if (cleanup.error && (pendingCleanup || cleanup.cleanupOwner && !cleanup.cleanupOwner.finished)) {
        throw cleanup.error
      }
    }, fiber._selectAffectedScopes())
  }

  _resume(target?: FiberTarget): Promise<void> {
    const fiber = this.ctx.fiber
    return operation(async () => {
      fiber._assertAlive()
      // A definition replacement may already have selected this restored target.
      if (!target || fiber._suspended) {
        fiber._suspended = false
        fiber._error = fiber._targetError(target)
        if (!fiber.inertia && !fiber._error) fiber._openActivation()
        fiber._refresh()
        if (!fiber.inertia) fiber._updateState(() => {})
      }
      await fiber._awaitTarget(target)
    }, fiber._selectAffectedScopes())
  }

  _refresh() {
    if (this.uid === null) return
    let epoch = this._suspended ? INACTIVE : `${this._revision}`
    for (const name of this._suspended ? [] : this._dependencies) {
      const impl = this._store[name]
      if (!impl && name in this.inject) {
        epoch = INACTIVE
        break
      }
      epoch += ':' + (impl?.uid ?? '-')
    }
    if (this._owner && !this._owner.accepting) {
      if (epoch === this._runner.epoch) return
      epoch = INACTIVE
    }
    this._setEpoch(epoch)
  }

  private _setEpoch(epoch: string) {
    invoke(undefined, () => {
      const oldEpoch = this._runner.epoch
      if (epoch === oldEpoch) return
      // Explicit updates and restarts establish a new activation target.
      if (this._error && epoch !== INACTIVE) return
      this._targetRevision++
      this._runner.epoch = epoch
      if (oldEpoch !== INACTIVE) this._activation.closing = true
      if (this.inertia) {
        if (oldEpoch !== INACTIVE) this._close()
        return
      }
      this._updateState(() => {
        if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
          this.inertia = this._reload()
          return FiberState.LOADING
        } else {
          this.inertia = this._unload()
          return FiberState.UNLOADING
        }
      })
      if (oldEpoch !== INACTIVE) this._close()
    })
  }

  private _openActivation() {
    this._replacementPending = false
    if (this._execution !== this._targetExecution) {
      const release = this._releaseExecution
      this._execution = this._targetExecution
      this._releaseExecution = this._execution?.retain()
      this._runner.execution = this._execution
      release?.()
    }
    this._activation.closing = false
    if (!this._activation.finished) return
    this._activation = new Activation(
      this, this.parent[activation], this.inject, this.optional, this._execution, this._activation.generation + 1,
    )
    this.ctx = this.context = this.parent.extend({
      fiber: this,
      resources: this._activation.resources,
      [activation]: this._activation,
    })
    this._activation.ctx = this.ctx
    Object.defineProperty(this.ctx, 'resources', { value: this._activation.resources, writable: false, configurable: false })
    if (this._error) this._close()
  }

  private async _reload() {
    this._openActivation()
    const committed: Dict<Impl> = Object.assign(Object.create(null), this._store)
    this._activation.committed = committed
    for (const impl of Object.values(committed)) {
      if (impl.ctx.fiber === this) continue
      impl.dependents.add(this)
    }
    const oldEpoch = this._runner.epoch
    try {
      await Promise.resolve()
      if (this._runner.epoch === oldEpoch) {
        this._acceptedConfig = this.config
        await this._execute(this._runner)
      }
    } catch (reason) {
      // impl guarantees that the error is non-null (?)
      this.ctx.logger.error(reason)
      // A superseded load still needs cleanup, but cannot fail the new target.
      if (this._runner.epoch === oldEpoch) {
        this._error = reason
        this._runner.epoch = INACTIVE
        this._close()
      }
    }
    this._updateState(() => {
      if (this._runner.epoch === oldEpoch) {
        this._effective = this._acceptedConfig
        this.inertia = undefined
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  private async _drainActivation() {
    const activation = this._activation
    if (activation.finished) return
    const unit = this._execution
    // Publish the non-active state before cancellation can reenter child disposal.
    await Promise.resolve()
    this._close()
    await activation.tasks.stop()
    // Dependents are notified when this fiber leaves ACTIVE, but may still
    // access its services during their own teardown, so the effects of this
    // fiber are only disposed after every dependent has unloaded.
    while ([...activation.provisions].some(impl => impl.dependents.size)) {
      const drain = Promise.withResolvers<void>()
      this._release = drain.resolve
      await drain.promise
    }
    this._release = undefined
    await activation.resources._waitForLeases()
    const childEffects: Disposable[] = []
    const resourceEffects: Disposable[] = []
    const containsChild = (meta: EffectMeta | undefined): boolean => {
      if (!meta) return false
      const instance = instanceEffects.get(meta)
      if (instance && this._children.has(instance)) return true
      return meta.children.some(containsChild)
    }
    for (const dispose of this._disposables.clear()) {
      ;(containsChild(dispose[symbols.effect]) ? childEffects : resourceEffects).push(dispose)
    }
    const cleanup = (dispose: Disposable) => composeError(async (info) => {
      await Promise.resolve()
      info.error = new Error()
      await invoke(unit, () => join(dispose()))
    }, this._runner.getOuterStack)
    // A compound keeps its own reverse order. Independent child scopes drain
    // together while their inherited provider resources remain available.
    const results = await Promise.allSettled(childEffects.map(cleanup))
    activation.teardownClosed = true
    await activation.teardownTasks?.stop()
    results.push(...await Promise.allSettled([activation.resources.dispose()]))
    results.push(...await Promise.allSettled(resourceEffects.map(cleanup)))
    const errors: unknown[] = []
    for (const result of results) {
      if (result.status !== 'rejected') continue
      const error = result.reason
      errors.push(...(error instanceof AggregateError ? error.errors : [error]))
    }
    if (errors.length) {
      activation.error = new AggregateError(errors, `Cleanup of ${this.name} failed`)
      this._cleanupErrors.push(...errors)
      this._cleanupError = this._cleanupErrors.length === errors.length
        ? activation.error
        : new AggregateError(this._cleanupErrors, activation.error.message)
      this.ctx.logger.error(this._cleanupError)
    }
    activation.provisions.clear()
    // release the providers waiting for this fiber to unload
    for (const impl of Object.values(activation.committed ?? {})) {
      if (!impl.dependents.delete(this) || impl.dependents.size) continue
      impl.release?.()
      impl.ctx.fiber._release?.()
    }
    activation.committed = undefined
    activation.finished = true
  }

  private async _unload() {
    await this._drainActivation()
    this._updateState(() => {
      if (this._runner.epoch === INACTIVE) {
        this.inertia = undefined
        if (!this._suspended && this.uid !== null && this._replacementPending) {
          this._openActivation()
          if (this._error) {
            this.inertia = this._unload()
            return FiberState.UNLOADING
          }
        }
      } else {
        this.inertia = this._reload()
        return FiberState.LOADING
      }
    })
  }

  await() {
    return this._awaitTarget()
  }

  private _awaitTarget(target?: FiberTarget) {
    const fiber = this.ctx.fiber
    const history = fiber._hasTargetError(target) ? target?.[kTargetHistory] : undefined
    const records = new Set<Activation>(fiber._activation === history ? [] : [fiber._activation])
    return operation(async () => {
      while (fiber.inertia) {
        await fiber.inertia
        if (fiber._activation !== history) records.add(fiber._activation)
      }
      if (fiber._error && !fiber._hasTargetError(target)) throw fiber._error
      const failures = [...records].flatMap(record => record.error ? [record.error] : [])
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures.flatMap(error => error.errors), `Cleanup of ${fiber.name} failed`)
      return fiber
    }, fiber._selectAffectedScopes())
  }

  restart() {
    const fiber = this.ctx.fiber
    return operation(async () => {
      fiber._assertAlive()
      fiber._intentRevision++
      fiber._clearErrors()
      fiber._revision++
      if (!fiber.inertia) fiber._openActivation()
      fiber._refresh()
      await fiber.await()
    }, fiber._selectAffectedScopes())
  }

  update(config: any, noSave = false): Awaitable<void> {
    const fiber = this.ctx.fiber
    const node = createWaitNode(undefined, undefined, fiber._selectAffectedScopes())
    try {
      const result = runWithNode(node, () => invoke(undefined, () => fiber._update(config, noSave)))
      if (result === undefined) {
        finishWaitNode(node)
        return
      }
      return completion(node, result)
    } catch (error) {
      finishWaitNode(node)
      throw error
    }
  }

  private _update(config: unknown, noSave: boolean): Awaitable<void> {
    const fiber = this.ctx.fiber
    fiber._assertAlive()
    const loaded = fiber._runner.epoch !== INACTIVE
    const resolved = loaded ? fiber._resolve(config) : undefined
    if (!noSave) fiber.context.emit('internal/commit', fiber, config)
    fiber.config = config
    fiber._intentRevision++
    fiber._clearErrors()
    const revision = ++fiber._targetRevision
    const epoch = fiber._runner.epoch
    const restart = () => fiber.restart()
    const fail = (reason: unknown): never => {
      if (fiber.uid !== null && fiber._targetRevision === revision && fiber._runner.epoch === epoch) {
        fiber._updateError = reason
      }
      throw reason
    }
    let result: Awaitable<void>
    try {
      result = loaded
        ? fiber.context.waterfall(fiber, 'internal/update', resolved, restart)
        : restart()
    } catch (reason) {
      return fail(reason)
    }
    const accept = () => {
      if (fiber.uid === null || fiber._targetRevision !== revision || fiber._runner.epoch !== epoch) return
      fiber._acceptedConfig = config
      if (fiber.state === FiberState.ACTIVE) fiber._effective = config
    }
    if (result === undefined) {
      accept()
      return
    }
    const task = Promise.resolve(result).then(accept, fail)
    // Dropped updates remain handled; awaited callers receive the operation error.
    task.catch(() => {})
    return task
  }
}
