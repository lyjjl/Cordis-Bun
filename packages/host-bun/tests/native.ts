import assert from 'node:assert/strict'
import { ModuleGraph } from 'bun'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, resolveExecution } from 'cordis'
import { Loader } from '@cordisjs/plugin-loader'
import { BunExecutionUnit, BunModuleLoader } from '../src/index.ts'

assert.ok(process.versions.bun, 'Run with Bun: bun packages/host-bun/tests/native.ts')

const directory = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.native-'))
const url = (name: string) => pathToFileURL(join(directory, name)).href
const put = (name: string, code: string) => writeFile(join(directory, name), code)
const controls = `@cordisjs/host-bun-native-${Date.now()}`
const event = Symbol('graph-owned callback')
const state = {
  evaluations: 0,
  events: [] as string[],
  graphs: [] as (ModuleGraph | undefined)[],
  failedGraphs: [] as (ModuleGraph | undefined)[],
  residentGraph: undefined as ModuleGraph | undefined,
  cancelledGraph: undefined as ModuleGraph | undefined,
  event,
  stopped: Promise.withResolvers<void>(),
  continueTail: Promise.withResolvers<void>(),
  lateEntered: Promise.withResolvers<void>(),
  continueLate: Promise.withResolvers<void>(),
  abortEntered: Promise.withResolvers<void>(),
  continueAbort: Promise.withResolvers<void>(),
  abortEvaluations: 0,
  lateCalls: 0,
  closeDefinition: () => {},
  nestedImport: async () => {},
}
const residentName = controls + '-plugin'
function residentPlugin() {
  state.residentGraph = ModuleGraph.current
}
const options = { residents: { [controls]: { state }, [residentName]: { default: residentPlugin } } }
const loaders: BunModuleLoader[] = []
const contexts: Context[] = []
const releases = new Set<() => void>()
const units: BunExecutionUnit[] = []
const createLoader = () => {
  const loader = new BunModuleLoader(options)
  loaders.push(loader)
  return loader
}

try {
  // Registering SDK copies, one graph per root, or changing namespaces breaks
  // actual Context/prototype/shared-dependency identity at the plugin boundary.
  await put('shared.ts', 'export const shared = {}; export const version = "before"\n')
  await put('first.ts', `
    import { Context } from 'cordis'
    import { Loader } from '@cordisjs/plugin-loader'
    import { BunModuleLoader } from '@cordisjs/host-bun'
    import { state } from '${controls}'
    import { shared, version } from './shared.ts'
    export { Context, BunModuleLoader, Loader, shared, version }
    export default function first(ctx) {
      if (!(ctx instanceof Context)) throw new Error('Context identity changed')
      state.graphs.push(Bun.ModuleGraph.current)
      state.events.push(version)
    }
  `)
  await put('second.ts', `
    import { state } from '${controls}'
    import { shared, version } from './shared.ts'
    export { shared, version }
    export default function second() { state.graphs.push(Bun.ModuleGraph.current) }
  `)
  const loader = createLoader()
  // A late host import must keep native CommonJS and UTF-8 semantics after
  // resident hooks are installed; copying the bytes into loader:js breaks it.
  await put('late-common.cjs', "exports.greet = name => '你好，' + name\n")
  await put('late-common-consumer.ts', `
    import { greet } from './late-common.cjs'
    export const greeting = greet('骰子')
  `)
  const lateCommon = await import(url('late-common-consumer.ts'))
  assert.equal(lateCommon.greeting, '你好，骰子')
  // An already evaluated dependency becomes an explicit root without reading
  // edited disk source again; the current graph remains the cache authority.
  await put('cached-child.ts', 'export const value = {}\n')
  await put('cached-parent.ts', 'export { value } from "./cached-child.ts"\n')
  const cachedLoader = createLoader()
  const cachedParent = await cachedLoader.import(url('cached-parent.ts')) as { value: object }
  await put('cached-child.ts', 'export const value = ;\n')
  await put('cached-next-parent.ts', 'export { value } from "./cached-child.ts"\n')
  const cachedNextParent = await cachedLoader.import(url('cached-next-parent.ts')) as { value: object }
  assert.equal(cachedNextParent.value, cachedParent.value)
  const cachedChild = await cachedLoader.import(url('cached-child.ts')) as { value: object }
  assert.equal(cachedChild.value, cachedParent.value)
  // Runtime module calls defer resolution and parsing until actually reached.
  await put('broken-lazy.ts', 'export const value = ;\n')
  await put('broken-lazy.cjs', 'exports.value = ;\n')
  await put('lazy-parent.ts', `
    export const loadLater = () => import('./created-later.ts')
    export const loadBroken = () => import('./broken-lazy.ts')
    export const loadCommonLater = () => require('./created-later.cjs')
    export const resolveBroken = () => require.resolve('./broken-lazy.cjs')
    export default function lazyParent() {}
  `)
  const lazyLoader = createLoader()
  const lazyParent = await lazyLoader.import(url('lazy-parent.ts')) as {
    loadLater(): Promise<{ value: string }>
    loadBroken(): Promise<unknown>
    loadCommonLater(): { value: string }
    resolveBroken(): string
  }
  await put('created-later.ts', 'export const value = "created when used"\n')
  await put('created-later.cjs', 'exports.value = "created CommonJS when used"\n')
  assert.equal((await lazyLoader.current.unit.invoke(() => lazyParent.loadLater())).value, 'created when used')
  await assert.rejects(() => lazyLoader.current.unit.invoke(() => lazyParent.loadBroken()))
  assert.equal(lazyLoader.current.unit.invoke(() => lazyParent.loadCommonLater()).value, 'created CommonJS when used')
  assert.equal(lazyLoader.current.unit.invoke(() => lazyParent.resolveBroken()), fileURLToPath(url('broken-lazy.cjs')))
  const first = await loader.import(url('first.ts')) as Record<string, unknown>
  const second = await loader.import(url('second.ts')) as Record<string, unknown>
  const definition = first.default
  assert.equal(first.Context, Context)
  assert.equal(first.BunModuleLoader, BunModuleLoader)
  assert.equal(first.Loader, Loader)
  assert.equal(await loader.import('./first.ts', pathToFileURL(directory + '/').href), first)
  assert.equal(first.shared, second.shared)
  const bound = loader.unwrapExports(first)
  assert.equal(loader.unwrapExports(first), bound)
  assert.equal(first.default, definition)
  assert.equal(resolveExecution(bound), loader.current.unit)
  const root = new Context()
  contexts.push(root)
  await root.plugin(bound)
  await root.plugin(loader.unwrapExports(second))
  assert.ok(state.graphs[0])
  assert.equal(state.graphs[0], state.graphs[1])
  assert.deepEqual(state.events, ['before'])
  assert.ok(loader.current.unit.files().has(url('first.ts')))
  assert.ok(loader.current.unit.files().has(url('shared.ts')))
  assert.equal(loader.current.unit.files().has(import.meta.resolve('../src/bootstrap.ts')), false)
  assert.ok((await loader.getLinked(url('first.ts'))).includes(url('shared.ts')))
  assert.ok(loader.residentFiles.has(import.meta.resolve('../../core/src/index.ts')))
  const resident = loader.unwrapExports(await loader.import(residentName))
  assert.equal(resolveExecution(resident, loader.current.unit), undefined)
  await root.plugin(resident)
  assert.notEqual(state.residentGraph, state.graphs[0])
  await put('linked.ts', `
    export { value } from './linked-child.ts'
    const required = require('./required.ts')
    export default function linked() { return required }
  `)
  await put('linked-child.ts', 'export const value = 1\n')
  await put('required.ts', 'export const value = 2\n')
  assert.deepEqual(new Set(await loader.getLinked(url('linked.ts'))), new Set([
    url('linked-child.ts'), url('required.ts'),
  ]))

  // Preparing parses real transitive source without running new module bodies.
  await put('prepare.ts', `
    import { state } from '${controls}'
    state.evaluations++
    export default function prepared() {}
  `)
  await loader.import(url('prepare.ts'))
  assert.equal(state.evaluations, 1)
  await put('shared.ts', 'export const shared = {}; export const version = "after"\n')
  const unlock = loader.lock()
  await loader.prepare()
  assert.equal(state.evaluations, 1)
  const generation = await loader.loadGeneration()
  assert.equal(state.evaluations, 2)
  const nextFirst = generation.plugins.get(url('first.ts'))!.namespace as Record<string, unknown>
  const nextSecond = generation.plugins.get(url('second.ts'))!.namespace as Record<string, unknown>
  assert.equal(nextFirst.version, 'after')
  assert.equal(nextFirst.shared, nextSecond.shared)
  assert.notEqual(first.shared, nextFirst.shared)
  assert.equal(first.version, 'before')
  loader.commit(generation)
  unlock()
  assert.equal((await loader.import(url('first.ts')) as Record<string, unknown>).version, 'after')

  // A parse error leaves the running generation selected.
  await put('shared.ts', 'export const version = ;\n')
  await assert.rejects(loader.prepare())
  assert.equal(loader.current, generation)
  await put('shared.ts', 'export const shared = {}; export const version = "repaired"\n')

  // A root is retained even when its first evaluation throws. A candidate
  // evaluates in a real disposable graph and a corrected root can retry.
  const failing = createLoader()
  await put('failure.ts', `
    import { state } from '${controls}'
    state.failedGraphs.push(Bun.ModuleGraph.current)
    throw new Error('candidate evaluation')
    export default function failed() {}
  `)
  await assert.rejects(failing.import(url('failure.ts')), /candidate evaluation/)
  assert.ok(failing.roots.has(url('failure.ts')))
  await assert.rejects(failing.import('./cold.ts', pathToFileURL(directory + '/').href))
  assert.ok(failing.roots.has(url('cold.ts')))
  await put('cold.ts', 'export default function cold() {}\n')
  assert.ok((await failing.prepare()).includes(url('failure.ts')))
  await assert.rejects(failing.loadGeneration(), /candidate evaluation/)
  const failedCandidate = state.failedGraphs.at(-1)
  assert.ok(failedCandidate)
  assert.throws(() => failedCandidate.run(() => 1))
  await put('failure.ts', 'export default function repaired() {}\n')
  await failing.prepare()
  const repaired = await failing.loadGeneration()
  failing.commit(repaired)
  assert.equal(resolveExecution(failing.unwrapExports(await failing.import(url('failure.ts')))), repaired.unit)

  // Import completion from a retired generation must select the new graph.
  // The old graph is deliberately retained, so this covers late evaluation,
  // not only cancellation caused by graph disposal.
  const racing = createLoader()
  await put('race.ts', `
    import { state } from '${controls}'
    const call = ++state.lateCalls
    if (call === 1) {
      state.lateEntered.resolve()
      await state.continueLate.promise
    }
    export const version = call
    export default function racing() {}
  `)
  const oldUnit = racing.current.unit
  const releaseOld = oldUnit.retain()
  releases.add(releaseOld)
  const lateImport = racing.import(url('race.ts'))
  await state.lateEntered.promise
  const releaseGate = racing.lock()
  await racing.prepare()
  const raceGeneration = await racing.loadGeneration()
  racing.commit(raceGeneration)
  const imported = await lateImport as Record<string, unknown>
  assert.equal(imported.version, 2)
  assert.equal(imported, raceGeneration.plugins.get(url('race.ts'))!.namespace)
  state.continueLate.resolve()
  releaseOld()
  releaseOld()
  await oldUnit.whenDisposed()
  releaseGate()

  // commit opens the gate before new plugin initialization can import a child.
  const nested = createLoader()
  await put('child.ts', 'export default function child() {}\n')
  await put('parent.ts', `
    import { state } from '${controls}'
    export default async function parent() { await state.nestedImport() }
  `)
  await nested.import(url('parent.ts'))
  state.nestedImport = async () => {
    const child = await nested.import('./child.ts', url('parent.ts'))
    await root.plugin(nested.unwrapExports(child))
  }
  const open = nested.lock()
  let externalCompleted = false
  const externalImport = nested.import(url('child.ts')).then(() => { externalCompleted = true })
  await Promise.resolve()
  assert.equal(externalCompleted, false)
  await nested.prepare()
  const parentGeneration = await nested.loadGeneration()
  nested.commit(parentGeneration)
  await root.plugin(parentGeneration.plugins.get(url('parent.ts'))!.plugin)
  await externalImport
  assert.equal(externalCompleted, true)
  open()

  // Core cleanup and a self-stop control receipt may settle before the graph
  // callback returns. Its actual code lease keeps the continuation runnable.
  const retiring = createLoader()
  await put('retire.ts', `
    import { state } from '${controls}'
    export default function retire(ctx) {
      ctx.on(state.event, async () => {
        await ctx.fiber.dispose()
        state.closeDefinition()
        state.stopped.resolve()
        await state.continueTail.promise
        state.events.push('control tail')
      })
      return () => { state.events.push('cleanup') }
    }
  `)
  const retireNamespace = await retiring.import(url('retire.ts'))
  const retireRoot = new Context()
  contexts.push(retireRoot)
  await retireRoot.plugin(retiring.unwrapExports(retireNamespace))
  const retiringUnit = retiring.current.unit
  state.closeDefinition = () => retiringUnit.dispose()
  const handling = retireRoot.parallel(event)
  await state.stopped.promise
  assert.equal(retiringUnit.disposed, false)
  assert.ok(retiringUnit.references > 0)
  assert.equal(state.events.at(-1), 'cleanup')
  state.continueTail.resolve()
  await handling
  await retiringUnit.whenDisposed()
  assert.equal(state.events.at(-1), 'control tail')
  assert.equal(retiringUnit.disposed, true)

  // invoke preserves a synchronous value without touching a then getter.
  const direct = new BunExecutionUnit('native-direct')
  units.push(direct)
  const storage = new AsyncLocalStorage<string>()
  const observed = storage.run('native-session', () => direct.invoke(() => {
    const graph = ModuleGraph.current
    const host = direct.host(() => ({ graph: ModuleGraph.current, session: storage.getStore() }))
    return { graph, host, restored: ModuleGraph.current, session: storage.getStore() }
  }))
  assert.ok(observed.graph)
  assert.notEqual(observed.graph, observed.host.graph)
  assert.equal(observed.restored, observed.graph)
  assert.equal(observed.host.session, 'native-session')
  assert.equal(observed.session, 'native-session')
  const hostReceipt = direct.invoke(() => direct.host(() => Promise.withResolvers<void>()))
  let getterReads = 0
  const value = { get then() { getterReads++; throw new Error('then observed') } }
  assert.equal(direct.invoke(() => value), value)
  assert.equal(getterReads, 0)
  const release = direct.retain()
  releases.add(release)
  const disposed = direct.whenDisposed()
  direct.dispose()
  assert.equal(direct.disposed, false)
  release()
  release()
  await disposed
  assert.equal(direct.disposed, true)
  hostReceipt.resolve()
  await hostReceipt.promise

  // Cancellation settles host waiters even while top-level await is pending.
  const cancelled = new BunExecutionUnit('native-cancelled-import')
  units.push(cancelled)
  await put('pending.ts', 'await new Promise(() => {}); export default function pending() {}\n')
  const pending = cancelled.import(url('pending.ts'))
  cancelled.abortImports()
  await assert.rejects(pending, { name: 'AbortError' })
  cancelled.dispose()
  await cancelled.whenDisposed()

  // Cancellation reaches an unpublished candidate, while source disposal waits
  // for a real reference held by its current unit.
  const aborting = createLoader()
  await put('abort.ts', `
    import { state } from '${controls}'
    if (++state.abortEvaluations === 2) {
      state.cancelledGraph = Bun.ModuleGraph.current
      state.abortEntered.resolve()
      await state.continueAbort.promise
    }
    export default function aborted() {}
  `)
  await aborting.import(url('abort.ts'))
  await aborting.prepare()
  const candidate = aborting.loadGeneration()
  await state.abortEntered.promise
  const releaseCurrent = aborting.current.unit.retain()
  releases.add(releaseCurrent)
  aborting.abortImports()
  await assert.rejects(candidate, { name: 'AbortError' })
  assert.ok(state.cancelledGraph)
  assert.throws(() => state.cancelledGraph!.run(() => 1))
  let sourceDisposed = false
  const closing = aborting.dispose().then(() => { sourceDisposed = true })
  await Promise.resolve()
  assert.equal(sourceDisposed, false)
  releaseCurrent()
  await closing
  assert.equal(sourceDisposed, true)
  console.log('host-bun native regressions passed')
} finally {
  state.continueLate.resolve()
  state.continueTail.resolve()
  state.continueAbort.resolve()
  for (const release of releases) release()
  await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
  await Promise.all(loaders.map(loader => loader.dispose()))
  for (const unit of units) unit.dispose()
  await Promise.all(units.map(unit => unit.whenDisposed()))
  await rm(directory, { recursive: true, force: true })
}
