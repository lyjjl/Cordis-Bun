import { expect, describe, it } from 'vitest'
import { Context, FiberState } from 'cordis'
import type { Fiber, Plugin } from 'cordis'
import { setImmediate } from 'node:timers/promises'
import MockLoader from './utils.ts'

declare module 'cordis' {
  interface Context {
    svc: { tag: string }
  }
}

interface Slot {
  key: symbol
  description: string
  impl: Context['reflect']['store'][symbol]
  tag?: string
}

function slots(ctx: Context, name: string): Slot[] {
  const found: Slot[] = []
  for (const key of Reflect.ownKeys(ctx.reflect.store)) {
    if (typeof key !== 'symbol') continue
    const impl = ctx.reflect.store[key]
    if (impl?.name !== name) continue
    found.push({
      key,
      description: key.description ?? '',
      impl,
      tag: impl.value?.tag,
    })
  }
  return found
}

async function boot(plugins: Record<string, Plugin.Function>, scoped = false) {
  const root = new Context()
  const host = scoped ? root.scope('loader') : root
  if (scoped) await host.fiber.await()
  await host.plugin(MockLoader)
  const loader = host.loader as MockLoader
  for (const [name, plugin] of Object.entries(plugins)) loader.mock(name, plugin)
  return { root, host, loader }
}

async function started(loader: MockLoader, id: string) {
  const fiber = loader.store[id]?.innerFiber
  expect(fiber).to.be.ok
  await fiber!.await()
  return fiber!
}

describe('Service Isolation: provide migration', () => {
  it('keeps self access while the provision context changes realms', async () => {
    const reads: string[] = []
    const { root, loader } = await boot({
      prov: (ctx) => {
        ctx.provide('svc', { tag: 'prov' })
        ctx.on('internal/update', () => {
          reads.push(ctx.svc.tag)
        })
      },
    })
    const id = await loader.create({ name: 'prov', config: { revision: 1 } })
    const fiber = await started(loader, id)
    await loader.update(id, { isolate: { svc: 'A' }, config: { revision: 2 } })
    expect(reads).to.deep.equal(['prov'])
    expect(fiber.ctx.svc.tag).to.equal('prov')
    await root.fiber.dispose()
  })

  it('reloads a self-provider after an isolate-only move', async () => {
    let calls = 0
    let duringReload: Slot[] | undefined
    const { root, loader } = await boot({
      prov: (ctx, config) => {
        calls++
        if (calls > 1) duringReload = slots(ctx, 'svc')
        ctx.provide('svc', { tag: config?.tag ?? 'init' })
      },
    })

    const id = await loader.create({ name: 'prov', config: { tag: 'init' } })
    await started(loader, id)
    expect(calls).to.equal(1)
    const before = slots(root, 'svc')
    expect(before).to.have.length(1)

    await loader.update(id, { isolate: { svc: true } })
    expect(calls).to.equal(1)
    const after = slots(root, 'svc')
    expect(after).to.have.length(1)
    expect(after[0]!.impl).to.equal(before[0]!.impl)
    expect(after[0]!.key).to.not.equal(before[0]!.key)
    expect(root.reflect.store[before[0]!.key]).to.be.undefined
    expect(after[0]!.description).to.equal(`svc#${loader.store[id]!.options.id}`)

    await loader.update(id, { config: { tag: 'reloaded' } })
    await started(loader, id)
    expect(calls).to.equal(2)
    expect(duringReload).to.have.length(0)
    const reloaded = slots(root, 'svc')
    expect(reloaded).to.have.length(1)
    expect(reloaded[0]!.impl).to.not.equal(before[0]!.impl)
    expect(reloaded[0]!.tag).to.equal('reloaded')
    expect(reloaded[0]!.description).to.equal(after[0]!.description)
  })

  it('keeps an impl that reused the abandoned symbol', async () => {
    let calls = 0
    const { root, loader } = await boot({
      prov: (ctx) => {
        calls++
        ctx.provide('svc', { tag: 'prov' })
      },
      other: (ctx) => {
        ctx.provide('svc', { tag: 'other' })
      },
    })

    const id = await loader.create({ name: 'prov' })
    await started(loader, id)
    const before = slots(root, 'svc')
    expect(before).to.have.length(1)

    await loader.update(id, { isolate: { svc: true } })
    expect(calls).to.equal(1)
    const moved = slots(root, 'svc')
    expect(moved).to.have.length(1)
    expect(moved[0]!.impl).to.equal(before[0]!.impl)
    expect(moved[0]!.key).to.not.equal(before[0]!.key)
    expect(moved[0]!.description).to.equal(`svc#${loader.store[id]!.options.id}`)
    expect(root.reflect.store[before[0]!.key]).to.be.undefined

    const otherId = await loader.create({ name: 'other' })
    await started(loader, otherId)
    const other = slots(root, 'svc').find(slot => slot.tag === 'other')
    expect(other?.key).to.equal(before[0]!.key)

    await loader.store[id]!.innerFiber!.dispose()
    const left = slots(root, 'svc')
    expect(left.some(slot => slot.impl === before[0]!.impl)).to.equal(false)
    expect(left.some(slot => slot.impl === other!.impl)).to.equal(true)
  })

  it('retains a moved provider until its consumers finish cleanup', async () => {
    const gate = Promise.withResolvers<void>()
    const timeline: string[] = []
    const { root, loader } = await boot({
      provider: (ctx, config) => {
        ctx.provide('svc', { tag: config.tag })
        return () => { timeline.push(`closed: ${config.tag}`) }
      },
      consumer: Object.assign((ctx: Context) => async () => {
        await gate.promise
        timeline.push(`read: ${ctx.svc.tag}`)
      }, { inject: ['svc'] }),
    })
    const id = await loader.create({ name: 'provider', config: { tag: 'moved' } })
    const provider = await started(loader, id)
    const original = slots(root, 'svc')[0]!
    const uid = original.impl.uid
    await loader.update(id, { isolate: { svc: 'B' } })
    const moved = slots(root, 'svc')[0]!
    expect(moved.impl).to.equal(original.impl)
    expect(moved.impl.uid).to.equal(uid)

    const otherId = await loader.create({ name: 'provider', config: { tag: 'other' } })
    await started(loader, otherId)
    const other = slots(root, 'svc').find(slot => slot.tag === 'other')!
    expect(other.key).to.equal(original.key)
    const consumerId = await loader.create({ name: 'consumer', isolate: { svc: 'B' } })
    await started(loader, consumerId)

    const task = provider.dispose()
    await setImmediate()
    const duringCleanup = [...timeline]
    gate.resolve()
    await task
    await loader.await()
    expect(duringCleanup).to.deep.equal([])
    expect(timeline).to.deep.equal(['read: moved', 'closed: moved'])
    expect(root.reflect.store[moved.key]).to.be.undefined
    expect(root.reflect.store[other.key]).to.equal(other.impl)
    expect(loader.expectFiber(consumerId).state).to.equal(FiberState.PENDING)
    await root.fiber.dispose()
  })

  it('keeps impls on intermediate symbols across repeated moves', async () => {
    let calls = 0
    const { root, loader } = await boot({
      prov: (ctx) => {
        calls++
        ctx.provide('svc', { tag: 'prov' })
      },
      rootUser: (ctx) => {
        ctx.provide('svc', { tag: 'rootUser' })
      },
      keep: () => {},
      onA: (ctx) => {
        ctx.provide('svc', { tag: 'onA' })
      },
    })

    const id = await loader.create({ name: 'prov' })
    await started(loader, id)
    const rootSlot = slots(root, 'svc')[0]!
    const original = rootSlot.impl

    await loader.update(id, { isolate: { svc: 'A' } })
    expect(calls).to.equal(1)
    const atA = slots(root, 'svc')
    expect(atA).to.have.length(1)
    expect(atA[0]!.impl).to.equal(original)
    expect(atA[0]!.description).to.equal('svc@A')
    expect(root.reflect.store[rootSlot.key]).to.be.undefined

    const rootUserId = await loader.create({ name: 'rootUser' })
    await started(loader, rootUserId)
    const rootUser = slots(root, 'svc').find(slot => slot.tag === 'rootUser')
    expect(rootUser?.key).to.equal(rootSlot.key)

    const keepId = await loader.create({ name: 'keep', isolate: { svc: 'A' } })
    await started(loader, keepId)
    await loader.update(id, { isolate: { svc: 'B' } })
    expect(calls).to.equal(1)
    const atB = slots(root, 'svc').find(slot => slot.impl === original)
    expect(atB?.description).to.equal('svc@B')
    expect(root.reflect.store[atA[0]!.key]).to.be.undefined

    const onAId = await loader.create({ name: 'onA', isolate: { svc: 'A' } })
    await started(loader, onAId)
    const onA = slots(root, 'svc').find(slot => slot.tag === 'onA')
    expect(onA?.key).to.equal(atA[0]!.key)

    await loader.update(id, { isolate: { svc: 'C' } })
    expect(calls).to.equal(1)
    const atC = slots(root, 'svc').find(slot => slot.impl === original)
    expect(atC?.description).to.equal('svc@C')

    await loader.store[id]!.innerFiber!.dispose()
    const left = slots(root, 'svc')
    expect(left.some(slot => slot.impl === original)).to.equal(false)
    expect(left.some(slot => slot.impl === rootUser!.impl)).to.equal(true)
    expect(left.some(slot => slot.impl === onA!.impl)).to.equal(true)
  })

  it('does not delete another realm when one impl moves', async () => {
    let calls = 0
    const { root, loader } = await boot({
      stay: (ctx) => {
        ctx.provide('svc', { tag: 'stay' })
      },
      move: (ctx) => {
        calls++
        ctx.provide('svc', { tag: 'move' })
      },
    })

    const stayId = await loader.create({ name: 'stay', isolate: { svc: 'stay' } })
    const moveId = await loader.create({ name: 'move', isolate: { svc: 'from' } })
    await started(loader, stayId)
    await started(loader, moveId)
    const stay = slots(root, 'svc').find(slot => slot.tag === 'stay')!
    const move = slots(root, 'svc').find(slot => slot.tag === 'move')!
    expect(stay.description).to.equal('svc@stay')
    expect(move.description).to.equal('svc@from')

    await loader.update(moveId, { isolate: { svc: 'to' } })
    expect(calls).to.equal(1)
    const moved = slots(root, 'svc').find(slot => slot.impl === move.impl)
    const stayAfter = slots(root, 'svc').find(slot => slot.impl === stay.impl)
    expect(moved?.description).to.equal('svc@to')
    expect(moved?.key).to.not.equal(move.key)
    expect(stayAfter?.key).to.equal(stay.key)

    await loader.store[moveId]!.innerFiber!.dispose()
    const left = slots(root, 'svc')
    expect(left.some(slot => slot.impl === stay.impl)).to.equal(true)
    expect(left.some(slot => slot.impl === move.impl)).to.equal(false)
  })

  it.each(['fiber', 'provide'])('notifies the retained realm on %s disposal after a blocked move', async (mode) => {
    const gate = Promise.withResolvers<void>()
    const disposers: Record<string, () => void> = {}
    const consumers: Record<string, Context> = {}
    const starts: string[] = []
    const stops: string[] = []
    const { root, loader } = await boot({
      provider: (ctx, config) => {
        disposers[config.tag] = ctx.provide('svc', { tag: config.tag })
      },
      consumer: Object.assign((ctx: Context, config: { tag: string }) => {
        consumers[config.tag] = ctx
        starts.push(ctx.svc.tag)
        return async () => {
          await gate.promise
          stops.push(ctx.svc.tag)
        }
      }, { inject: ['svc'] }),
    })
    const first = await loader.create({ name: 'provider', config: { tag: 'first' }, isolate: { svc: 'A' } })
    const second = await loader.create({ name: 'provider', config: { tag: 'second' }, isolate: { svc: 'B' } })
    const ca = await loader.create({ name: 'consumer', config: { tag: 'A' }, isolate: { svc: 'A' } })
    const cb = await loader.create({ name: 'consumer', config: { tag: 'B' }, isolate: { svc: 'B' } })
    for (const id of [first, second, ca, cb]) await started(loader, id)
    const a = slots(root, 'svc').find(slot => slot.tag === 'first')!
    const b = slots(root, 'svc').find(slot => slot.tag === 'second')!

    await loader.update(first, { isolate: { svc: 'B' } })
    expect(root.reflect.store[a.key]).to.equal(a.impl)
    expect(root.reflect.store[b.key]).to.equal(b.impl)
    expect(loader.expectFiber(first).ctx.svc.tag).to.equal('first')
    expect(loader.expectFiber(first).diagnostics().provided[0].available).to.equal(true)
    expect(starts).to.deep.equal(['first', 'second'])
    expect(stops).to.deep.equal([])

    const eventsA: unknown[] = []
    const eventsB: unknown[] = []
    root.isolate('svc', a.key).on('internal/service', (name, value) => {
      if (name === 'svc') eventsA.push(value?.tag)
    })
    root.isolate('svc', b.key).on('internal/service', (name, value) => {
      if (name === 'svc') eventsB.push(value?.tag)
    })
    let completed = false
    const task = Promise.resolve(mode === 'fiber'
      ? loader.expectFiber(first).dispose()
      : disposers.first()).then(() => completed = true)
    await setImmediate()
    const completedDuringCleanup = completed
    gate.resolve()
    await task
    await loader.await()
    expect(completedDuringCleanup).to.equal(false)
    expect(stops).to.deep.equal(['first'])
    expect(loader.expectFiber(ca).state).to.equal(FiberState.PENDING)
    expect(() => consumers.A.svc).to.throw('inactive context')
    expect(loader.expectFiber(cb).state).to.equal(FiberState.ACTIVE)
    expect(consumers.B.svc.tag).to.equal('second')
    expect(root.reflect.store[a.key]).to.be.undefined
    expect(root.reflect.store[b.key]).to.equal(b.impl)
    expect(eventsA).to.deep.equal(mode === 'fiber' ? ['first', undefined] : [undefined])
    expect(eventsB).to.deep.equal([])

    const replacement = await loader.create({ name: 'provider', config: { tag: 'replacement' }, isolate: { svc: 'A' } })
    await started(loader, replacement)
    await loader.await()
    expect(loader.expectFiber(ca).state).to.equal(FiberState.ACTIVE)
    expect(consumers.A.svc.tag).to.equal('replacement')
    expect(starts).to.deep.equal(['first', 'second', 'replacement'])
    expect(stops).to.deep.equal(['first'])
    expect(loader.expectFiber(cb).state).to.equal(FiberState.ACTIVE)
    expect(consumers.B.svc.tag).to.equal('second')
    expect(eventsB).to.deep.equal([])
  })

  it.each([false, true])('restores, removes and re-registers every migrated layer (scoped: %s)', async (scoped) => {
    let base!: () => Promise<void>
    let top!: () => Promise<void>
    const { root, host, loader } = await boot({
      provider: (ctx) => {
        base = ctx.provide('svc', { tag: 'base' })
        top = ctx.provide('svc', { tag: 'top' }, { replace: true })
      },
    }, scoped)
    const id = await loader.create({ name: 'provider' })
    const provider = await started(loader, id)
    const identities = provider.diagnostics().provided.map(value => value.binding)
    await loader.update(id, { isolate: { svc: 'A' } })
    const realm = host.isolate('svc', provider.ctx[Context.isolate].svc)
    let sibling: Context | undefined
    let siblingActivations = 0
    if (scoped) {
      const view = root.scope('sibling')
      await view.fiber.await()
      sibling = view.isolate('svc', provider.ctx[Context.isolate].svc)
      sibling.provide('svc', { tag: 'sibling' })
      await sibling.inject(['svc'], () => { siblingActivations++ })
    }
    const values: (string | undefined)[] = []
    const optional = await realm.plugin({
      optional: ['svc'],
      apply(ctx: Context) { values.push(ctx.svc?.tag) },
    })
    const required = await realm.inject(['svc'], () => {})
    expect(realm.get('svc')?.tag).to.equal('top')
    expect(realm.reflect.diagnostics('svc').map(value => value.binding).sort()).to.deep.equal([...identities].sort())
    await top()
    await Promise.all([optional.await(), required.await()])
    expect(realm.get('svc')?.tag).to.equal('base')
    await base()
    await Promise.all([optional.await(), required.await()])
    expect(realm.get('svc')).to.equal(undefined)
    expect(required.state).to.equal(FiberState.PENDING)
    const replacement = realm.provide('svc', { tag: 'reused' })
    await Promise.all([optional.await(), required.await()])
    expect(realm.get('svc')?.tag).to.equal('reused')
    expect(required.state).to.equal(FiberState.ACTIVE)
    expect(values).to.deep.equal(['top', 'base', undefined, 'reused'])
    if (sibling) {
      expect(sibling.get('svc')?.tag).to.equal('sibling')
      expect(siblingActivations).to.equal(1)
    }
    await replacement()
    await root.fiber.dispose()
  })

  it.each([false, true])('withdraws a migrated stack completely on provider disposal (scoped: %s)', async (scoped) => {
    const { root, host, loader } = await boot({
      provider: (ctx) => {
        ctx.provide('svc', { tag: 'base' })
        ctx.provide('svc', { tag: 'top' }, { replace: true })
      },
    }, scoped)
    const id = await loader.create({ name: 'provider' })
    const provider = await started(loader, id)
    await loader.update(id, { isolate: { svc: 'A' } })
    const realm = host.isolate('svc', provider.ctx[Context.isolate].svc)
    const consumer = await realm.inject(['svc'], () => {})
    expect(realm.get('svc')?.tag).to.equal('top')
    await provider.dispose()
    await consumer.await()
    expect(consumer.state).to.equal(FiberState.PENDING)
    expect(realm.get('svc')).to.equal(undefined)
    expect(realm.reflect.diagnostics('svc')).to.deep.equal([])
    const replacement = realm.provide('svc', { tag: 'after disposal' })
    await consumer.await()
    expect(consumer.ctx.svc.tag).to.equal('after disposal')
    await replacement()
    await root.fiber.dispose()
  })

  it('moves only the transferred entry layers beneath an unrelated overlay', async () => {
    let removeBase!: () => Promise<void>
    const { root, loader } = await boot({
      base: (ctx) => { removeBase = ctx.provide('svc', { tag: 'base' }) },
      overlay: (ctx) => { ctx.provide('svc', { tag: 'unrelated' }, { replace: true }) },
    })
    const baseId = await loader.create({ name: 'base' })
    const base = await started(loader, baseId)
    const overlayId = await loader.create({ name: 'overlay' })
    const overlay = await started(loader, overlayId)
    let rootActivations = 0
    const rootConsumer = await root.inject(['svc'], () => { rootActivations++ })
    await loader.update(baseId, { isolate: { svc: 'A' } })
    const realm = root.isolate('svc', base.ctx[Context.isolate].svc)
    expect(root.svc.tag).to.equal('unrelated')
    expect(realm.get('svc')?.tag).to.equal('base')
    await rootConsumer.await()
    expect(rootActivations).to.equal(1)
    await overlay.dispose()
    expect(root.get('svc')).to.equal(undefined)
    expect(realm.get('svc')?.tag).to.equal('base')
    await removeBase()
    expect(realm.get('svc')).to.equal(undefined)
    const replacement = realm.provide('svc', { tag: 'replacement' })
    expect(realm.get('svc')?.tag).to.equal('replacement')
    await replacement()
    await root.fiber.dispose()
  })

  it.each([false, true])('re-resolves a moved decorator below its own layers (scoped: %s)', async (scoped) => {
    const { root, host, loader } = await boot({
      base: (ctx) => { ctx.provide('svc', { tag: 'base' }) },
      decorator: Object.assign((ctx: Context) => {
        const lower = ctx.svc
        ctx.provide('svc', { tag: `wrapped(${lower.tag})` }, { replace: true })
      }, { inject: ['svc'] }),
    }, scoped)
    const baseId = await loader.create({ name: 'base' })
    const base = await started(loader, baseId)
    const decoratorId = await loader.create({ name: 'decorator' })
    const decorator = await started(loader, decoratorId)
    expect(host.svc.tag).to.equal('wrapped(base)')
    await loader.update(decoratorId, { isolate: { svc: 'A' } })
    await decorator.await()
    expect(decorator.state).to.equal(FiberState.PENDING)
    expect(host.svc.tag).to.equal('base')
    await base.dispose()
    const realm = host.isolate('svc', decorator.ctx[Context.isolate].svc)
    expect(realm.get('svc')).to.equal(undefined)
    const remove = realm.provide('svc', { tag: 'new lower' })
    await decorator.await()
    expect(decorator.state).to.equal(FiberState.ACTIVE)
    expect(realm.get('svc')?.tag).to.equal('wrapped(new lower)')
    await remove()
    await decorator.await()
    expect(decorator.state).to.equal(FiberState.PENDING)
    expect(realm.get('svc')).to.equal(undefined)
    await root.fiber.dispose()
  })

  it.each([false, true])('releases ancestor fallback after a scoped consumer view changes (optional: %s)', async (optional) => {
    const { root, host, loader } = await boot({}, true)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const values: (string | undefined)[] = []
    const reads: string[] = []
    let closed = false
    const provider = await root.plugin(ctx => {
      ctx.provide('svc', { tag: 'ancestor' })
      return () => { closed = true }
    })
    loader.mock('consumer', Object.assign((ctx: Context) => {
      values.push(ctx.svc?.tag)
      if (!ctx.svc) return
      return async () => {
        entered.resolve()
        await release.promise
        reads.push(ctx.svc.tag)
      }
    }, { inject: optional ? [] : ['svc'], optional: optional ? ['svc'] : [] }))
    const id = await loader.create({ name: 'consumer' })
    const consumer = await started(loader, id)
    const sibling = root.scope('sibling')
    await sibling.fiber.await()
    const siblingConsumer = await sibling.inject(['svc'], () => {})
    const moving = loader.update(id, { isolate: { svc: 'A' } })
    try {
      await entered.promise
      expect(siblingConsumer.state).to.equal(FiberState.ACTIVE)
      const stopping = provider.dispose()
      await setImmediate()
      expect(closed).to.equal(false)
      release.resolve()
      await Promise.all([moving, stopping, consumer.await()])
      expect(reads).to.deep.equal(['ancestor'])
      expect(closed).to.equal(true)
      expect(consumer.state).to.equal(optional ? FiberState.ACTIVE : FiberState.PENDING)
      expect(values).to.deep.equal(optional ? ['ancestor', undefined] : ['ancestor'])
      const realm = host.isolate('svc', consumer.ctx[Context.isolate].svc)
      expect(realm.get('svc')).to.equal(undefined)
    } finally {
      release.resolve()
      await root.fiber.dispose()
    }
  })

  it.each([false, true])('moves owned nested physical scopes without losing required or optional consumers (optional: %s)', async (optional) => {
    let nested!: Context
    let leaf!: Context
    let consumer!: Fiber
    let removeTop!: () => Promise<void>
    let removeBase!: () => Promise<void>
    let starts = 0
    const values: (string | undefined)[] = []
    const notifications: (string | undefined)[] = []
    const { root, loader } = await boot({
      provider: async (ctx) => {
        starts++
        nested = ctx.scope('nested bindings')
        await nested.fiber.await()
        nested.provide('svc', { tag: 'ancestor fallback' })
        leaf = nested.scope('leaf bindings')
        await leaf.fiber.await()
        removeBase = leaf.provide('svc', { tag: 'base' })
        removeTop = leaf.provide('svc', { tag: 'top' }, { replace: true })
        leaf.on('internal/service', name => {
          if (name === 'svc') notifications.push(leaf.get('svc')?.tag)
        })
        consumer = await leaf.plugin({
          inject: optional ? [] : ['svc'],
          optional: optional ? ['svc'] : [],
          apply(view: Context) { values.push(view.svc?.tag) },
        })
      },
    })
    try {
      const id = await loader.create({ name: 'provider' })
      const provider = await started(loader, id)
      const original = leaf.reflect.diagnostics('svc').map(value => value.binding)
      await loader.update(id, { isolate: { svc: 'nested-realm' } })
      await consumer.await()
      expect(starts).to.equal(1)
      expect(leaf.get('svc')?.tag).to.equal('top')
      expect(nested.get('svc')?.tag).to.equal('ancestor fallback')
      expect(leaf.reflect.diagnostics('svc').map(value => value.binding)).to.deep.equal(original)
      expect(consumer.state).to.equal(FiberState.ACTIVE)
      expect(values).to.deep.equal(['top'])
      expect(notifications).to.deep.equal([])
      expect(slots(root, 'svc').every(slot => slot.impl.isolate === provider.ctx[Context.isolate].svc)).to.equal(true)
      await removeTop()
      await consumer.await()
      expect(leaf.get('svc')?.tag).to.equal('base')
      await removeBase()
      await consumer.await()
      expect(leaf.get('svc')?.tag).to.equal('ancestor fallback')
      expect(values).to.deep.equal(['top', 'base', 'ancestor fallback'])
      expect(notifications).to.deep.equal(['base', 'ancestor fallback'])
    } finally {
      await root.fiber.dispose()
    }
  })

  it.each([false, true])('withdraws ancestor realm fallback past a foreign local destination slot (optional: %s)', async (optional) => {
    const values: (string | undefined)[] = []
    const notifications: (string | undefined)[] = []
    const { root, loader } = await boot({
      provider: ctx => { ctx.provide('svc', { tag: 'moving ancestor' }) },
      keepRealm: () => {},
    })
    let consumer: Fiber | undefined
    let stopping: Promise<void> | undefined
    try {
      const id = await loader.create({ name: 'provider', isolate: { svc: 'fallback-source' } })
      const provider = await started(loader, id)
      const keep = await loader.create({ name: 'keepRealm', isolate: { svc: 'foreign-destination' } })
      const destination = await started(loader, keep)
      const nested = root.scope('unrelated physical descendant')
      await nested.fiber.await()
      const sourceView = nested.isolate('svc', provider.ctx[Context.isolate].svc)
      const foreignView = nested.isolate('svc', destination.ctx[Context.isolate].svc)
      foreignView.provide('svc', { tag: 'foreign local destination' })
      const foreignReads: string[] = []
      const foreignConsumer = await foreignView.inject(['svc'], ctx => { foreignReads.push(ctx.svc.tag) })
      const foreignBinding = foreignConsumer.diagnostics().dependencies[0].binding
      sourceView.on('internal/service', (name, value) => {
        if (name === 'svc') notifications.push(value?.tag)
      })
      consumer = await sourceView.plugin({
        inject: optional ? [] : ['svc'],
        optional: optional ? ['svc'] : [],
        apply(ctx: Context) { values.push(ctx.svc?.tag) },
      })
      expect(consumer.ctx.svc.tag).to.equal('moving ancestor')
      const original = consumer.diagnostics().dependencies[0].binding
      expect(original).to.be.a('number')
      await loader.update(id, { isolate: { svc: 'foreign-destination' } })
      await consumer.await()
      let current: string | undefined
      let inactive = false
      try {
        current = consumer.ctx.svc?.tag
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('inactive context')) throw error
        inactive = true
      }
      const afterMove = {
        state: consumer.state,
        binding: consumer.diagnostics().dependencies[0].binding,
        current,
        inactive,
        values: [...values],
        notifications: [...notifications],
      }
      stopping = provider.dispose()
      const deadline = Promise.withResolvers<boolean>()
      const timer = setTimeout(() => deadline.resolve(false), 1000)
      let completed: boolean
      try {
        completed = await Promise.race([stopping.then(() => true), deadline.promise])
      } finally {
        clearTimeout(timer)
      }
      expect({ ...afterMove, completed }).to.deep.equal({
        state: optional ? FiberState.ACTIVE : FiberState.PENDING,
        binding: undefined,
        current: undefined,
        inactive: !optional,
        values: optional ? ['moving ancestor', undefined] : ['moving ancestor'],
        notifications: [undefined],
        completed: true,
      })
      expect(foreignView.get('svc')?.tag).to.equal('foreign local destination')
      await foreignConsumer.await()
      expect(foreignConsumer.diagnostics().dependencies[0].binding).to.equal(foreignBinding)
      expect(foreignConsumer.state).to.equal(FiberState.ACTIVE)
      expect(foreignReads).to.deep.equal(['foreign local destination'])
    } finally {
      // Explicit consumer retirement also drains the pre-fix stuck provider.
      await consumer?.dispose()
      await stopping
      await root.fiber.dispose()
    }
  })

})
