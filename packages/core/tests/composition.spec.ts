import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Context, FiberState, ReflectService, Service } from '../src/index.ts'

declare module '../src/context.ts' {
  interface Context {
    optional: string | undefined
    required: string
    shared: string
    stack: string | undefined
    old: { read(): void } | undefined
    published: string
    wrapped: { read(): string }
  }
}

// Provider identity, not a global service-name notification, determines activation.
describe('Native optional dependencies and service scopes', () => {
  it('reactivates optional consumers on arrival, replacement, restoration and removal only in their view', async () => {
    const root = new Context()
    const realm = root.isolate('optional')
    const values: unknown[] = []
    const isolated: unknown[] = []
    let unrelated = 0
    const consumer = await root.plugin({ optional: ['optional'], apply(ctx: Context) { values.push(ctx.optional) } })
    const other = await realm.plugin({ optional: ['optional'], apply(ctx: Context) { isolated.push(ctx.optional) } })
    await root.plugin(() => { unrelated++ })
    expect(consumer.state).toBe(FiberState.ACTIVE)
    expect(values).toEqual([undefined])
    const first = root.provide('optional', 'first')
    await consumer.await()
    const second = root.provide('optional', 'second', { replace: true })
    await consumer.await()
    await second()
    await consumer.await()
    await first()
    await consumer.await()
    await other.await()
    expect(values).toEqual([undefined, 'first', 'second', 'first', undefined])
    expect(isolated).toEqual([undefined])
    expect(unrelated).toBe(1)
    await root.fiber.dispose()
  })

  it('keeps required declarations required when the same name is also optional', async () => {
    const root = new Context()
    const values: unknown[] = []
    const consumer = await root.plugin({
      inject: ['required'], optional: ['required', 'optional'],
      apply(ctx: Context) { values.push([ctx.required, ctx.optional]) },
    })
    expect(consumer.state).toBe(FiberState.PENDING)
    root.provide('required', 'ready')
    await consumer.await()
    expect(values).toEqual([['ready', undefined]])
    await root.fiber.dispose()
  })

  it('resolves declared names without replacing physical context fields or applying property-name filters', async () => {
    const root = new Context()
    root.provide('_service', 40)
    root.provide('resources', 41)
    root.provide('scope', 42)
    const scope = root.scope('named bindings')
    await scope.fiber.await()
    expect(ReflectService.getBinding(scope, '_service')).toBe(40)
    expect(ReflectService.getBinding(scope, 'resources')).toBe(41)
    expect(ReflectService.getBinding(scope, 'scope')).toBe(42)
    let context!: Context
    const consumer = await scope.plugin({
      inject: ['_service', 'resources', 'scope'],
      optional: ['_missing'],
      apply(ctx: Context) {
        context = ctx
        const extended = ctx.extend({ _service: 'physical field' })
        expect([
          ReflectService.getBinding(extended, '_service'),
          ReflectService.getBinding(ctx, 'resources'),
          ReflectService.getBinding(ctx, 'scope'),
          ReflectService.getBinding(ctx, '_missing'),
        ]).toEqual([40, 41, 42, undefined])
        expect(Reflect.get(extended, '_service')).toBe('physical field')
        expect(ctx.resources.active).toBe(true)
        expect(typeof ctx.scope).toBe('function')
        expect(() => ReflectService.getBinding(ctx, '_undeclared')).toThrow('without inject')
        expect(() => ReflectService.getBinding(ctx.isolate('_service'), '_service')).toThrow('without inject')
      },
    })
    await consumer.dispose()
    expect(() => ReflectService.getBinding(context, 'resources')).toThrow('in inactive context')
    expect(ReflectService.getBinding(context, '_missing')).toBeUndefined()
    await root.fiber.dispose()
  })

  it('shares traced service shadows, injection metadata and get middleware with property access', async () => {
    const root = new Context()
    root.provide('shared', 'definition')
    root.on('internal/get', (_ctx, name, _error, next) => {
      const value = next()
      return name === 'shared' ? `${value}:hook` : value
    })
    class Dependency extends Service<{ source: string; view?: string }> {
      constructor(ctx: Context) { super(ctx, 'named-dependency') }
      metadata() { return this[Service.resolveIntercept]() }
    }
    class Reader extends Service {
      static inject = { shared: {}, 'named-dependency': { source: 'definition' } }
      constructor(ctx: Context) { super(ctx, 'named-reader') }
      read() {
        const named = ReflectService.getBinding(this.ctx, 'named-dependency')
        const property: unknown = Reflect.get(this.ctx, 'named-dependency')
        if (!(named instanceof Dependency) || !(property instanceof Dependency)) throw new Error('missing dependency')
        return {
          named: ReflectService.getBinding(this.ctx, 'shared'),
          property: this.ctx.shared,
          namedMetadata: named.metadata(),
          propertyMetadata: property.metadata(),
        }
      }
    }
    await root.plugin(Dependency)
    await root.plugin(Reader)
    const caller = root.intercept('named-dependency', { view: 'caller' }).scope('caller')
    await caller.fiber.await()
    caller.provide('shared', 'caller')
    const reader = ReflectService.getBinding(caller, 'named-reader')
    if (!(reader instanceof Reader)) throw new Error('missing reader')
    expect(reader.read()).toEqual({
      named: 'definition:hook',
      property: 'definition:hook',
      namedMetadata: { source: 'definition', view: 'caller' },
      propertyMetadata: { source: 'definition', view: 'caller' },
    })
    await root.fiber.dispose()
  })

  it('uses transparent child fallback and local overrides without changing hard isolation', async () => {
    const root = new Context()
    root.provide('shared', 'ancestor')
    const left = root.scope('left')
    const right = root.scope('right')
    await Promise.all([left.fiber.await(), right.fiber.await()])
    const leftValues: unknown[] = []
    const rightValues: unknown[] = []
    const leftConsumer = await left.plugin({ optional: ['shared'], apply(ctx: Context) { leftValues.push(ctx.shared) } })
    const rightConsumer = await right.plugin({ optional: ['shared'], apply(ctx: Context) { rightValues.push(ctx.shared) } })
    expect(left.shared).toBe('ancestor')
    expect(left.isolate('shared').get('shared')).toBeUndefined()
    const local = left.provide('shared', 'local')
    await Promise.all([leftConsumer.await(), rightConsumer.await()])
    expect(left.shared).toBe('local')
    expect(right.shared).toBe('ancestor')
    expect(root.shared).toBe('ancestor')
    const nested = left.scope('nested')
    await nested.fiber.await()
    expect(nested.shared).toBe('local')
    await local()
    await leftConsumer.await()
    expect(nested.shared).toBe('ancestor')
    expect(leftValues).toEqual(['ancestor', 'local', 'ancestor'])
    expect(rightValues).toEqual(['ancestor'])
    await left.fiber.dispose()
    expect(nested.fiber.state).toBe(FiberState.DISPOSED)
    expect(right.fiber.state).toBe(FiberState.ACTIVE)
    await root.fiber.dispose()
  })

  it('preserves duplicate conflicts and removes a hidden replacement without resurrecting it', async () => {
    const root = new Context()
    const base = root.provide('stack', 'base')
    expect(() => root.provide('stack', 'conflict')).toThrow('has been registered')
    const middle = root.provide('stack', 'middle', { replace: true })
    const top = root.provide('stack', 'top', { replace: true })
    await middle()
    expect(root.stack).toBe('top')
    await top()
    expect(root.stack).toBe('base')
    await base()
    expect(root.stack).toBeUndefined()
    await root.fiber.dispose()
  })

  it.each([false, true])('retains the old optional provider through consumer teardown (withdrawal: %s)', async (withdrawal) => {
    const root = new Context()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const order: string[] = []
    let open = true
    const provider = await root.plugin((ctx) => {
      ctx.provide('old', { read() { order.push(open ? 'read open' : 'read closed') } })
      return () => { open = false; order.push('provider closed') }
    })
    const consumer = await root.plugin({ optional: ['old'], apply(ctx: Context) {
      if (!ctx.old) { order.push('absent'); return }
      return async () => {
        entered.resolve()
        await release.promise
        // The resolved optional declaration retains its binding until cleanup completes.
        const binding = ReflectService.getBinding(ctx, 'old') as NonNullable<Context['old']>
        binding.read()
      }
    } })
    const stopping = withdrawal ? provider.dispose() : consumer.dispose()
    try {
      await entered.promise
      expect(open).toBe(true)
      release.resolve()
      await stopping
      await consumer.await()
      expect(order[0]).toBe('read open')
      expect(order.filter(value => value === 'provider closed')).toHaveLength(withdrawal ? 1 : 0)
      expect(order.filter(value => value === 'absent')).toHaveLength(withdrawal ? 1 : 0)
    } finally {
      release.resolve()
      await root.fiber.dispose()
    }
  })

  it('does not publish a pending or failed replacement over a working binding', async () => {
    const root = new Context()
    root.logger.error = () => {}
    root.provide('published', 'working')
    const values: unknown[] = []
    const notifications: unknown[] = []
    root.on('internal/service', (name, value) => {
      if (name === 'published') notifications.push(value)
    })
    const consumer = await root.plugin({ optional: ['published'], apply(ctx: Context) { values.push(ctx.published) } })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const failure = new Error('candidate failed')
    const candidate = root.plugin(async (ctx) => {
      ctx.provide('published', 'candidate', { replace: true })
      entered.resolve()
      await release.promise
      throw failure
    })
    try {
      await entered.promise
      expect(root.get('published')).toBe('working')
      await consumer.await()
      expect(values).toEqual(['working'])
      expect(notifications).not.toContain('candidate')
      release.resolve()
      await expect(candidate.await()).rejects.toBe(failure)
      await consumer.await()
      expect(root.get('published')).toBe('working')
      expect(values).toEqual(['working'])
      expect(notifications).not.toContain('candidate')
    } finally {
      release.resolve()
      await root.fiber.dispose()
    }
  })

  it('binds resources to each activation and drains strong leases before native cleanup', async () => {
    const root = new Context()
    const contexts: Context[] = []
    const order: string[] = []
    const fiber = await root.plugin((ctx, config: number) => {
      contexts.push(ctx)
      ctx.resources.onRetire(() => { order.push(`detach ${config}`) })
      ctx.resources.effect(() => { order.push(`resource ${config}`) })
      return () => { order.push(`effect ${config}`) }
    }, 0)
    const previous = contexts[0]
    const owner = previous.resources
    const release = owner.acquire()!
    const updating = fiber.update(1)
    expect(owner.active).toBe(false)
    expect(owner.signal.aborted).toBe(true)
    expect(order).toEqual(['detach 0'])
    expect(previous.resources).toBe(owner)
    expect(() => previous.resources.effect(() => {})).toThrow()
    release()
    await updating
    expect(contexts).toHaveLength(2)
    expect(contexts[1].resources).not.toBe(owner)
    expect(previous.resources).toBe(owner)
    expect(contexts[1].resources.active).toBe(true)
    expect(order).toEqual(['detach 0', 'resource 0', 'effect 0'])
    await root.fiber.dispose()
    expect(order).toEqual(['detach 0', 'resource 0', 'effect 0', 'detach 1', 'resource 1', 'effect 1'])
  })

  it('keeps a service shadow bound to its definition activation resources', async () => {
    const root = new Context()
    const owners: Context['resources'][] = []
    class Probe extends Service {
      constructor(ctx: Context) {
        super(ctx, 'resource-probe')
        owners.push(ctx.resources)
      }

      owner() {
        return this.ctx.resources
      }
    }
    const fiber = await root.plugin(Probe)
    const first = root.get('resource-probe') as Probe
    expect(first.owner()).toBe(owners[0])
    expect(first.owner()).not.toBe(root.resources)
    await fiber.restart()
    const second = root.get('resource-probe') as Probe
    expect(second.owner()).toBe(owners[1])
    expect(first.owner()).toBe(owners[0])
    expect(first.owner().active).toBe(false)
    await root.fiber.dispose()
  })

  it('uses optional injection metadata and scopes service-originated events to descendants', async () => {
    const root = new Context()
    const left = root.scope('left')
    const right = root.scope('right')
    await Promise.all([left.fiber.await(), right.fiber.await()])
    class Probe extends Service<{ value: string }> {
      constructor(ctx: Context) {
        super(ctx, 'metadata-probe')
      }

      metadata() {
        return this[Service.resolveIntercept]()
      }

      announce() {
        this.ctx.emit(this, 'custom-event')
      }
    }
    await left.plugin(Probe)
    let metadata: unknown
    await left.plugin({ optional: { 'metadata-probe': { value: 'injected' } }, apply(ctx: Context) {
      const probe = ctx.get('metadata-probe') as Probe
      metadata = probe.metadata()
    } })
    const received: string[] = []
    left.on('custom-event', () => { received.push('left') })
    right.on('custom-event', () => { received.push('right') })
    const probe = left.get('metadata-probe') as Probe
    probe.announce()
    expect(metadata).toEqual({ value: 'injected' })
    expect(received).toEqual(['left'])
    await root.fiber.dispose()
  })

  it('anchors stacked decorator dependencies below their own layers until gated teardown finishes', async () => {
    const root = new Context()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const applied: string[] = []
    const closed: string[] = []
    let open = true
    const provider = await root.plugin((ctx) => {
      ctx.provide('wrapped', { read() {
        if (!open) throw new Error('closed base')
        return 'base'
      } })
      return () => { open = false; closed.push('base') }
    })
    const first = await root.plugin({ inject: ['wrapped'], apply(ctx: Context) {
      const lower = ctx.wrapped
      applied.push('first')
      ctx.provide('wrapped', { read: () => `first(${lower.read()})` }, { replace: true })
      return () => { closed.push(lower.read()) }
    } })
    const second = await root.plugin({ inject: ['wrapped'], apply(ctx: Context) {
      const lower = ctx.wrapped
      applied.push('second')
      ctx.provide('wrapped', { read: () => `second(${lower.read()})` }, { replace: true })
      return async () => {
        entered.resolve()
        await release.promise
        closed.push(lower.read())
      }
    } })
    expect(root.wrapped.read()).toBe('second(first(base))')
    expect(applied).toEqual(['first', 'second'])
    expect(first.diagnostics().dependencies[0].owner).toBe(provider.uid)
    expect(second.diagnostics().dependencies[0].owner).toBe(first.uid)
    const stopping = provider.dispose()
    try {
      await entered.promise
      expect(open).toBe(true)
      expect(closed).toEqual([])
      release.resolve()
      await stopping
      await Promise.all([first.await(), second.await()])
      expect(closed).toEqual(['first(base)', 'base', 'base'])
      expect(first.state).toBe(FiberState.PENDING)
      expect(second.state).toBe(FiberState.PENDING)
    } finally {
      release.resolve()
      await root.fiber.dispose()
    }
  })

  it('publishes a new asynchronous provision only after successful setup and ignores a retired late setup', async () => {
    const root = new Context()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let staged: unknown
    const candidate = root.plugin(async (ctx) => {
      ctx.provide('published', 'staged')
      staged = ctx.published
      entered.resolve()
      await release.promise
      return () => {}
    })
    await entered.promise
    expect(staged).toBe('staged')
    expect(root.get('published', false)).toBeUndefined()
    const replacement = root.provide('published', 'selected', { replace: true })
    const stopping = candidate.dispose()
    expect(root.published).toBe('selected')
    release.resolve()
    await stopping
    expect(root.published).toBe('selected')
    await replacement()
    expect(root.published).toBeUndefined()
    await root.fiber.dispose()
  })

  it('retires and drains root-owned resources even when no native effect owns them', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const owner = root.resources
    const order: string[] = []
    const failure = new Error('root resource cleanup')
    owner.onRetire(() => { order.push('detached') })
    owner.effect(() => { order.push('first'); throw failure }, 'first')
    owner.effect(() => { order.push('second') }, 'second')
    const release = owner.acquire()!
    const stopping = root.fiber.dispose()
    expect(owner.active).toBe(false)
    expect(owner.signal.aborted).toBe(true)
    expect(order).toEqual(['detached'])
    expect(root.fiber.diagnostics().leases).toBe(1)
    expect(root.fiber.dispose()).toBe(stopping)
    release()
    await expect(stopping).rejects.toMatchObject({ errors: [failure] })
    expect(order).toEqual(['detached', 'second', 'first'])
    expect(root.fiber.diagnostics()).toMatchObject({
      id: 0, uid: null, state: FiberState.DISPOSED,
      resources: { state: 'disposed', leases: 0 }, lastError: { errors: [failure] },
    })
  })

  it('drains strict leases before children but retains scope resources through inherited child cleanup', async () => {
    const root = new Context()
    const entered = Promise.withResolvers<void>()
    const releaseChild = Promise.withResolvers<void>()
    const order: string[] = []
    let open = true
    let childEntered = false
    const parent = await root.plugin(async (ctx) => {
      ctx.provide('wrapped', { read() { return open ? 'open' : 'closed' } })
      ctx.resources.effect(() => { open = false; order.push('scope resource') })
      ctx.effect(() => () => { order.push('native resource') })
      await ctx.plugin(child => async () => {
        childEntered = true
        entered.resolve()
        await releaseChild.promise
        order.push(`child read ${child.wrapped.read()}`)
      })
    })
    const releaseLease = parent.ctx.resources.acquire()!
    const stopping = parent.dispose()
    try {
      await setImmediate()
      expect(childEntered).toBe(false)
      expect(open).toBe(true)
      releaseLease()
      await entered.promise
      expect(open).toBe(true)
      releaseChild.resolve()
      await stopping
      expect(order).toEqual(['child read open', 'scope resource', 'native resource'])
    } finally {
      releaseLease()
      releaseChild.resolve()
      await root.fiber.dispose()
    }
  })
})
