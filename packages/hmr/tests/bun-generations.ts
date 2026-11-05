import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Context, CordisError, FiberState, invoke, resolveExecution, type ResourceOwner } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { type BunExecutionUnit, BunModuleLoader } from '@cordisjs/host-bun'
import Hmr from '../src/bun.ts'
import type NodeHmr from '../src/index.ts'

assert.ok(process.versions.bun, 'Run with Bun: bun packages/hmr/tests/bun-generations.ts')
const directory = await mkdtemp(join(tmpdir(), 'cordis-bun-hmr-generations-'))
const deadline = setTimeout(() => { throw new Error('Bun HMR generation regression deadline exceeded') }, 20000)
let fixtureId = 0

declare module 'cordis' {
  interface Context {
    graphSiblingProbe: { version: string }
  }
}

async function within<T>(pending: PromiseLike<T>, label: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>()
  const timer = setTimeout(() => reject(new Error(label)), 2000)
  try {
    return await Promise.race([pending, promise])
  } finally {
    clearTimeout(timer)
  }
}

async function application(state: object, activationFailure?: 'rollback', residents: Record<string, Record<string, unknown>> = {}) {
  const base = await mkdtemp(join(directory, 'app-'))
  const controls = `@cordisjs/hmr-generations-${process.pid}-${++fixtureId}`
  const modules = new BunModuleLoader({ residents: {
    [controls]: { state },
    '@cordisjs/plugin-hmr': { default: Hmr },
    ...residents,
  } })
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(base).href + '/'
  await ctx.plugin(Loader, { modules })
  await ctx.plugin(Hmr, { activationFailure, watch: { enabled: false } })
  return {
    ctx, modules, controls,
    path: (name: string) => join(base, name),
    url: (name: string) => pathToFileURL(join(base, name)).href,
    put: (name: string, source: string) => writeFile(join(base, name), source),
    async close() {
      modules.abortImports()
      await ctx.fiber.dispose()
      await modules.dispose()
    },
  }
}

async function queuedCallbacks() {
  const state = {
    event: Symbol('enqueue independent HMR requests'),
    firstEntered: Promise.withResolvers<void>(),
    releaseFirst: Promise.withResolvers<void>(),
    secondEntered: Promise.withResolvers<void>(),
    releaseSecond: Promise.withResolvers<void>(),
    requests: [] as Promise<NodeHmr.Result>[],
    callbacks: [] as [string, boolean][],
    applied: [] as string[],
  }
  const app = await application(state)
  const code = (version: string) => `import { state } from '${app.controls}'
const version = ${JSON.stringify(version)}
export const inject = ['hmr']
export function apply(ctx) {
  const graph = Bun.ModuleGraph.current
  state.applied.push(version)
  ctx.on(state.event, () => {
    state.requests.push(ctx.hmr.reconcile(async () => {
      state.callbacks.push([version, Bun.ModuleGraph.current === graph])
      state.firstEntered.resolve()
      await state.releaseFirst.promise
      return [${JSON.stringify(app.path('queue.ts'))}]
    }))
    state.requests.push(ctx.hmr.reconcile(async () => {
      state.callbacks.push([version, Bun.ModuleGraph.current === graph])
      state.secondEntered.resolve()
      await state.releaseSecond.promise
      return [${JSON.stringify(app.path('queue.ts'))}]
    }))
  })
}
`
  try {
    await app.put('queue.ts', code('A'))
    await app.ctx.loader.root.update([{ id: 'app', name: './queue.ts' }])
    await app.ctx.loader.await()
    const old = app.modules.current.unit
    await app.ctx.parallel(state.event)
    assert.equal(state.requests.length, 2)
    // Only the host consumes the receipts. The graph callback has returned,
    // and the second request is queued before the first transaction begins.
    const completed = Promise.all(state.requests)
    completed.catch(() => {})
    await state.firstEntered.promise
    await app.put('queue.ts', code('B'))
    state.releaseFirst.resolve()
    const first = await state.requests[0]
    assert.deepEqual(first.importFailures, [])
    await Promise.race([
      state.secondEntered.promise,
      state.requests[1].then(() => assert.fail('the second callback enters before its receipt settles')),
    ])
    assert.notEqual(app.modules.current.unit, old)
    assert.equal(old.disposed, false, 'the accepted queued callback retains its code through execution')
    assert.deepEqual(state.callbacks, [['A', true], ['A', true]])
    state.releaseSecond.resolve()
    const results = await completed
    assert.deepEqual(results.map(result => result.importFailures), [[], []])
    assert.deepEqual(state.applied, ['A', 'B', 'B'])
    await old.whenDisposed()
    assert.equal(old.disposed, true)
  } finally {
    state.releaseFirst.resolve()
    state.releaseSecond.resolve()
    await app.close()
  }
}

async function latePublication(activationFailure?: 'rollback', failActivation = false) {
  const state = {
    oldEntered: Promise.withResolvers<void>(),
    releaseOld: Promise.withResolvers<void>(),
    oldEvaluated: Promise.withResolvers<void>(),
    candidateEntered: Promise.withResolvers<void>(),
    releaseCandidate: Promise.withResolvers<void>(),
    rawCompleted: Promise.withResolvers<void>(),
    evaluations: 0,
    live: 0,
    applied: [] as number[],
  }
  const app = await application(state, activationFailure)
  let initializing: Promise<void> | undefined
  let replacing: Promise<NodeHmr.Result> | undefined
  const owner = (version: string) => `import { state } from '${app.controls}'
export const version = ${JSON.stringify(version)}
export function apply() {
  if (version === 'B' && ${JSON.stringify(failActivation)}) throw new Error('candidate activation with a foreign import rejected')
  return async () => {
    if (version !== 'A') return
    state.releaseOld.resolve()
    await state.oldEvaluated.promise
    await state.rawCompleted.promise
  }
}
`
  try {
    await app.put('owner.ts', owner('A'))
    await app.put('late.ts', `import { state } from '${app.controls}'
const evaluation = ++state.evaluations
if (evaluation === 1) {
  state.oldEntered.resolve()
  await state.releaseOld.promise
  state.oldEvaluated.resolve()
} else {
  state.candidateEntered.resolve()
  await state.releaseCandidate.promise
  if (state.live) throw new Error('old definition was published after the pause snapshot')
}
export function apply() {
  state.applied.push(evaluation)
  state.live++
  return () => { state.live-- }
}
`)
    await app.ctx.loader.root.update([{ id: 'owner', name: './owner.ts' }])
    await app.ctx.loader.await()
    const old = app.modules.current.unit
    initializing = app.ctx.loader.root.update([
      { id: 'owner', name: './owner.ts' },
      { id: 'late', name: './late.ts' },
    ])
    await state.oldEntered.promise
    const rawImport = old.import(app.url('late.ts'))
    rawImport.then(() => state.rawCompleted.resolve(), state.rawCompleted.reject)
    await app.put('owner.ts', owner('B'))
    replacing = app.ctx.hmr.reconcile(() => [app.path('owner.ts')])
    await state.candidateEntered.promise
    await rawImport
    // The raw graph import has completed; this checkpoint drains its Loader
    // consumers while candidate evaluation and commit remain behind a barrier.
    await setImmediate()
    assert.equal(app.modules.current.unit, old)
    assert.equal(state.live, 0)
    assert.deepEqual(state.applied, [])
    assert.equal(old.disposed, false)
    state.releaseCandidate.resolve()
    const result = await replacing
    await initializing
    await app.ctx.loader.await()
    assert.deepEqual(result.importFailures, [])
    assert.deepEqual(app.ctx.loader.errors, [])
    assert.deepEqual(state.applied, [failActivation ? 1 : 2])
    assert.equal(state.live, 1)
    assert.equal(app.ctx.loader.store.late.innerFiber?.execution, app.modules.current.unit)
    if (failActivation) {
      assert.equal(result.activationFailures?.length, 1)
      assert.equal(app.modules.current.unit, old)
      await app.put('owner.ts', owner('C'))
      const corrected = await app.ctx.hmr.reconcile(() => [app.path('owner.ts')])
      assert.deepEqual(corrected.importFailures, [])
      assert.equal(corrected.activationFailures, undefined)
      assert.deepEqual(state.applied, [1, 3])
    }
    await old.whenDisposed()
    assert.equal(old.disposed, true)
  } finally {
    state.releaseOld.resolve()
    state.oldEvaluated.resolve()
    state.rawCompleted.resolve()
    state.releaseCandidate.resolve()
    await Promise.allSettled([initializing, replacing])
    await app.close()
  }
}

async function renamedEntry() {
  const state = { applied: [] as string[] }
  const app = await application(state)
  try {
    await app.put('a.ts', `import { state } from '${app.controls}'; export function apply() { state.applied.push('A') }\n`)
    await app.put('b.ts', 'throw new Error("B initial import rejected"); export function apply() {}\n')
    await app.put('pending.ts', `import { state } from '${app.controls}'; export const inject = ['never']; export function apply() { state.applied.push('PENDING') }\n`)
    await app.ctx.loader.root.update([
      { id: 'same', name: './a.ts' },
      { id: 'pending', name: './pending.ts' },
    ])
    await app.ctx.loader.await()
    const entry = app.ctx.loader.store.same
    const original = entry.innerFiber!
    const pending = app.ctx.loader.store.pending.innerFiber!
    assert.equal(pending.state, FiberState.PENDING)
    await app.ctx.loader.root.update([
      { id: 'same', name: './b.ts' },
      { id: 'pending', name: './pending.ts' },
    ])
    await app.ctx.loader.await()
    assert.equal(app.ctx.loader.store.same, entry)
    assert.equal(original.uid, null)
    assert.equal(entry.errors.length, 1)
    assert.deepEqual(state.applied, ['A'])
    await app.put('b.ts', `import { state } from '${app.controls}'; export function apply() { state.applied.push('B') }\n`)
    const result = await app.ctx.hmr.reconcile(() => [app.path('b.ts')])
    assert.deepEqual(result.importFailures, [])
    assert.deepEqual(app.ctx.loader.errors, [])
    assert.equal(app.ctx.loader.store.same, entry)
    assert.equal(entry.innerFiber?.state, FiberState.ACTIVE)
    assert.notEqual(entry.innerFiber, original)
    assert.deepEqual(state.applied, ['A', 'B'])
    assert.equal(app.ctx.loader.store.pending.innerFiber, pending)
    assert.equal(pending.state, FiberState.PENDING)
    const active = entry.innerFiber
    await Promise.all([entry.refresh(), app.ctx.loader.store.pending.refresh()])
    await app.ctx.loader.await()
    assert.equal(entry.innerFiber, active)
    assert.equal(app.ctx.loader.store.pending.innerFiber, pending)
    assert.deepEqual(state.applied, ['A', 'B'])
  } finally {
    await app.close()
  }
}

async function disabledImport(mode: 'disabled' | 'reenable' | 'cancel') {
  const failure = new Error('current enabled import rejected')
  const state = {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
    applied: 0,
  }
  const app = await application(state)
  let creating: Promise<void> | undefined
  let enabling: Promise<void> | undefined
  try {
    await app.put('disabled.ts', `import { state } from '${app.controls}'
state.entered.resolve()
await state.release.promise
export function apply() { state.applied++ }
`)
    creating = app.ctx.loader.root.update([{ id: 'same', name: './disabled.ts' }])
    await state.entered.promise
    const entry = app.ctx.loader.store.same
    if (mode === 'cancel') await entry.dispose()
    else await entry.update({ disabled: true })
    if (mode !== 'cancel') assert.equal(entry.disabled, true)
    assert.deepEqual(app.ctx.loader.errors, [])
    if (mode === 'reenable') enabling = entry.update({ disabled: false })
    state.release.reject(failure)
    await creating
    if (mode === 'reenable') {
      await enabling
    } else {
      await app.ctx.loader.await()
      assert.equal(app.ctx.loader.store.same, entry)
      assert.deepEqual(app.ctx.loader.errors, [], 'the cancelled initialization contributes no current import diagnostic')
      assert.equal(entry.innerFiber?.uid ?? null, null)
      if (mode === 'cancel') {
        await entry.refresh()
      } else {
        await entry.update({ disabled: true })
        assert.deepEqual(app.ctx.loader.errors, [])
        await entry.update({ disabled: false })
      }
    }
    await app.ctx.loader.await()
    assert.equal(app.ctx.loader.store.same, entry)
    assert.deepEqual(app.ctx.loader.errors, [failure])
    assert.equal(state.applied, 0)
    assert.equal(entry.innerFiber?.uid ?? null, null)
  } finally {
    state.release.resolve()
    await Promise.allSettled([creating, enabling])
    await app.close()
  }
}

async function callbackExits() {
  const failure = new Error('queued callback rejected')
  const state: { failure: Error; submit?: (reject: boolean) => Promise<NodeHmr.Result> } = { failure }
  const app = await application(state)
  try {
    await app.put('exits.ts', `import { state } from '${app.controls}'
export const inject = ['hmr']
export function apply(ctx) {
  const hmr = ctx.hmr
  state.submit = reject => hmr.reconcile(() => {
    if (reject) throw state.failure
    return []
  })
}
`)
    await app.ctx.loader.root.update([{ id: 'app', name: './exits.ts' }])
    await app.ctx.loader.await()
    assert.ok(state.submit)
    const submit = state.submit
    const unit = app.modules.current.unit
    const references = unit.references
    const empty = await invoke(unit, () => submit(false))
    assert.deepEqual(empty, { settledFibers: [], importFailures: [], skippedHostModules: [] })
    assert.equal(unit.references, references)
    await assert.rejects(invoke(unit, () => submit(true)), error => error === failure)
    assert.equal(unit.references, references)

    const [hmr] = app.ctx.registry.get(Hmr)!.fibers
    await hmr.dispose()
    await app.ctx.loader.await()
    const inactiveReferences = unit.references
    assert.throws(() => invoke(unit, () => submit(false)), (error) => {
      return error instanceof CordisError && error.code === 'INACTIVE_EFFECT'
    })
    assert.equal(unit.references, inactiveReferences)
    await app.ctx.loader.root.update([])
    await app.ctx.loader.await()
    unit.dispose()
    await unit.whenDisposed()
    assert.equal(unit.disposed, true)
  } finally {
    await app.close()
  }
}

async function oldCleanupImports(activationFailure?: 'rollback', inflight = false, handoff = false, checkRoots = false) {
  const state = {
    event: Symbol('start old managed import'),
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
    imported: [] as string[],
    importer: undefined as (() => Promise<unknown>) | undefined,
    namespace: undefined as unknown,
    appliedGraph: undefined as unknown,
  }
  const app = await application(state, activationFailure)
  if (handoff) state.importer = () => app.ctx.task(() => app.modules.import(app.url('during.ts')))
  let handling: Promise<unknown> | undefined
  let replacing: Promise<NodeHmr.Result> | undefined
  let primary: unknown
  const code = (version: string) => `import { state } from '${app.controls}'
export const inject = ['loader']
export function apply(ctx) {
  const version = ${JSON.stringify(version)}
  const graph = Bun.ModuleGraph.current
  if (version !== 'old') return
  if (${JSON.stringify(inflight)}) {
    ctx.on(state.event, () => ctx.task(signal => {
      signal.addEventListener('abort', () => state.release.resolve(), { once: true })
      const importing = state.importer ? state.importer() : ctx.loader.moduleSource.import('./during.ts', import.meta.url)
      return importing.then(namespace => {
        if (namespace.graph !== graph) throw new Error('old managed import selected another graph')
        state.imported.push(namespace.version)
        state.namespace = namespace
      })
    }))
  } else {
    ctx.effect(() => async () => {
      state.entered.resolve()
      const namespace = await ctx.loader.moduleSource.import('./during.ts', import.meta.url)
      if (namespace.graph !== graph) throw new Error('old cleanup import selected another graph')
      state.imported.push(namespace.version)
      state.namespace = namespace
    })
  }
}
`
  try {
    await app.put('owner.ts', code('old'))
    await app.put('during.ts', `import { state } from '${app.controls}'
${inflight ? 'state.entered.resolve(); await state.release.promise' : ''}
export const version = 'old-import'
export const graph = Bun.ModuleGraph.current
export function apply() { state.appliedGraph = Bun.ModuleGraph.current }
`)
    await app.ctx.loader.root.update([{ id: 'owner', name: './owner.ts' }])
    await app.ctx.loader.await()
    if (inflight) {
      handling = app.ctx.parallel(state.event)
      handling.catch(() => {})
      await state.entered.promise
    }
    await app.put('owner.ts', code('new'))
    replacing = app.ctx.hmr.reconcile(() => [app.path('owner.ts')])
    replacing.catch(() => {})
    await state.entered.promise
    const result = await within(replacing, inflight
      ? 'old owned in-flight import deadlocked behind its own teardown gate'
      : 'old cleanup import deadlocked behind its own teardown gate')
    assert.deepEqual(result.importFailures, [])
    assert.deepEqual(state.imported, ['old-import'])
    await handling
    if (checkRoots) {
      const url = app.url('during.ts')
      assert.ok(app.modules.roots.has(url), 'old cleanup registered a real new root')
      const selected = app.modules.current.plugins.get(url)
      assert.ok(selected, 'every root admitted during old cleanup belongs to the selected candidate')
      assert.notEqual(selected.namespace, state.namespace)
      assert.equal(app.modules.unwrapExports(selected.namespace), selected.plugin)
      assert.equal(resolveExecution(selected.plugin), app.modules.current.unit)
      const fiber = await app.ctx.plugin(selected.plugin)
      assert.equal(fiber.execution, app.modules.current.unit)
      const selectedNamespace = selected.namespace
      const oldNamespace = state.namespace
      assert.ok(selectedNamespace && typeof selectedNamespace === 'object' && 'graph' in selectedNamespace)
      assert.ok(oldNamespace && typeof oldNamespace === 'object' && 'graph' in oldNamespace)
      assert.equal(state.appliedGraph, selectedNamespace.graph)
      assert.notEqual(state.appliedGraph, oldNamespace.graph)
      await fiber.dispose()
    }
  } catch (error) {
    primary = error
    throw error
  } finally {
    state.release.resolve()
    app.modules.abortImports()
    await Promise.allSettled([handling, replacing])
    await app.close().catch(error => {
      throw primary ? new AggregateError([primary, error], 'Regression failure and fixture cleanup') : error
    })
  }
}

async function externalLeaseImport(handoff = false) {
  const state = {
    owner: undefined as ResourceOwner | undefined,
    retired: Promise.withResolvers<void>(),
    releaseImport: Promise.withResolvers<void>(),
    imported: [] as string[],
  }
  const app = await application(state, 'rollback')
  let handling: Promise<void> | undefined
  let replacing: Promise<NodeHmr.Result> | undefined
  let foreign: Promise<unknown> | undefined
  let release: (() => void) | undefined
  try {
    await app.put('owner.ts', `import { state } from '${app.controls}'
export function apply(ctx) { state.owner = ctx.resources }
`)
    await app.put('other.ts', 'export const version = "old"; export function apply() {}\n')
    await app.ctx.loader.root.update([{ id: 'owner', name: './owner.ts' }])
    await app.ctx.loader.await()
    await app.modules.import(app.url('other.ts'))
    const previous = app.modules.current
    const owner = state.owner!
    release = owner.acquire()
    assert.ok(release)
    const admitted = release
    handling = owner.run(async () => {
      const stopped = Promise.withResolvers<void>()
      owner.signal.addEventListener('abort', () => stopped.resolve(), { once: true })
      try {
        await stopped.promise
        state.retired.resolve()
        await state.releaseImport.promise
        const namespace = await (handoff
          ? app.ctx.task(() => app.modules.import(app.url('other.ts')))
          : app.modules.import(app.url('other.ts'))) as { version: string }
        assert.equal(namespace, previous.plugins.get(app.url('other.ts'))!.namespace, 'the old strong lease imports its captured graph')
        state.imported.push(namespace.version)
      } finally {
        admitted()
      }
    })
    handling.catch(() => {})
    await app.put('owner.ts', 'export function apply() {}\n')
    replacing = app.ctx.hmr.reconcile(() => [app.path('owner.ts')])
    replacing.catch(() => {})
    await state.retired.promise
    assert.equal(previous.unit.disposed, false, 'the external strong lease physically retains its old code')
    let published = false
    foreign = app.modules.import(app.url('other.ts')).then(namespace => { published = true; return namespace })
    foreign.catch(() => {})
    await setImmediate()
    assert.equal(published, false, 'foreign host imports stay private while the real old lease is draining')
    state.releaseImport.resolve()
    const result = await within(replacing, 'old external resource lease import deadlocked behind its own teardown gate')
    await handling
    assert.deepEqual(result.importFailures, [])
    assert.deepEqual(state.imported, ['old'])
    assert.equal(await foreign, app.modules.current.plugins.get(app.url('other.ts'))!.namespace)
    await previous.unit.whenDisposed()
    assert.equal(previous.unit.disposed, true)
  } finally {
    state.releaseImport.resolve()
    app.modules.abortImports()
    await Promise.allSettled([handling, replacing, foreign])
    release?.()
    await app.close()
  }
}

async function residentSiblingFailure() {
  const state = {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
    unrelatedEntered: Promise.withResolvers<void>(),
    releaseUnrelated: Promise.withResolvers<void>(),
    versions: [] as string[],
  }
  const resident = `native-hmr-sibling-${process.pid}-${fixtureId + 1}`
  const app = await application(state, 'rollback', {
    [resident]: { inject: ['graphSiblingProbe'], apply: async (ctx: Context) => {
      const version = ctx.graphSiblingProbe.version
      state.versions.push(version)
      if (version !== 'broken') return
      state.entered.resolve()
      await state.release.promise
      throw new Error('dependency-affected resident sibling rejected')
    } },
    [resident + '-unrelated']: { default: async () => {
      state.unrelatedEntered.resolve()
      await state.releaseUnrelated.promise
    } },
  })
  let replacing: Promise<NodeHmr.Result> | undefined
  let unrelated: Promise<unknown> | undefined
  let primary: unknown
  try {
    const code = (version: string) => `export function apply(ctx) { ctx.provide('graphSiblingProbe', { version: ${JSON.stringify(version)} }) }\n`
    await app.put('provider.ts', code('old'))
    await app.ctx.loader.root.update([{ id: 'provider', name: './provider.ts' }])
    await app.ctx.loader.await()
    const namespace = await app.modules.import(resident)
    const sibling = await app.ctx.plugin(app.modules.unwrapExports(namespace))
    const unrelatedNamespace = await app.modules.import(resident + '-unrelated')
    unrelated = app.ctx.plugin(app.modules.unwrapExports(unrelatedNamespace)).await()
    unrelated.catch(() => {})
    await state.unrelatedEntered.promise
    const previous = app.modules.current
    await app.put('provider.ts', code('broken'))
    let settled = false
    replacing = app.ctx.hmr.reconcile(() => [app.path('provider.ts')]).then(result => { settled = true; return result })
    replacing.catch(() => {})
    await state.entered.promise
    await setImmediate()
    assert.equal(settled, false, 'strict settlement includes a resident sibling reached through native dependencies')
    state.release.resolve()
    const rejected = await within(replacing, 'strict settlement joined an unrelated pending resident sibling')
    assert.equal(rejected.activationFailures?.length, 1)
    assert.match(String(rejected.activationFailures![0].error), /dependency-affected resident sibling rejected/)
    assert.equal(app.modules.current, previous)
    assert.equal(app.ctx.graphSiblingProbe.version, 'old')
    assert.equal(sibling.state, FiberState.ACTIVE)
    assert.deepEqual(state.versions, ['old', 'broken', 'old'])
  } catch (error) {
    primary = error
    throw error
  } finally {
    state.release.resolve()
    state.releaseUnrelated.resolve()
    app.modules.abortImports()
    await Promise.allSettled([replacing, unrelated])
    await app.close().catch(error => {
      throw primary ? new AggregateError([primary, error], 'Regression failure and fixture cleanup') : error
    })
  }
}

async function evaluationRestorationGate() {
  const state = {
    restoring: false,
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
    restoredImport: false,
  }
  const app = await application(state, 'rollback')
  let replacing: Promise<NodeHmr.Result> | undefined
  let importing: Promise<unknown> | undefined
  try {
    await app.put('owner.ts', `import { state } from '${app.controls}'
export const inject = ['loader']
export async function apply(ctx) {
  if (state.restoring) {
    await ctx.loader.moduleSource.import('./child.ts', import.meta.url)
    state.restoredImport = true
    state.entered.resolve()
    await state.release.promise
  }
  return () => { state.restoring = true }
}
`)
    await app.put('child.ts', 'export function apply() {}\n')
    await app.ctx.loader.root.update([{ id: 'owner', name: './owner.ts' }])
    await app.ctx.loader.await()
    const previous = app.modules.current
    await app.put('owner.ts', 'throw new Error("candidate evaluation rejected"); export function apply() {}\n')
    replacing = app.ctx.hmr.reconcile(() => [app.path('owner.ts')])
    replacing.catch(() => {})
    await within(state.entered.promise, 'old restoration could not import while publication was locked')
    assert.equal(state.restoredImport, true)
    let published = false
    importing = app.modules.import(app.url('owner.ts')).then(namespace => { published = true; return namespace })
    importing.catch(() => {})
    await setImmediate()
    assert.equal(published, false, 'failed evaluation keeps foreign publication locked until old activation is restored')
    state.release.resolve()
    const result = await replacing
    assert.equal(result.importFailures.length, 1)
    assert.equal(app.modules.current, previous)
    assert.equal(await importing, previous.plugins.get(app.url('owner.ts'))!.namespace)
    assert.equal(app.ctx.loader.store.owner.innerFiber?.state, FiberState.ACTIVE)
  } finally {
    state.release.resolve()
    app.modules.abortImports()
    await Promise.allSettled([replacing, importing])
    await app.close()
  }
}

async function priorTargetStates() {
  const state = { failed: 0, pending: 0 }
  const app = await application(state, 'rollback')
  let primary: unknown
  let stage = 'initial source activation'
  try {
    await app.put('provider.ts', "export function apply(ctx) { ctx.provide('graphSiblingProbe', { version: 'old' }) }\n")
    await app.put('failed.ts', `import { state } from '${app.controls}'
export const inject = ['graphSiblingProbe']
export function apply() { state.failed++; throw new Error('preexisting failed dependent') }
`)
    await app.put('pending.ts', `import { state } from '${app.controls}'
export const inject = ['graphNeverProvided']
export function apply() { state.pending++ }
`)
    await app.ctx.loader.root.update([
      { id: 'provider', name: './provider.ts' },
      { id: 'failed', name: './failed.ts' },
      { id: 'pending', name: './pending.ts' },
    ])
    await app.ctx.loader.await()
    stage = 'initial public diagnostics'
    const failed = app.ctx.loader.store.failed.innerFiber!
    const pending = app.ctx.loader.store.pending.innerFiber!
    assert.deepEqual(app.ctx.loader.errors, [failed.lastError])
    assert.match(String(failed.lastError), /preexisting failed dependent/)
    assert.equal(failed.state, FiberState.FAILED)
    assert.equal(pending.state, FiberState.PENDING)
    assert.deepEqual(state, { failed: 1, pending: 0 })
    const previous = app.modules.current
    await app.put('provider.ts', 'throw new Error("candidate evaluation rejected"); export function apply() {}\n')
    stage = 'rejected evaluation restoration'
    const result = await app.ctx.hmr.reconcile(() => [app.path('provider.ts')])
    assert.equal(result.importFailures.length, 1)
    assert.equal(app.modules.current, previous)
    assert.equal(app.ctx.loader.store.failed.innerFiber, failed)
    assert.equal(app.ctx.loader.store.pending.innerFiber, pending)
    assert.equal(failed.state, FiberState.FAILED, 'restoration does not retry a preexisting failed target')
    assert.equal(pending.state, FiberState.PENDING, 'native dependency admission keeps a prior pending target pending')
    assert.deepEqual(state, { failed: 1, pending: 0 })
    stage = 'explicit failed-target restart'
    await assert.rejects(failed.restart(), /preexisting failed dependent/)
    assert.equal(state.failed, 2, 'the prior failed target was not left internally suspended')
  } catch (error) {
    primary = new Error(`Prior-target guard failed during ${stage}`, { cause: error })
    throw primary
  } finally {
    await app.close().catch(error => {
      throw primary
        ? new AggregateError([primary, error], 'Regression failure and fixture cleanup')
        : new Error('Prior-target guard fixture cleanup failed', { cause: error })
    })
  }
}

async function failedTargetRollback(intent: 'none' | 'restart' | 'update' = 'none') {
  const initialFailure = new Error('original failed target')
  const candidateFailure = new Error('other candidate activation rejected')
  const state = {
    initialFailure, candidateFailure,
    oldCalls: 0,
    healed: 0,
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
    restored: [] as string[],
    candidate: undefined as BunExecutionUnit | undefined,
  }
  const app = await application(state, 'rollback')
  let replacing: Promise<NodeHmr.Result> | undefined
  let primary: unknown
  try {
    await app.put('failed.ts', `import { state } from '${app.controls}'
export function apply(ctx, config) {
  if (++state.oldCalls === 1) throw state.initialFailure
  state.restored.push(config.label)
}
`)
    await app.put('other.ts', 'export function apply() {}\n')
    await app.ctx.loader.root.update([
      { id: 'failed', name: './failed.ts', config: { label: 'initial' } },
      { id: 'other', name: './other.ts' },
    ])
    await app.ctx.loader.await()
    const failed = app.ctx.loader.store.failed.innerFiber!
    const previous = app.modules.current
    assert.equal(failed.state, FiberState.FAILED)
    assert.equal(failed.lastError, initialFailure)
    assert.equal(failed.accepting, false)
    assert.equal(failed.ctx.resources.active, false)
    assert.deepEqual(app.ctx.loader.errors, [initialFailure])
    await app.put('failed.ts', `import { state } from '${app.controls}'
export function apply(ctx) {
  state.healed++
  state.candidate = ctx.fiber.execution
}
`)
    await app.put('other.ts', `import { state } from '${app.controls}'
export async function apply() {
  state.entered.resolve()
  await state.release.promise
  throw state.candidateFailure
}
`)
    replacing = app.ctx.hmr.reconcile(() => [app.path('failed.ts'), app.path('other.ts')])
    replacing.catch(() => {})
    await within(state.entered.promise, 'the failing candidate sibling never activated')
    await setImmediate()
    assert.equal(state.healed, 1, 'the candidate really replaced and healed the prior failed target')
    if (intent === 'restart') await failed.restart()
    else if (intent === 'update') await failed.update({ label: 'latest' })
    state.release.resolve()
    const result = await replacing
    assert.equal(result.activationFailures?.length, 1)
    assert.equal(result.activationFailures![0].error, candidateFailure)
    assert.equal(state.healed, intent === 'none' ? 1 : 2)
    assert.equal(app.modules.current, previous)
    assert.equal(app.ctx.loader.store.failed.innerFiber, failed)
    assert.equal(failed.execution, previous.unit)
    if (intent === 'none') {
      assert.equal(state.oldCalls, 1, 'rollback restores the failed target without executing its old apply again')
      assert.equal(failed.state, FiberState.FAILED)
      assert.equal(failed.lastError, initialFailure, 'rollback restores the exact original native diagnostic')
      assert.equal(failed.accepting, false, 'restoring a failed target never reopens native task admission')
      assert.equal(failed.ctx.resources.active, false, 'restored failed resources remain retired')
      assert.deepEqual(app.ctx.loader.errors, [initialFailure])
      assert.deepEqual(state.restored, [])
    } else {
      assert.equal(state.oldCalls, 2, 'a later explicit native target supersedes the captured failed target')
      assert.equal(failed.state, FiberState.ACTIVE)
      assert.equal(failed.lastError, undefined)
      assert.deepEqual(state.restored, [intent === 'update' ? 'latest' : 'initial'])
      assert.deepEqual(app.ctx.loader.errors, [])
    }
    assert.ok(state.candidate)
    await within(state.candidate.whenDisposed(), 'restoring the old failed target retained candidate code')
    assert.equal(state.candidate.references, 0)
  } catch (error) {
    primary = error
    throw error
  } finally {
    state.release.resolve()
    app.modules.abortImports()
    await Promise.allSettled([replacing])
    await app.close().catch(error => {
      throw primary ? new AggregateError([primary, error], 'Regression failure and fixture cleanup') : error
    })
  }
}

async function revokeDuringPreparation(mode: 'disable' | 'remove') {
  const state = { revoked: [] as string[], live: [] as string[] }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const app = await application(state, 'rollback')
  const prepare = app.modules.prepare.bind(app.modules)
  let replacing: Promise<NodeHmr.Result> | undefined
  let primary: unknown
  try {
    await app.put('revoked.ts', `import { state } from '${app.controls}'
export function apply() { state.revoked.push('old') }
`)
    const live = (version: string) => `import { state } from '${app.controls}'
export function apply() { state.live.push(${JSON.stringify(version)}) }
`
    await app.put('live.ts', live('old'))
    await app.ctx.loader.root.update([
      { id: 'revoked', name: './revoked.ts' },
      { id: 'live', name: './live.ts' },
    ])
    await app.ctx.loader.await()
    const entry = app.ctx.loader.store.revoked
    const retired = entry.innerFiber!
    const previous = app.modules.current
    await app.put('live.ts', live('new'))
    app.modules.prepare = async () => {
      const roots = await prepare()
      entered.resolve()
      await release.promise
      return roots
    }
    replacing = app.ctx.hmr.reconcile(() => [app.path('live.ts')])
    replacing.catch(() => {})
    await entered.promise
    if (mode === 'disable') {
      await entry.update({ disabled: true })
    } else {
      await app.ctx.loader.root.update([{ id: 'live', name: './live.ts' }])
    }
    await app.ctx.loader.await()
    assert.equal(retired.uid, null, 'the entry is actually retired while real source preparation is gated')
    release.resolve()
    const result = await replacing
    assert.deepEqual(result.importFailures, [])
    assert.equal(result.activationFailures, undefined)
    assert.notEqual(app.modules.current, previous, 'revocation does not abort an unrelated live edit')
    assert.deepEqual(state.live, ['old', 'new'])
    assert.deepEqual(state.revoked, ['old'], 'code replacement never resurrects the revoked native entry')
    if (mode === 'disable') {
      assert.equal(entry.disabled, true)
      assert.equal(entry.innerFiber?.uid ?? null, null)
    } else {
      assert.equal(app.ctx.loader.store.revoked, undefined)
    }
    await within(previous.unit.whenDisposed(), 'a revoked preparation snapshot retained old code')
  } catch (error) {
    primary = error
    throw error
  } finally {
    release.resolve()
    app.modules.prepare = prepare
    app.modules.abortImports()
    await Promise.allSettled([replacing])
    await app.close().catch(error => {
      throw primary ? new AggregateError([primary, error], 'Regression failure and fixture cleanup') : error
    })
  }
}

async function refreshedOriginDuringPreparation() {
  const state = {
    refreshEntered: Promise.withResolvers<void>(),
    candidateEntered: Promise.withResolvers<void>(),
    releaseCandidate: Promise.withResolvers<void>(),
    refreshed: [] as string[],
    closing: false,
  }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const app = await application(state, 'rollback')
  const prepare = app.modules.prepare.bind(app.modules)
  let replacing: Promise<NodeHmr.Result> | undefined
  let updating: Promise<unknown> | undefined
  let foreign: Promise<unknown> | undefined
  let primary: unknown
  const code = (version: string) => `import { state } from '${app.controls}'
export const inject = ['loader']
export async function apply(ctx, config) {
  if (!config.refresh || state.closing) return
  const version = ${JSON.stringify(version)}
  const graph = Bun.ModuleGraph.current
  state.refreshEntered.resolve()
  const namespace = await ctx.resources.run(() => ctx.loader.moduleSource.import('./remembered.ts', import.meta.url))
  if (namespace.graph !== graph) throw new Error('a refreshed old activation imported another graph')
  state.refreshed.push(version)
  if (version === 'new') {
    state.candidateEntered.resolve()
    await state.releaseCandidate.promise
  }
}
`
  try {
    await app.put('owner.ts', code('old'))
    await app.put('remembered.ts', 'export const graph = Bun.ModuleGraph.current; export function apply() {}\n')
    await app.ctx.loader.root.update([{ id: 'owner', name: './owner.ts', config: { refresh: false } }])
    await app.ctx.loader.await()
    await app.modules.import(app.url('remembered.ts'))
    const previous = app.modules.current
    await app.put('owner.ts', code('new'))
    app.modules.prepare = async () => {
      const roots = await prepare()
      entered.resolve()
      await release.promise
      return roots
    }
    replacing = app.ctx.hmr.reconcile(() => [app.path('owner.ts')])
    replacing.catch(() => {})
    await entered.promise
    let published = false
    foreign = app.modules.import(app.url('remembered.ts')).then(namespace => { published = true; return namespace })
    foreign.catch(() => {})
    updating = Promise.resolve(app.ctx.loader.store.owner.innerFiber!.update({ refresh: true }))
    updating.catch(() => {})
    await within(state.refreshEntered.promise, 'the explicit update never entered the renewed activation')
    await setImmediate()
    assert.deepEqual(state.refreshed, [], 'renewed activation import initially waits on the real preparation gate')
    assert.equal(published, false)
    release.resolve()
    await within(state.candidateEntered.promise, 'renewed old activation import deadlocked behind stale teardown admission')
    assert.deepEqual(state.refreshed, ['old', 'new'])
    assert.equal(published, false, 'refreshing owned admission never publishes to a foreign host importer')
    assert.equal(previous.unit.disposed, false)
    state.releaseCandidate.resolve()
    const result = await replacing
    await updating
    assert.deepEqual(result.importFailures, [])
    assert.equal(result.activationFailures, undefined)
    assert.equal(await foreign, app.modules.current.plugins.get(app.url('remembered.ts'))!.namespace)
    assert.equal(app.ctx.loader.store.owner.innerFiber?.state, FiberState.ACTIVE)
    await within(previous.unit.whenDisposed(), 'renewed activation retained its retired graph after actual completion')
  } catch (error) {
    primary = error
    throw error
  } finally {
    state.closing = true
    release.resolve()
    state.releaseCandidate.resolve()
    app.modules.prepare = prepare
    app.modules.abortImports()
    await Promise.allSettled([replacing, updating, foreign])
    await app.close().catch(error => {
      throw primary ? new AggregateError([primary, error], 'Regression failure and fixture cleanup') : error
    })
  }
}

async function sourceLifetime(callerOwned = false) {
  const base = await mkdtemp(join(directory, 'source-lifetime-'))
  const key = `__cordisSourceLifetime${process.pid}_${++fixtureId}`
  const state = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  Object.assign(globalThis, { [key]: state })
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(base).href + '/'
  const supplied = callerOwned ? new BunModuleLoader() : undefined
  const loader = ctx.plugin(Loader, { modules: supplied })
  await loader
  const hmr = ctx.plugin(Hmr, { watch: { enabled: false } })
  await hmr
  const modules = ctx.loader.moduleSource
  assert.ok(modules instanceof BunModuleLoader)
  const unit = modules.current.unit
  let importing: Promise<unknown> | undefined
  try {
    const filename = join(base, 'pending.ts')
    await writeFile(filename, `globalThis[${JSON.stringify(key)}].entered.resolve()
await globalThis[${JSON.stringify(key)}].release.promise
export function apply() {}
`)
    importing = modules.import(pathToFileURL(filename).href)
    importing.catch(() => {})
    await state.entered.promise
    await hmr.dispose()
    assert.equal(unit.disposed, false, 'disabling HMR does not retire the loader source')
    await loader.dispose()
    if (callerOwned) {
      state.release.resolve()
      await importing
      assert.equal(unit.disposed, false, 'Loader does not own a caller-supplied source')
    } else {
      await within(assert.rejects(importing, (error: unknown) =>
        error instanceof DOMException && error.name === 'AbortError',
      ), 'Loader retirement did not cancel its default-created source import')
      await unit.whenDisposed()
      assert.equal(unit.disposed, true)
      await assert.rejects(modules.import(pathToFileURL(filename).href), { name: 'AbortError' })
    }
  } finally {
    state.release.resolve()
    modules.abortImports()
    await Promise.allSettled([importing])
    await ctx.fiber.dispose()
    await modules.dispose()
    Reflect.deleteProperty(globalThis, key)
  }
}

async function missingBareRecovery() {
  const state = { applied: [] as string[] }
  const app = await application(state, 'rollback')
  const name = `native-hmr-installed-${process.pid}-${fixtureId}`
  try {
    await app.ctx.loader.root.update([{ id: 'installed', name }])
    await app.ctx.loader.await()
    assert.equal(app.ctx.loader.store.installed.errors.length, 1)
    const packageDirectory = app.path(`node_modules/${name}`)
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name, type: 'module', exports: './index.js',
    }))
    await writeFile(join(packageDirectory, 'index.js'), `import { state } from '${app.controls}'
export function apply() { state.applied.push('installed') }
`)
    const result = await app.ctx.hmr.reconcile(() => [packageDirectory])
    assert.deepEqual(result.importFailures, [])
    assert.deepEqual(state.applied, ['installed'], 'installing a remembered formerly missing bare root retries its native entry')
    assert.deepEqual(app.ctx.loader.errors, [])
  } finally {
    await app.close()
  }
}

async function generatorChanges() {
  const state = {
    checks: [] as [string, boolean][],
    submit: undefined as ((invalid: boolean) => Promise<NodeHmr.Result>) | undefined,
  }
  const app = await application(state)
  try {
    await app.put('generator.ts', `import { state } from '${app.controls}'
export const inject = ['hmr']
export function apply(ctx) {
  const graph = Bun.ModuleGraph.current
  state.submit = invalid => ctx.hmr.reconcile(function* () {
    try {
      state.checks.push(['body', Bun.ModuleGraph.current === graph])
      yield invalid ? 'relative.ts' : ${JSON.stringify(app.path('generator.ts'))}
    } finally {
      state.checks.push(['close', Bun.ModuleGraph.current === graph])
    }
  })
}
`)
    await app.ctx.loader.root.update([{ id: 'generator', name: './generator.ts' }])
    await app.ctx.loader.await()
    const unit = app.modules.current.unit
    const submit = state.submit!
    await assert.rejects(invoke(unit, () => submit(true)), TypeError)
    assert.deepEqual(state.checks, [['body', true], ['close', true]], 'changed iterable execution and iterator cleanup remain in the originating graph')
    state.checks.length = 0
    const result = await invoke(unit, () => submit(false))
    assert.deepEqual(result.importFailures, [])
    assert.deepEqual(state.checks, [['body', true], ['close', true]])
  } finally {
    await app.close()
  }
}

const cases = {
  queue: queuedCallbacks,
  exits: callbackExits,
  publication: latePublication,
  publicationRollback: () => latePublication('rollback'),
  publicationRejected: () => latePublication('rollback', true),
  rename: renamedEntry,
  disabled: () => disabledImport('disabled'),
  reenable: () => disabledImport('reenable'),
  cancel: () => disabledImport('cancel'),
  cleanup: oldCleanupImports,
  cleanupRollback: () => oldCleanupImports('rollback'),
  cleanupRoots: () => oldCleanupImports('rollback', false, false, true),
  inflightCleanup: () => oldCleanupImports('rollback', true),
  inflightHandoff: () => oldCleanupImports('rollback', true, true),
  externalLease: externalLeaseImport,
  externalLeaseHandoff: () => externalLeaseImport(true),
  residentSibling: residentSiblingFailure,
  evaluationRestore: evaluationRestorationGate,
  priorTargets: priorTargetStates,
  failedTargetRollback,
  failedTargetRestart: () => failedTargetRollback('restart'),
  failedTargetUpdate: () => failedTargetRollback('update'),
  prepareDisable: () => revokeDuringPreparation('disable'),
  prepareRemove: () => revokeDuringPreparation('remove'),
  refreshedOrigin: refreshedOriginDuringPreparation,
  autoSource: sourceLifetime,
  callerSource: () => sourceLifetime(true),
  missingBare: missingBareRecovery,
  generator: generatorChanges,
}
const selected = new Set(process.argv.slice(2))
try {
  for (const [name, run] of Object.entries(cases)) {
    if (!selected.size || selected.has(name)) await run()
  }
  console.log('BUN_HMR_GENERATIONS_OK')
} finally {
  clearTimeout(deadline)
  await rm(directory, { recursive: true, force: true })
}
