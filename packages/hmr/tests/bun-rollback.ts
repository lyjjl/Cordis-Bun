import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { type BunExecutionUnit, BunModuleLoader } from '@cordisjs/host-bun'
import Hmr from '../src/bun.ts'
import type NodeHmr from '../src/index.ts'

interface Probe {
  version: string
  shared: object
  sdk: typeof Context
  graph: unknown
}

declare module 'cordis' {
  interface Context {
    rollbackProbe: Probe
    rollbackConsumer: Probe
    rollbackExtra: { version: string }
    rollbackResident: { version: string }
  }
}

assert.ok(process.versions.bun, 'Run with Bun: bun packages/hmr/tests/bun-rollback.ts')
const directory = await mkdtemp(join(tmpdir(), 'cordis-bun-rollback-'))
const deadline = setTimeout(() => { throw new Error('Bun rollback regression deadline exceeded') }, 20000)
let fixtureId = 0

async function application(activationFailure?: 'retain' | 'rollback') {
  const base = await mkdtemp(join(directory, 'app-'))
  const controls = `@cordisjs/hmr-rollback-${process.pid}-${++fixtureId}`
  const state = {
    event: Symbol('self replacement with retained tail'),
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
    tailEntered: Promise.withResolvers<void>(),
    releaseTail: Promise.withResolvers<void>(),
    results: [] as NodeHmr.Result[],
    tails: [] as [string, boolean][],
    cleaned: [] as string[],
    internalImports: [] as string[],
    candidate: undefined as BunExecutionUnit | undefined,
    residentEntered: Promise.withResolvers<void>(),
    releaseResident: Promise.withResolvers<void>(),
    independentEntered: Promise.withResolvers<void>(),
    releaseIndependent: Promise.withResolvers<void>(),
    residentExecutions: [] as unknown[],
    residentCleaned: [] as string[],
  }
  const modules = new BunModuleLoader({ residents: {
    [controls]: { state },
    [controls + '-resident']: { default: async (ctx: Context, config: { version: string }) => {
      state.residentExecutions.push(ctx.fiber.execution)
      ctx.resources.effect(() => { state.residentCleaned.push(config.version) })
      if (config.version === 'independent') {
        state.independentEntered.resolve()
        await state.releaseIndependent.promise
        return
      }
      if (config.version === 'resident-broken') {
        state.residentEntered.resolve()
        await state.releaseResident.promise
        throw new Error('resident child activation rejected')
      }
      ctx.provide('rollbackResident', { version: config.version })
    } },
    '@cordisjs/plugin-hmr': { default: Hmr },
  } })
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(base).href + '/'
  await ctx.plugin(Loader, { modules })
  await ctx.plugin(Hmr, { activationFailure, watch: { enabled: false } })
  const shared = join(base, 'shared.ts')
  await writeFile(join(base, 'provider.ts'), `import { Context } from 'cordis'
import { state } from '${controls}'
import { version, shared } from './shared.ts'
export const inject = ['hmr', 'loader']
export async function apply(ctx) {
  const graph = Bun.ModuleGraph.current
  ctx.provide('rollbackProbe', { version, shared, sdk: Context, graph })
  ctx.effect(() => () => { state.cleaned.push(version + ':provider') })
  const child = await ctx.loader.moduleSource.import('./child.ts', import.meta.url)
  state.internalImports.push(child.version)
  if (version === 'broken') {
    state.candidate = ctx.fiber.execution
    state.entered.resolve()
    await state.release.promise
    throw new Error('candidate apply rejected')
  }
  if (version.startsWith('resident-')) {
    const namespace = await ctx.loader.moduleSource.import('${controls}-resident', import.meta.url)
    ctx.plugin(ctx.loader.unwrapExports(namespace), { version })
  }
  ctx.on(state.event, async () => {
    state.results.push(await ctx.join(ctx.hmr.reconcile(() => [${JSON.stringify(shared)}])))
    state.tailEntered.resolve()
    await state.releaseTail.promise
    state.tails.push([version, Bun.ModuleGraph.current === graph])
  })
}
`)
  await writeFile(join(base, 'consumer.ts'), `import { Context } from 'cordis'
import { state } from '${controls}'
import { version, shared } from './shared.ts'
export const inject = ['rollbackProbe']
export function apply(ctx) {
  if (ctx.rollbackProbe.version !== version || ctx.rollbackProbe.shared !== shared) {
    throw new Error('grouped update mixed local module generations')
  }
  ctx.provide('rollbackConsumer', { version, shared, sdk: Context, graph: Bun.ModuleGraph.current })
  return () => {
    if (ctx.rollbackProbe.version !== version) throw new Error('cleanup lost its provider generation')
    state.cleaned.push(version + ':consumer')
  }
}
`)
  await writeFile(join(base, 'child.ts'), 'export { version } from "./shared.ts"; export function apply() {}\n')
  return {
    ctx, modules, state, shared,
    resident: controls + '-resident',
    provider: pathToFileURL(join(base, 'provider.ts')).href,
    async version(value: string) {
      await writeFile(shared, `export const version = ${JSON.stringify(value)}; export const shared = {}\n`)
    },
    async start() {
      await this.version('old')
      await ctx.loader.root.update([
        { id: 'provider', name: './provider.ts' },
        { id: 'consumer', name: './consumer.ts' },
      ])
      await ctx.loader.await()
      assert.deepEqual(ctx.loader.errors, [])
    },
    async close() {
      state.release.resolve()
      state.releaseTail.resolve()
      state.releaseResident.resolve()
      state.releaseIndependent.resolve()
      modules.abortImports()
      await ctx.fiber.dispose()
      await modules.dispose()
    },
  }
}

async function strictRollback() {
  const app = await application('rollback')
  let handling: Promise<unknown> | undefined
  try {
    await app.start()
    const old = app.modules.current
    const provider = app.ctx.loader.store.provider.innerFiber!
    const consumer = app.ctx.loader.store.consumer.innerFiber!
    assert.equal(app.ctx.rollbackProbe.shared, app.ctx.rollbackConsumer.shared)
    assert.equal(app.ctx.rollbackProbe.sdk, Context)
    assert.equal(app.ctx.rollbackConsumer.sdk, Context)

    // A whole-graph import failure still restores the paused old activations.
    await writeFile(app.shared, 'throw new Error("candidate import rejected"); export const version = "bad"; export const shared = {}\n')
    const imported = await app.ctx.hmr.reconcile(() => [app.shared])
    assert.equal(imported.importFailures.length, 1)
    assert.equal(app.modules.current, old)
    assert.equal(app.ctx.rollbackProbe.version, 'old')
    assert.equal(app.ctx.rollbackConsumer.version, 'old')
    assert.equal(provider.execution, old.unit)
    assert.equal(consumer.execution, old.unit)

    await app.version('broken')
    handling = app.ctx.parallel(app.state.event)
    handling.catch(() => {})
    await app.state.entered.promise
    let published = false
    const importing = app.modules.import(app.provider).then(namespace => { published = true; return namespace })
    importing.catch(() => {})
    await setImmediate()
    assert.equal(published, false, 'an unrelated import cannot publish the provisional candidate')
    assert.equal(old.unit.disposed, false)
    app.state.release.resolve()
    await app.state.tailEntered.promise
    assert.equal(app.state.results.length, 1)
    assert.deepEqual(app.state.results[0].importFailures, [])
    assert.equal(app.state.results[0].activationFailures?.length, 1)
    assert.match(String(app.state.results[0].activationFailures![0].error), /candidate apply rejected/)
    assert.equal(app.modules.current, old)
    assert.equal(await importing, old.plugins.get(app.provider)!.namespace)
    assert.equal(app.ctx.rollbackProbe.version, 'old')
    assert.equal(app.ctx.rollbackConsumer.version, 'old')
    assert.equal(app.ctx.rollbackProbe.shared, app.ctx.rollbackConsumer.shared)
    assert.equal(app.ctx.rollbackProbe.graph, app.ctx.rollbackConsumer.graph)
    assert.equal(provider.state, FiberState.ACTIVE)
    assert.equal(consumer.state, FiberState.ACTIVE)
    assert.equal(provider.execution, old.unit)
    assert.equal(consumer.execution, old.unit)
    assert.deepEqual(app.ctx.loader.errors, [])
    assert.ok(app.state.cleaned.includes('broken:provider'), 'failed candidate resources are retired before restoration settles')
    assert.ok(app.state.candidate)
    await app.state.candidate.whenDisposed()
    assert.equal(app.state.candidate.disposed, true)

    await app.version('corrected')
    const corrected = await app.ctx.hmr.reconcile(() => [app.shared])
    assert.deepEqual(corrected.importFailures, [])
    assert.equal(corrected.activationFailures, undefined)
    assert.equal(app.ctx.rollbackProbe.version, 'corrected')
    assert.equal(app.ctx.rollbackConsumer.version, 'corrected')
    assert.equal(app.ctx.rollbackProbe.shared, app.ctx.rollbackConsumer.shared)
    assert.equal(app.ctx.rollbackProbe.sdk, Context)
    assert.equal(app.ctx.rollbackProbe.graph, app.ctx.rollbackConsumer.graph)
    assert.equal(app.ctx.loader.store.provider.innerFiber, provider)
    assert.equal(app.ctx.loader.store.consumer.innerFiber, consumer)
    assert.notEqual(provider.execution, old.unit)
    assert.equal(old.unit.disposed, false, 'the original accepted callback tail still retains old code after a later successful update')
    app.state.releaseTail.resolve()
    await handling
    assert.deepEqual(app.state.tails, [['old', true]])
    await old.unit.whenDisposed()
    assert.equal(old.unit.disposed, true)
    assert.ok(app.state.internalImports.includes('broken'), 'candidate activation can import without waiting on its own publication gate')
    assert.ok(app.state.internalImports.includes('corrected'))
  } finally {
    app.state.release.resolve()
    app.state.releaseTail.resolve()
    await Promise.allSettled([handling])
    await app.close()
  }
}

async function defaultRetainsFailure() {
  const app = await application()
  try {
    await app.start()
    const old = app.modules.current
    app.state.release.resolve()
    await app.version('broken')
    const result = await app.ctx.hmr.reconcile(() => [app.shared])
    assert.deepEqual(result.importFailures, [])
    assert.equal(result.activationFailures, undefined)
    assert.notEqual(app.modules.current, old)
    assert.equal(app.ctx.loader.store.provider.innerFiber!.state, FiberState.FAILED)
    assert.equal(app.ctx.loader.store.provider.innerFiber!.execution, app.modules.current.unit)
    assert.ok(app.ctx.loader.errors.some(error => String(error).includes('candidate apply rejected')))
    await app.version('corrected')
    await app.ctx.hmr.reconcile(() => [app.shared])
    assert.equal(app.ctx.rollbackProbe.version, 'corrected')
    assert.equal(app.ctx.rollbackConsumer.version, 'corrected')
    assert.deepEqual(app.ctx.loader.errors, [])
  } finally {
    await app.close()
  }
}

async function previouslyUnimportableEntry(outer: boolean) {
  const app = await application('rollback')
  try {
    await app.start()
    const filename = join(dirname(app.shared), 'late.ts')
    await writeFile(filename, 'throw new Error("old entry import rejected"); export function apply() {}\n')
    await app.ctx.loader.root.update([
      { id: 'provider', name: './provider.ts' },
      { id: 'consumer', name: './consumer.ts' },
      { id: 'late', name: './late.ts', inject: outer ? ['rollbackProbe'] : undefined },
    ])
    await app.ctx.loader.await()
    const entry = app.ctx.loader.store.late
    assert.equal(entry.errors.length, 1)
    const old = app.modules.current
    await writeFile(filename, 'export function apply(ctx) { ctx.provide("rollbackExtra", { version: "broken" }); throw new Error("retried candidate apply rejected") }\n')
    const rejected = await app.ctx.hmr.reconcile(() => [filename])
    assert.equal(rejected.activationFailures?.length, 1)
    assert.equal(app.modules.current, old)
    assert.equal(app.ctx.rollbackProbe.version, 'old')
    assert.equal(app.ctx.rollbackExtra, undefined)
    const retired = entry.innerFiber
    assert.ok(retired)
    assert.equal(retired.uid, null)

    await writeFile(filename, 'export function apply(ctx) { ctx.provide("rollbackExtra", { version: "corrected" }) }\n')
    const corrected = await app.ctx.hmr.reconcile(() => [filename])
    assert.equal(corrected.activationFailures, undefined)
    assert.equal(app.ctx.loader.store.late, entry)
    assert.notEqual(entry.innerFiber, retired)
    assert.equal(entry.innerFiber?.state, FiberState.ACTIVE)
    assert.equal(entry.innerFiber?.execution, app.modules.current.unit)
    assert.equal(app.ctx.rollbackExtra.version, 'corrected')
    assert.deepEqual(app.ctx.loader.errors, [])

    await entry.update({ disabled: true })
    await writeFile(filename, 'export function apply(ctx) { ctx.provide("rollbackExtra", { version: "must stay disabled" }) }\n')
    await app.ctx.hmr.reconcile(() => [filename])
    assert.equal(entry.innerFiber?.uid, null)
    assert.equal(app.ctx.rollbackExtra, undefined, 'native refresh does not resurrect a disabled orphan')
    await app.ctx.loader.root.update([
      { id: 'provider', name: './provider.ts' },
      { id: 'consumer', name: './consumer.ts' },
    ])
    await writeFile(filename, 'export function apply(ctx) { ctx.provide("rollbackExtra", { version: "must stay removed" }) }\n')
    await app.ctx.hmr.reconcile(() => [filename])
    assert.equal(app.ctx.loader.store.late, undefined)
    assert.equal(app.ctx.rollbackExtra, undefined, 'remembering a source root does not resurrect an unregistered entry')
  } finally {
    await app.close()
  }
}

async function residentChildFailure() {
  const app = await application('rollback')
  let replacing: Promise<NodeHmr.Result> | undefined
  let independent: Promise<unknown> | undefined
  try {
    await app.start()
    const namespace = await app.modules.import(app.resident)
    independent = app.ctx.plugin(app.modules.unwrapExports(namespace), { version: 'independent' }).await()
    independent.catch(() => {})
    await app.state.independentEntered.promise
    const old = app.modules.current
    await app.version('resident-broken')
    let settled = false
    replacing = app.ctx.hmr.reconcile(() => [app.shared]).then(result => { settled = true; return result })
    replacing.catch(() => {})
    await app.state.residentEntered.promise
    await setImmediate()
    assert.equal(settled, false, 'strict activation awaits an unawaited native-owned resident child')
    assert.equal(old.unit.disposed, false)
    app.state.releaseResident.resolve()
    const rejected = await replacing
    assert.equal(rejected.activationFailures?.length, 1)
    assert.match(String(rejected.activationFailures![0].error), /resident child activation rejected/)
    assert.equal(app.modules.current, old)
    assert.equal(app.ctx.rollbackProbe.version, 'old')
    assert.equal(app.ctx.rollbackResident, undefined)
    assert.ok(app.state.residentCleaned.includes('resident-broken'))
    assert.deepEqual(app.state.residentExecutions, [undefined, undefined], 'resident execution stays host-bound, including an unrelated resident sibling')

    await app.version('resident-corrected')
    const corrected = await app.ctx.hmr.reconcile(() => [app.shared])
    assert.equal(corrected.activationFailures, undefined)
    assert.equal(app.ctx.rollbackProbe.version, 'resident-corrected')
    assert.equal(app.ctx.rollbackResident.version, 'resident-corrected')
    assert.deepEqual(app.state.residentExecutions, [undefined, undefined, undefined])
    app.state.releaseIndependent.resolve()
    await independent
    await old.unit.whenDisposed()
    assert.equal(old.unit.disposed, true)
  } finally {
    app.state.releaseResident.resolve()
    app.state.releaseIndependent.resolve()
    await Promise.allSettled([replacing, independent])
    await app.close()
  }
}

try {
  await strictRollback()
  await defaultRetainsFailure()
  await previouslyUnimportableEntry(false)
  await previouslyUnimportableEntry(true)
  await residentChildFailure()
  console.log('BUN_HMR_ROLLBACK_OK')
} finally {
  clearTimeout(deadline)
  await rm(directory, { recursive: true, force: true })
}
