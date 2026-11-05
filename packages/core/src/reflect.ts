import { defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context.ts'
import { getTraceable, symbols, withProps } from './utils.ts'
import { Fiber, FiberState } from './fiber.ts'

declare module './context.ts' {
  interface Context {
    get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
    get(name: string, strict?: boolean): any
    set<K extends string & keyof this>(name: K, value: undefined | this[K]): void
    set(name: string, value: any): void
    provide<K extends string & keyof this>(name: K, value: undefined | this[K], options?: ProvideOptions | (() => boolean)): () => Promise<void>
    provide(name: string, value?: unknown, options?: ProvideOptions | (() => boolean)): () => Promise<void>
    accessor(name: string, options: Omit<Property.Accessor, 'type'>): void
    mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void
    mixin<T extends {}>(source: T, mixins: (keyof this & keyof T)[] | Dict<string>): void
  }
}

// Construct the native error thrown by a failed access from its placeholder.
// Call at the proxy trap or named getter boundary so the helper and boundary
// frames can be removed from the resulting stack.
function enhanceAccessError(placeholder: Error) {
  const error = new Error(placeholder.message)
  const lines = error.stack!.split('\n')
  lines.splice(0, 3, `Error: ${error.message}`)
  error.stack = lines.join('\n')
  return error
}

// An access creates this placeholder before its outcome is known, since capturing a stack is costly.
function createAccessError(message: string): Error {
  const error = Object.create(Error.prototype)
  error.message = message
  return error
}

const RESERVED_WORDS = ['prototype', 'then']

// - is a symbol
// - is a reserved word (prototype, then)
// - is a number string (0, 1, 2, ...)
// - starts with `_`
function isSpecialProperty(prop: string | symbol): prop is symbol {
  return typeof prop === 'symbol'
    || RESERVED_WORDS.includes(prop)
    || parseInt(prop).toString() === prop
    || prop.startsWith('_')
}

export type Property = Property.Service | Property.Accessor

export namespace Property {
  export interface Service {
    type: 'service'
  }

  export interface Accessor {
    type: 'accessor'
    get: (this: Context, receiver: any, error: Error) => any
    set?: (this: Context, value: any, receiver: any, error: Error) => boolean
  }
}

export interface ProvideOptions {
  replace?: boolean
  check?: () => boolean
}

// Transparent scopes only select native binding slots. They do not own another
// dependency registry: Fiber.committed and Impl.dependents remain authoritative.
export interface ServiceScope {
  readonly parent?: ServiceScope
  readonly label?: string
  readonly keys: Map<symbol, symbol>
}

export const serviceScope = Symbol('cordis.serviceScope')
export const activation = Symbol('cordis.activation')

export function includesScope(scope: ServiceScope, ancestor: ServiceScope) {
  for (let current: ServiceScope | undefined = scope; current; current = current.parent) {
    if (current === ancestor) return true
  }
  return false
}

export interface ServiceDiagnostics {
  readonly name: string
  readonly binding: number
  readonly owner: number
  readonly ownerName: string
  readonly scope: string | undefined
  readonly isolation: symbol
  readonly available: boolean
  readonly selected: boolean
}

export interface Impl {
  uid: number
  name: string
  ctx: Context
  dependents: Set<Fiber>
  release?: () => void
  value?: any
  check?: () => boolean
  // Actual isolation symbol; may differ from the provider context after a blocked move.
  isolate: symbol
  key: symbol
  scope: ServiceScope
  previous?: Impl
  published: boolean
}

// Resolve an access to service `name` from the def site `ctx` by walking up its fibers.
// `fiber` is the fiber whose `inject` admits the access, and `impl` is the impl the access reaches.
// - `{ impl }`: a fiber provides the impl itself in the same isolation.
// - `{ fiber, impl }`: the impl comes from the committed view of `fiber`.
// - `{ fiber }`: `fiber` declares the service but is inactive.
// - `undefined`: no fiber declares the service, or the walk reaches a context that isolates `name` again.
export function locate(ctx: Context, name: string): { fiber?: Fiber; impl?: Impl; optional?: boolean; config?: unknown } | undefined {
  const key = ctx[symbols.isolate][name]
  const scope = ctx[serviceScope]
  let table = ctx[symbols.isolate]
  let current = ctx
  while (true) {
    const record = current[activation]
    const fiber = record.owner
    let impl: Impl | undefined
    for (const provision of record.provisions) {
      if (provision.name !== name || !includesScope(scope, provision.scope)) continue
      // A context realm can change before its physical binding moves, or a
      // conflicting destination can leave that binding in its retained slot.
      if (provision.ctx[symbols.isolate][name] !== key && provision.isolate !== key) continue
      if (!impl || includesScope(provision.scope, impl.scope)) impl = provision
    }
    if (impl) return { impl }
    while (table !== record.ctx[symbols.isolate]) {
      if (!table || Object.hasOwn(table, name)) return
      table = Object.getPrototypeOf(table)
    }
    impl = record.committed?.[name]
    const required = Object.hasOwn(record.inject, name)
    const optional = !required && Object.hasOwn(record.optional, name)
    if (impl || required || optional) {
      return { fiber, impl, optional, config: (required ? record.inject : record.optional)[name] }
    }
    if (!fiber.runtime) return
    current = fiber.parent
  }
}

export class ReflectService {
  static handler: ProxyHandler<Context> = {
    get: (target, prop, ctx: Context) => {
      if (isSpecialProperty(prop)) {
        return Reflect.get(target, prop, ctx)
      }
      if (Reflect.has(target, prop)) {
        return getTraceable(ctx, Reflect.get(target, prop, ctx))
      }

      const error = createAccessError(`cannot get property "${prop}" without inject`)

      try {
        const def = target.reflect.props[prop]
        if (def?.type === 'accessor') {
          return def.get.call(ctx, ctx[symbols.receiver], error)
        }

        return ReflectService.getBinding(ctx, prop, error)
      } catch (e: any) {
        throw e === error ? enhanceAccessError(e) : e
      }
    },

    set: (target, prop, value, ctx: Context) => {
      if (isSpecialProperty(prop)) {
        return Reflect.set(target, prop, value, ctx)
      }

      const error = createAccessError(`cannot set property "${prop}" without provide`)
      const def = target.reflect.props[prop]
      if (!def) {
        if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx)
        throw enhanceAccessError(error)
      }

      try {
        if (def.type === 'accessor') {
          if (!def.set) return false
          return def.set.call(ctx, value, ctx[symbols.receiver], error)
        }

        return ctx.events.waterfall('internal/set', ctx, prop, value, error, () => {
          return ctx.reflect.set(prop, value, error)
        })
      } catch (e: any) {
        throw e === error ? enhanceAccessError(e) : e
      }
    },

    has: (target, prop) => {
      if (isSpecialProperty(prop)) {
        return Reflect.has(target, prop)
      }
      if (Reflect.has(target, prop)) return true
      return !!target.reflect.props[prop]
    },
  }

  static isBindingViewOpen(ctx: Context) {
    const definition = (ctx[symbols.shadow] as Context | undefined) ?? ctx
    return !definition[activation].finished
  }

  static getBinding(ctx: Context, name: string, error?: Error): unknown {
    const accessError = error ?? createAccessError(`cannot get property "${name}" without inject`)
    try {
      // A fiber-less def site and transparent scopes retain unchecked management access.
      const defSite = (ctx[symbols.shadow] as Context | undefined) ?? ctx
      if (!defSite.fiber.runtime || defSite.fiber.runtime.scope) {
        return ReflectService.isBindingViewOpen(defSite) ? ctx.reflect.get(name, false) : undefined
      }
      return ctx.events.waterfall('internal/get', ctx, name, accessError, () => {
        const result = locate(defSite, name)
        if (!result) throw accessError
        if (result.impl) return getTraceable(ctx, result.impl.value)
        if (result.optional) return undefined
        accessError.message = `cannot get required service "${name}" in inactive context`
        throw accessError
      })
    } catch (e) {
      // Property access owns its placeholder and enhances it in the proxy trap.
      throw error === undefined && e === accessError ? enhanceAccessError(accessError) : e
    }
  }

  public store: Dict<Impl, symbol> = Object.create(null)
  public props: Dict<Property> = Object.create(null)
  private _implCounter = 0

  constructor(public ctx: Context) {
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })

    this.mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin'])
    this.mixin('fiber', ['runtime', 'effect', 'task', 'join'])
    this.mixin('registry', ['inject', 'plugin'])
    this.mixin('events', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall'])
  }

  get(name: string, strict = true) {
    return getTraceable(this.ctx, this._getImpl(name, strict)?.value)
  }

  private _slotKey(scope: ServiceScope, isolation: symbol, create = false) {
    if (!scope.parent) return isolation
    let key = scope.keys.get(isolation)
    if (!key && create) {
      key = Symbol(isolation.description)
      scope.keys.set(isolation, key)
    }
    return key
  }

  private _reclaimKey(scope: ServiceScope, isolation: symbol, key: symbol) {
    if (!this.store[key] && scope.keys.get(isolation) === key) scope.keys.delete(isolation)
  }

  // Relocate only physically owned layers, including descendant service scopes.
  // Stack identity and committed dependency leases survive the realm change.
  _relocate(name: string, from: symbol | undefined, to: symbol | undefined, owns: (ctx: Context) => boolean) {
    if (from === to) return
    const origin = this.ctx[serviceScope]
    const scopes = new Set<ServiceScope>()
    for (const key of Reflect.ownKeys(this.store)) {
      const impl = this.store[key as symbol]
      if (impl.name === name && (impl.isolate === from || impl.isolate === to) && includesScope(impl.scope, origin)) {
        scopes.add(impl.scope)
      }
    }
    const changes = new Map<ServiceScope, { transfer: boolean; source: boolean; destination: boolean }>()
    for (const scope of scopes) {
      const sourceKey = from && this._slotKey(scope, from)
      const targetKey = to && this._slotKey(scope, to)
      const source = sourceKey && this.store[sourceKey]
      const destination = targetKey && this.store[targetKey]
      let owned = source
      while (owned && !owns(owned.ctx)) owned = owned.previous
      const selected = destination ?? owned ?? source
      if (!selected) continue
      const change = { transfer: owns(selected.ctx), source: !!source, destination: !!destination }
      changes.set(scope, change)
      if (!change.transfer || !source || destination || !to) continue
      const moving: Impl[] = []
      const retained: Impl[] = []
      for (let impl: Impl | undefined = source; impl; impl = impl.previous) {
        ;(owns(impl.ctx) ? moving : retained).push(impl)
      }
      if (!moving.length) continue
      const key = this._slotKey(scope, to, true)!
      for (let index = 0; index < moving.length; index++) {
        moving[index].previous = moving[index + 1]
        moving[index].isolate = to
        moving[index].key = key
      }
      for (let index = 0; index < retained.length; index++) retained[index].previous = retained[index + 1]
      if (retained.length) this.store[sourceKey!] = retained[0]
      else delete this.store[sourceKey!]
      this._reclaimKey(scope, from!, sourceKey!)
      this.store[key] = moving[0]
      change.destination = true
    }
    const affectedScope = (scope: ServiceScope, isolation: symbol | undefined) => {
      for (let current: ServiceScope | undefined = scope; current; current = current.parent) {
        const change = changes.get(current)
        if (change && (isolation === from ? change.source : isolation === to && change.destination)) return current
      }
    }
    for (const [scope, change] of changes) {
      for (const isolation of new Set([from, to])) {
        if (!isolation || !(isolation === from ? change.source : change.destination)) continue
        const view = this.ctx.extend({ [serviceScope]: scope }).isolate(name, isolation)
        view.reflect.notify([name], target => target[symbols.isolate][name] === isolation
          && affectedScope(target[serviceScope], isolation) === scope && owns(target) !== change.transfer)
      }
    }
    // Declarations can move between ancestor fallbacks without a local stack.
    this._refreshBindings([name], target => {
      const scope = affectedScope(target[serviceScope], target[symbols.isolate][name])
      return owns(target) && (!scope || changes.get(scope)?.transfer !== false)
    })
  }

  _getImpl(name: string, strict = true, consumer?: Fiber, view: 'available' | 'published' = 'available') {
    const isolation = this.ctx[symbols.isolate][name]
    if (!isolation) return
    for (let scope: ServiceScope | undefined = this.ctx[serviceScope]; scope; scope = scope.parent) {
      const key = this._slotKey(scope, isolation)
      let source = key && this.store[key]
      if (consumer) {
        // A decorator depends on the layer below its own oldest provision.
        // Looking above it would create self- or mutually-dependent restarts.
        for (let impl = source; impl; impl = impl.previous) {
          if (impl.ctx[activation] === consumer.ctx[activation]) source = impl.previous
        }
      }
      for (let impl = source; impl; impl = impl.previous) {
        if (view === 'published') {
          if (impl.published) return impl
          continue
        }
        const record = impl.ctx[activation]
        if (!record.accepting) continue
        if (record.owner.state === FiberState.ACTIVE) return impl
        if (!strict && record === this.ctx[activation]) return impl
      }
    }
  }

  set(name: string, value: any, error?: Error) {
    const isolation = this.ctx[symbols.isolate][name]
    const scope = this.ctx[serviceScope]
    const key = this._slotKey(scope, isolation)
    const impl = key && this.store[key]
    if (!impl) {
      throw new Error(`cannot set property "${name}" without provide`)
    }
    if (impl.ctx[activation] !== this.ctx[activation]) {
      throw new Error(`cannot set property "${name}" in multiple fibers`)
    }
    impl.value = value
    return true
  }

  provide(name: string, value?: unknown, options: ProvideOptions | (() => boolean) = {}) {
    if (!this.ctx.resources.active) throw new Error('cannot provide service on inactive context')
    const { check, replace = false } = typeof options === 'function' ? { check: options } : options
    const record = this.ctx[activation]
    return this.ctx.fiber.effect(() => {
      if (!this.props[name]) {
        this.props[name] = { type: 'service' }
      } else if (this.props[name].type !== 'service') {
        throw new Error(`property "${name}" is already declared as ${this.props[name].type}`)
      }

      this.ctx[symbols.root][symbols.isolate][name] ??= Symbol(name)
      const isolation = this.ctx[symbols.isolate][name]
      const scope = this.ctx[serviceScope]
      const key = this._slotKey(scope, isolation, true)!
      const previous = this.store[key]
      if (previous && !replace) {
        throw new Error(`service "${name}" has been registered at <${previous.ctx.fiber.name}>`)
      }
      const impl: Impl = {
        uid: ++this._implCounter,
        name,
        value,
        ctx: this.ctx,
        check,
        isolate: isolation,
        key,
        scope,
        previous,
        dependents: new Set(),
        published: record.owner.state === FiberState.ACTIVE && record.accepting,
      }
      this.store[key] = impl
      record.provisions.add(impl)
      if (this.ctx.fiber.state === FiberState.ACTIVE) this.notify([name])
      return async () => {
        const key = impl.key
        if (this.store[key] === impl) {
          if (impl.previous) this.store[key] = impl.previous
          else delete this.store[key]
        } else {
          let current = this.store[key]
          while (current && current.previous !== impl) current = current.previous!
          if (current) current.previous = impl.previous
        }
        this._reclaimKey(impl.scope, impl.isolate, key)
        impl.previous = undefined
        impl.ctx.isolate(name, impl.isolate).reflect.notify([name])
        // Binding snapshots remain usable until their consumers finish cleanup.
        const drain = Promise.withResolvers<void>()
        impl.release = drain.resolve
        if (!impl.dependents.size) drain.resolve()
        await drain.promise
        impl.release = undefined
        if (record.accepting) record.provisions.delete(impl)
      }
    }, `ctx.provide(${JSON.stringify(name)})`)
  }

  _refreshBindings(names: string[], filter: (ctx: Context, name: string) => boolean) {
    const scope = this.ctx[serviceScope]
    for (const runtime of this.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        if (!includesScope(fiber.ctx[serviceScope], scope)) continue
        let hasUpdate = false
        for (const name of names) {
          if (!(name in fiber.inject) && !(name in fiber.optional)) continue
          if (!filter(fiber.ctx, name)) continue
          hasUpdate = true
          fiber._checkImpl(name)
        }
        if (!hasUpdate) continue
        fiber._refresh()
      }
    }
  }

  notify(names: string[], filter = (ctx: Context, name: string) => ctx[symbols.isolate][name] === this.ctx[symbols.isolate][name]) {
    this._refreshBindings(names, filter)
    const scope = this.ctx[serviceScope]
    for (const name of names) {
      const self: Context = Object.create(this.ctx)
      self[symbols.filter] = (target: Context) => includesScope(target[serviceScope], scope) && filter(target, name)
      this.ctx.events.emit(self, 'internal/service', name, this._getImpl(name, false, undefined, 'published')?.value)
    }
  }

  diagnostics(name?: string): readonly ServiceDiagnostics[] {
    const result: ServiceDiagnostics[] = []
    const names = name === undefined ? Object.keys(this.props) : [name]
    for (const name of names) {
      const isolation = this.ctx[symbols.isolate][name]
      if (!isolation) continue
      const selected = this._getImpl(name)
      for (let scope: ServiceScope | undefined = this.ctx[serviceScope]; scope; scope = scope.parent) {
        const key = this._slotKey(scope, isolation)
        for (let impl = key && this.store[key]; impl; impl = impl.previous) {
          result.push({
            name,
            binding: impl.uid,
            owner: impl.ctx.fiber.id,
            ownerName: impl.ctx.fiber.name,
            scope: scope.label,
            isolation,
            selected: selected === impl,
            available: impl.ctx[activation].owner.state === FiberState.ACTIVE && impl.ctx[activation].accepting,
          })
        }
      }
    }
    return result
  }

  accessor(name: string, options: Omit<Property.Accessor, 'type'>) {
    return this.ctx.fiber.effect(() => {
      if (name in this.props) {
        throw new Error(`property "${name}" is already declared as ${this.props[name].type}`)
      }
      this.props[name] = { type: 'accessor', ...options }
      return () => delete this.props[name]
    }, `ctx.accessor(${JSON.stringify(name)})`)
  }

  mixin(source: any, mixins: string[] | Dict<string>) {
    const self = this
    return this.ctx.fiber.effect(function* () {
      const entries = Array.isArray(mixins) ? mixins.map(key => [key, key]) : Object.entries(mixins)
      const getTarget = (ctx: Context, error: Error) => {
        // TODO enhance error message
        return ctx[source]
      }
      for (const [key, value] of entries) {
        yield self.accessor(value, {
          get(receiver, error) {
            const service = getTarget(this, error)
            if (isNullable(service)) return service
            const mixin = receiver ? withProps(receiver, service) : service
            const value = Reflect.get(service, key, mixin)
            if (typeof value !== 'function') return value
            return value.bind(mixin ?? service)
          },
          set(value, receiver, error) {
            const service = getTarget(this, error)
            const mixin = receiver ? withProps(receiver, service) : service
            return Reflect.set(service, key, value, mixin)
          },
        })
      }
    }, `ctx.mixin(${JSON.stringify(source)})`)
  }

  trace<T>(value: T) {
    return getTraceable(this.ctx, value)
  }

  bind<T extends Function>(callback: T) {
    return new Proxy(callback, {
      apply: (target, thisArg, args) => {
        return Reflect.apply(target, this.trace(thisArg), args.map(arg => this.trace(arg)))
      },
      construct: (target, args, newTarget) => {
        return Reflect.construct(target, args.map(arg => this.trace(arg)), newTarget)
      },
    })
  }
}
