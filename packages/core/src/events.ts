import { Awaitable, defineProperty } from 'cosmokit'
import { createWaitNode, executeCompletion, join, operation, TaskCompletion } from './completion.ts'
import { Context } from './context.ts'
import { Fiber, FiberState, resolveConfig } from './fiber.ts'
import { DisposableList, symbols } from './utils.ts'
import { executionContext, ExecutionUnit, invoke } from './execution.ts'

export function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

export type Parameters<F> = F extends (...args: infer P) => any ? P : never
export type ReturnType<F> = F extends (...args: any) => infer R ? R : never
export type ThisType<F> = F extends (this: infer T, ...args: any) => any ? T : never

const listenerUnits = new WeakMap<Function, ExecutionUnit | undefined>()

export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'

declare module './context.ts' {
  export interface Context {
    /* eslint-disable max-len */
    parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): TaskCompletion<void>
    parallel<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): TaskCompletion<void>
    emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
    emit<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): void
    serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): TaskCompletion<Awaited<ReturnType<Events[K]>>>
    serial<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): TaskCompletion<Awaited<ReturnType<Events[K]>>>
    bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    bail<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    waterfall<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
    once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
    /* eslint-enable max-len */
  }
}

export interface EventOptions {
  prepend?: boolean
  global?: boolean
}

export interface Hook extends EventOptions {
  ctx: Context
  callback: (...args: any[]) => any
  label?: string
  onError?: (error: unknown) => void
  execution?: ExecutionUnit
  removed?: boolean
}

export class EventsService {
  _hooks: Record<keyof any, Hook[]> = Object.create(null)

  constructor(private ctx: Context) {
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })

    this.on('internal/listener', function (this: Context, name, listener, options: EventOptions) {
      if (name === 'internal/update' && !options.global) {
        const hooks = this.fiber._hooks['internal/update'] ??= new DisposableList()
        const unit = listenerUnits.get(listener)
        const method = options.prepend ? 'unshift' : 'push'
        return this.fiber.effect(() => {
          const release = unit && unit !== this.fiber.execution ? unit.retain() : undefined
          let removed = false
          const dispose = hooks[method](function (this: Fiber, config: any, next: () => any) {
            return removed ? next() : invoke(undefined, () => executeCompletion(
              createWaitNode(undefined, undefined, undefined, unit),
              () => listener.call(this, config, next),
            ))
          })
          return () => {
            removed = true
            const result = dispose()
            release?.()
            return result
          }
        }, 'ctx.on("internal/update")')
      }
    })

    this.on('internal/update', function (config, next) {
      const cbs = [...this._hooks['internal/update'] || []]
      const _next = () => invoke(undefined, () => {
        const cb = cbs.shift() ?? next
        return cb.call(this, config, _next)
      })
      return _next()
    }, { global: true, prepend: true })

    this.on('internal/config', (fiber, next) => {
      return invoke(fiber.execution, () => resolveConfig(fiber.runtime!, next()))
    })
  }

  private _resolve(type: string, args: any[]) {
    const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
    const name: string | symbol = args.shift()
    const internal = typeof name === 'string' && name.startsWith('internal/')
    if (!internal && this._hooks['internal/dispatch']?.length) {
      this.emit('internal/dispatch', type, name, args, thisArg)
    }
    const filter = thisArg?.[Context.filter]
    const hooks = (this._hooks[name] || [])
      .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx))
    return [thisArg, hooks, name, internal] as const
  }

  private _isAvailable(hook: Hook, internal: boolean) {
    return !hook.removed && (internal || hook.ctx.fiber.acceptsTasksFrom(this.ctx))
  }

  private _invoke(hook: Hook, thisArg: unknown, args: unknown[], internal: boolean, reportError = false) {
    return invoke(undefined, () => {
      const execute = () => Reflect.apply(hook.callback, thisArg, args)
      if (internal && !hook.execution) return execute()
      if (internal) {
        // Control dispatch preserves callable handles, including thenable effects.
        return executeCompletion(createWaitNode(undefined, undefined, undefined, hook.execution), execute, undefined, true)
      }
      return hook.ctx.fiber._taskFrom(
        this.ctx,
        hook.execution === hook.ctx.fiber.execution ? execute : () => executeCompletion(
          createWaitNode(undefined, undefined, undefined, hook.execution),
          execute,
        ),
        hook.label,
        reportError ? hook.onError : undefined,
      )
    })
  }

  /** @deprecated */
  dispatch(type: string, args: any[]) {
    const [thisArg, hooks, , internal] = this._resolve(type, args)
    return hooks.map(hook => (...args: any[]) => {
      if (!this._isAvailable(hook, internal)) {
        if (type === 'waterfall') return args.at(-1)()
        return
      }
      return this._invoke(hook, thisArg, args, internal, type === 'emit')
    })
  }

  parallel(...args: unknown[]) {
    return operation(async () => {
      const [thisArg, hooks, name, internal] = this._resolve('parallel', args)
      const results = await Promise.allSettled(hooks.map(async (hook) => {
        if (this._isAvailable(hook, internal)) return join(this._invoke(hook, thisArg, args, internal))
      }))
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (!errors.length) return
      const label = typeof name === 'symbol' ? String(name) : `"${name}"`
      throw new AggregateError(errors.map(error => error.reason), `one or more listeners of event ${label} failed`)
    })
  }

  emit(...args: any[]) {
    const [thisArg, hooks, , internal] = this._resolve('emit', args)
    for (const hook of hooks) {
      if (this._isAvailable(hook, internal)) this._invoke(hook, thisArg, args, internal, true)
    }
  }

  serial(...args: unknown[]) {
    return operation(async () => {
      const [thisArg, hooks, , internal] = this._resolve('serial', args)
      for (const hook of hooks) {
        if (!this._isAvailable(hook, internal)) continue
        const result = await join(this._invoke(hook, thisArg, args, internal))
        if (isBailed(result)) return result
      }
    })
  }

  bail(...args: any[]) {
    const [thisArg, hooks, , internal] = this._resolve('bail', args)
    for (const hook of hooks) {
      if (!this._isAvailable(hook, internal)) continue
      const result = this._invoke(hook, thisArg, args, internal)
      if (isBailed(result)) return result
    }
  }

  waterfall(...args: any[]) {
    const [thisArg, hooks, , internal] = this._resolve('waterfall', args)
    const inner = args.pop()
    let index = 0
    const dispatch = () => {
      while (hooks[index] && !this._isAvailable(hooks[index], internal)) index++
      const hook = hooks[index++]
      if (!hook) return inner()
      let called = false
      const next = () => invoke(undefined, () => {
        if (called) throw new Error('next() called multiple times')
        called = true
        return dispatch()
      })
      return this._invoke(hook, thisArg, [...args, next], internal)
    }
    return dispatch()
  }

  private register(label: string, name: string | symbol, callback: any, options: EventOptions): () => void {
    const method = options.prepend ? 'unshift' : 'push'
    const internal = typeof name === 'string' && name.startsWith('internal/')
    const onError = internal ? undefined : this.ctx.logger().error
    const execution = listenerUnits.get(callback)
    return this.ctx.fiber.effect(() => {
      const release = execution && execution !== this.ctx.fiber.execution ? execution.retain() : undefined
      const hooks = this._hooks[name] ??= []
      const hook: Hook = { ctx: this.ctx, callback, label, onError, execution, ...options }
      hooks[method](hook)
      return () => {
        const result = this.unregister(name, hook)
        release?.()
        return result
      }
    }, label)
  }

  private unregister(name: string | symbol, hook: Hook) {
    hook.removed = true
    const hooks = this._hooks[name]
    if (!hooks) return
    const index = hooks.indexOf(hook)
    if (index >= 0) {
      hooks.splice(index, 1)
      if (!hooks.length) delete this._hooks[name]
      return true
    }
  }

  on(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions) {
    if (typeof options !== 'object') {
      options = { prepend: options }
    }

    // handle special events
    this.ctx.fiber.assertActive()
    listener = this.ctx.reflect.bind(listener)
    listenerUnits.set(listener, executionContext.getStore()?.unit ?? this.ctx.fiber.execution)
    const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
    if (result) return result

    const label = `ctx.on(${typeof name === 'string' ? JSON.stringify(name) : name.toString()})`
    return this.register(label, name, listener, options)
  }

  once(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions) {
    const dispose = this.on(name, function (...args: any[]) {
      dispose()
      return listener.apply(this, args)
    }, options)
    return dispose
  }
}

export interface Events {
  [key: symbol]: (...args: any[]) => any
  'internal/plugin'(fiber: Fiber): void
  'internal/replace'(fiber: Fiber): void
  'internal/status'(fiber: Fiber, oldValue: FiberState): void
  'internal/service'(this: Context, name: string, value: any): void
  'internal/update'(this: Fiber, resolvedConfig: any, next: () => Awaitable<void>): Awaitable<void>
  'internal/commit'(fiber: Fiber, originalConfig: any): void
  'internal/config'(fiber: Fiber, next: () => any): any
  'internal/get'(ctx: Context, name: string, error: Error, next: () => any): any
  'internal/set'(ctx: Context, name: string, value: any, error: Error, next: () => boolean): boolean
  'internal/listener'(this: Context, name: string, listener: any, prepend: boolean): void
  'internal/dispatch'(mode: DispatchMode, name: string | symbol, args: any[], thisArg: any): void
}
