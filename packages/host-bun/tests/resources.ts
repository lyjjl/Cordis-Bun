import assert from 'node:assert/strict'
import { ModuleGraph } from 'bun'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Context, type ResourceOwner } from 'cordis'
import { BunModuleLoader } from '../src/index.ts'

assert.ok(process.versions.bun, 'Run with Bun: bun packages/host-bun/tests/resources.ts')
const directory = await mkdtemp(join(tmpdir(), 'cordis-bun-resources-'))
const deadline = setTimeout(() => { throw new Error('Bun resource graph regression deadline exceeded') }, 20000)
const controls = `@cordisjs/native-resources-${process.pid}`
const state = {
  owner: undefined as ResourceOwner | undefined,
  graph: undefined as ModuleGraph | undefined,
  release: undefined as (() => void) | undefined,
  events: [] as string[],
  cleanupEntered: Promise.withResolvers<void>(),
  releaseCleanup: Promise.withResolvers<void>(),
}
const loader = new BunModuleLoader({ residents: { [controls]: { state } } })
const ctx = new Context()
let stopping: Promise<void> | undefined
try {
  const filename = join(directory, 'owner.ts')
  await writeFile(filename, `import { state } from '${controls}'
export function apply(ctx) {
  const owner = ctx.resources
  const graph = Bun.ModuleGraph.current
  state.owner = owner
  state.graph = graph
  state.release = owner.acquire()
  if (!state.release) throw new Error('activation did not admit its first resource lease')
  owner.onRetire(() => { state.events.push('retire') })
  owner.effect(async () => {
    if (Bun.ModuleGraph.current !== graph) throw new Error('cleanup entered another graph')
    state.events.push('cleanup:start')
    state.cleanupEntered.resolve()
    await state.releaseCleanup.promise
    if (Bun.ModuleGraph.current !== graph) throw new Error('cleanup continuation lost its old graph')
    state.events.push('cleanup:end')
  }, 'graph-owned asynchronous cleanup')
}
`)
  const namespace = await loader.import(pathToFileURL(filename).href)
  const fiber = await ctx.plugin(loader.unwrapExports(namespace))
  assert.ok(state.owner)
  assert.ok(state.graph)
  assert.ok(state.release)
  const owner = state.owner
  const old = loader.current
  assert.equal(owner.active, true)
  assert.equal(owner.run(() => ModuleGraph.current), state.graph)

  // Both native instance retirement and module retirement are real. Neither
  // may destroy executable code or resources admitted before retirement.
  await loader.prepare()
  loader.commit(await loader.loadGeneration())
  let stopped = false
  stopping = fiber.dispose().then(() => { stopped = true })
  stopping.catch(() => {})
  assert.equal(owner.active, false)
  assert.equal(owner.signal.aborted, true)
  assert.equal(owner.acquire(), undefined, 'retirement synchronously rejects new strong leases')
  await setImmediate()
  assert.equal(stopped, false)
  assert.deepEqual(state.events, ['retire'])
  assert.equal(old.unit.disposed, false)
  assert.equal(owner.run(() => ModuleGraph.current), state.graph, 'an admitted old resource still runs in its captured graph')

  state.release()
  await state.cleanupEntered.promise
  assert.equal(stopped, false, 'native disposal awaits graph-owned asynchronous resource cleanup')
  assert.equal(old.unit.disposed, false)
  assert.deepEqual(state.events, ['retire', 'cleanup:start'])
  state.releaseCleanup.resolve()
  await stopping
  await old.unit.whenDisposed()
  assert.equal(stopped, true)
  assert.deepEqual(state.events, ['retire', 'cleanup:start', 'cleanup:end'])
  assert.equal(old.unit.disposed, true)
  assert.throws(() => state.graph!.run(() => 0))
  console.log('BUN_RESOURCES_NATIVE_OK')
} finally {
  state.release?.()
  state.releaseCleanup.resolve()
  await Promise.allSettled([stopping])
  await ctx.fiber.dispose()
  await loader.dispose()
  clearTimeout(deadline)
  await rm(directory, { recursive: true, force: true })
}
