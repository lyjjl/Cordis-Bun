import assert from 'node:assert/strict'
import { ModuleGraph } from 'bun'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Plugin, resolveExecution } from 'cordis'
import { BunModuleLoader } from '../src/index.ts'

assert.ok(process.versions.bun, 'Run with Bun: bun packages/host-bun/tests/normalization.ts')
const directory = await mkdtemp(join(tmpdir(), 'cordis-bun-normalization-'))
const deadline = setTimeout(() => { throw new Error('Bun normalization regression deadline exceeded') }, 20000)
const controls = `@cordisjs/native-normalization-${process.pid}`
const state = { calls: [] as [string, boolean, typeof Context][], graphs: [] as (ModuleGraph | undefined)[] }
const descriptions = new Set<unknown>()
const resident = {
  name: 'resident-description',
  setup() { state.calls.push(['resident', !state.graphs.includes(ModuleGraph.current), Context]) },
}
const loader = new BunModuleLoader({
  residents: { [controls]: { state }, [controls + '-resident']: { default: resident } },
  adaptPlugin(exported) {
    if (!exported || typeof exported !== 'object' || !('setup' in exported)) return exported as Plugin
    assert.equal(descriptions.has(exported), false, 'a shared description is normalized only once')
    descriptions.add(exported)
    const description = exported as { name: string; setup(ctx: Context): unknown }
    return { name: description.name, apply: ctx => description.setup(ctx) }
  },
})
const ctx = new Context()
const url = (name: string) => pathToFileURL(join(directory, name)).href
try {
  await writeFile(join(directory, 'description.ts'), `import { Context } from 'cordis'
import { state } from '${controls}'
const graph = Bun.ModuleGraph.current
export default {
  name: 'typed-description',
  setup(ctx) {
    if (!(ctx instanceof Context)) throw new Error('SDK identity changed during normalization')
    state.graphs.push(graph)
    state.calls.push(['graph', Bun.ModuleGraph.current === graph, Context])
  },
}
`)
  for (const name of ['first.ts', 'second.ts']) {
    await writeFile(join(directory, name), 'export { default } from "./description.ts"\n')
  }
  const first = await loader.import(url('first.ts')) as { default: object }
  const second = await loader.import(url('second.ts')) as { default: object }
  assert.equal(first.default, second.default, 'roots share their original local module description')
  assert.equal('apply' in first.default, false, 'normalization does not mutate a host description')
  const plugin = loader.unwrapExports(first)
  assert.equal(loader.unwrapExports(first), plugin)
  const secondPlugin = loader.unwrapExports(second)
  assert.notEqual(secondPlugin, plugin, 'distinct root namespaces preserve their native source identities')
  assert.equal(loader.unwrapExports(plugin), plugin, 'an already bound native plugin remains idempotent')
  assert.equal(resolveExecution(plugin), loader.current.unit)
  const firstFiber = await ctx.plugin(plugin)
  const secondFiber = await ctx.plugin(secondPlugin)
  assert.notEqual(firstFiber.runtime, secondFiber.runtime)
  assert.equal(firstFiber.execution, loader.current.unit)
  assert.equal(secondFiber.execution, loader.current.unit)
  assert.equal(descriptions.size, 1)

  const previous = loader.current
  await loader.prepare()
  const candidate = await loader.loadGeneration()
  const replacement = candidate.plugins.get(url('first.ts'))!.plugin
  assert.notEqual(replacement, candidate.plugins.get(url('second.ts'))!.plugin)
  assert.notEqual(replacement, plugin, 'a new graph has a new native execution identity')
  assert.equal(resolveExecution(replacement), candidate.unit)
  assert.equal(descriptions.size, 2)
  loader.commit(candidate)
  for (const fiber of ctx.registry.replace(plugin, replacement)) await fiber.await()
  for (const fiber of ctx.registry.replace(secondPlugin, candidate.plugins.get(url('second.ts'))!.plugin)) await fiber.await()
  await previous.unit.whenDisposed()

  await writeFile(join(directory, 'native.ts'), `import { Context } from 'cordis'
import { state } from '${controls}'
const graph = Bun.ModuleGraph.current
export default function native() {
  state.calls.push(['native', Bun.ModuleGraph.current === graph, Context])
}
`)
  const native = loader.unwrapExports(await loader.import(url('native.ts')))
  assert.equal(resolveExecution(native), candidate.unit)
  await ctx.plugin(native)
  const residentPlugin = loader.unwrapExports(await loader.import(controls + '-resident'))
  assert.equal(resolveExecution(residentPlugin, candidate.unit), undefined)
  await ctx.plugin(residentPlugin)
  assert.deepEqual(state.calls.map(([label, correctGraph, sdk]) => [label, correctGraph, sdk === Context]), [
    ['graph', true, true], ['graph', true, true],
    ['graph', true, true], ['graph', true, true],
    ['native', true, true],
    ['resident', true, true],
  ])
  console.log('BUN_NORMALIZATION_NATIVE_OK')
} finally {
  await ctx.fiber.dispose()
  await loader.dispose()
  clearTimeout(deadline)
  await rm(directory, { recursive: true, force: true })
}
