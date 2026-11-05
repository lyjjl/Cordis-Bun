import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { BunModuleLoader } from '../src/index.ts'

const directory = await mkdtemp(join(tmpdir(), 'cordis-watch-lifetime-'))
const controls = `@cordisjs/watch-lifetime-${process.pid}`
const state = {
  entered: Promise.withResolvers<void>(),
  finish: Promise.withResolvers<void>(),
  before: false,
  after: false,
  finished: false,
  cleaned: false,
  late: false,
}
const ctx = new Context()
const modules = new BunModuleLoader({ residents: { [controls]: { state } } })
const deadline = setTimeout(() => { throw new Error('Native watcher lifetime deadline exceeded') }, 20000)
let stopping: Promise<void> | undefined
let closing: Promise<void> | undefined
try {
  await ctx.plugin(Fs).await()
  const watched = join(directory, 'input.txt')
  const source = join(directory, 'consumer.ts')
  await writeFile(watched, 'before')
  await writeFile(source, `import { ModuleGraph } from 'bun'
import { state } from '${controls}'
const graph = ModuleGraph.current
export const inject = ['fs']
export async function apply(ctx) {
  const watcher = ctx.fs.watch(${JSON.stringify(watched)})
  watcher.on('change', async () => {
    state.before = ModuleGraph.current === graph
    state.entered.resolve()
    await state.finish.promise
    state.after = ModuleGraph.current === graph
    state.finished = true
  })
  ctx.effect(() => () => { state.cleaned = true })
  ctx.resources.onRetire(() => { watcher.on('ready', () => { state.late = true }) })
  await ctx.join(watcher.dispose)
}
`)
  const namespace = await modules.import(pathToFileURL(source).href)
  const fiber = ctx.plugin(modules.unwrapExports(namespace))
  await fiber.await()
  await writeFile(watched, 'after')
  await state.entered.promise
  let stopped = false
  let graphClosed = false
  stopping = fiber.dispose().then(() => { stopped = true })
  closing = modules.dispose().then(() => { graphClosed = true })
  await setImmediate()
  const premature = stopped || graphClosed || state.cleaned || modules.current.unit.disposed
  state.finish.resolve()
  await stopping
  await closing
  assert.equal(state.before, true)
  assert.equal(state.after, true)
  assert.equal(premature, false, 'cleanup and graph disposal must wait for the admitted file callback')
  assert.equal(state.finished, true)
  assert.equal(state.cleaned, true)
  assert.equal(state.late, false, 'retirement must reject new file callback admission')
  console.log('BUN_WATCHER_LIFETIME_OK')
} finally {
  state.finish.resolve()
  await Promise.allSettled([stopping, closing])
  await ctx.fiber.dispose()
  await modules.dispose()
  clearTimeout(deadline)
  await rm(directory, { recursive: true, force: true })
}
