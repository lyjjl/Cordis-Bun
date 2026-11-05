import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, FiberState } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { BunModuleLoader } from '@cordisjs/host-bun'
import Hmr from '../src/bun.ts'

type Probe = {
  port: number
  version: string
  shared: object
  sdk: typeof Context
  graph: unknown
  count: number
}

declare module 'cordis' {
  interface Context {
    left: Probe
    right: Omit<Probe, 'port' | 'sdk'>
    resident: { check: symbol; self: symbol; identity: object }
  }
}

const directory = await mkdtemp(join(tmpdir(), 'cordis-bun-hmr-'))
const shared = join(directory, 'shared.ts')
const left = join(directory, 'left.ts')
const trace = join(directory, 'trace.txt')
const ctx = new Context()
const modules = new BunModuleLoader({ residents: { '@cordisjs/plugin-hmr': { default: Hmr } } })
const deadline = setTimeout(() => { throw new Error('Bun HMR acceptance deadline exceeded') }, 20000)

function leftCode() {
  return `import { Context } from 'cordis'
import { appendFile } from 'node:fs/promises'
import { version, state, next } from './shared.ts'
export const inject = ['resident', 'hmr']
export function apply(ctx) {
  const graph = Bun.ModuleGraph.current
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(version) })
  ctx.provide('left', { port: server.port, version, shared: state, count: next(), sdk: Context, graph })
  ctx.on(ctx.resident.check, result => result.push(Bun.ModuleGraph.current === graph))
  ctx.on(ctx.resident.self, async result => {
    await ctx.join(ctx.hmr.reconcile(() => [${JSON.stringify(shared)}]))
    result.push([version, Bun.ModuleGraph.current === graph])
  })
  return async () => {
    await appendFile(${JSON.stringify(trace)}, version + ':left:' + (Bun.ModuleGraph.current === graph) + '\\n')
    server.stop(true)
  }
}
`
}

async function setVersion(version: string) {
  await writeFile(shared, `export const version = ${JSON.stringify(version)}; export const state = {}; let n = 0; export function next() { return ++n }\n`)
}

async function response() {
  return fetch(`http://127.0.0.1:${ctx.left.port}`).then(response => response.text())
}

try {
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  const resident = { check: Symbol('check'), self: Symbol('self'), identity: {} }
  ctx.provide('resident', resident)
  await writeFile(trace, '')
  await setVersion('A')
  await writeFile(left, leftCode())
  await writeFile(join(directory, 'right.ts'), `import { appendFile } from 'node:fs/promises'
import { version, state, next } from './shared.ts'
export const inject = ['left']
export function apply(ctx) {
  const graph = Bun.ModuleGraph.current
  ctx.provide('right', { version, shared: state, count: next(), graph })
  return async () => {
    const response = await fetch('http://127.0.0.1:' + ctx.left.port)
    const body = await response.text()
    if (body !== version) throw new Error('consumer cleanup observed another service generation')
    await appendFile(${JSON.stringify(trace)}, version + ':right:' + (Bun.ModuleGraph.current === graph) + '\\n')
  }
}
`)
  await ctx.plugin(Loader, { modules })
  await ctx.plugin(Hmr, { watch: { enabled: false } })
  await ctx.loader.root.update([
    { id: 'left', name: './left.ts' },
    { id: 'right', name: './right.ts' },
  ])
  await ctx.loader.await()
  assert.deepEqual([...ctx.loader.errors], [])
  assert.equal(await response(), 'A')
  assert.equal(ctx.left.sdk, Context)
  assert.equal(ctx.left.shared, ctx.right.shared)
  assert.equal(ctx.left.graph, ctx.right.graph)
  assert.deepEqual([ctx.left.count, ctx.right.count], [1, 2])
  const originalIds = [ctx.loader.store.left.innerFiber!.uid, ctx.loader.store.right.innerFiber!.uid]
  const checks: boolean[] = []
  await ctx.parallel(resident.check, checks)
  assert.deepEqual(checks, [true])
  const beforeHostChange = modules.current.unit
  const hostUrl = new URL('../../core/src/index.ts', import.meta.url).href
  const hostChange = await ctx.hmr.reconcile(() => [fileURLToPath(hostUrl)])
  assert(hostChange.skippedHostModules.includes(hostUrl))
  assert.equal(modules.current.unit, beforeHostChange)

  const old = modules.current.unit
  await setVersion('B')
  const updated = await ctx.hmr.reconcile(() => [shared])
  assert.deepEqual(updated.importFailures, [])
  assert.equal(updated.settledFibers.length, 2)
  assert.equal(await response(), 'B')
  assert.equal(ctx.left.shared, ctx.right.shared)
  assert.deepEqual([ctx.left.count, ctx.right.count], [1, 2])
  assert.deepEqual([ctx.loader.store.left.innerFiber!.uid, ctx.loader.store.right.innerFiber!.uid], originalIds)
  assert.equal(ctx.resident, resident)
  await old.whenDisposed()
  assert.equal(old.disposed, true)
  assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n'), ['A:right:true', 'A:left:true'])

  const stable = modules.current.unit
  await writeFile(shared, 'export const version = ;\n')
  const syntax = await ctx.hmr.reconcile(() => [shared])
  assert.equal(syntax.importFailures.length, 1)
  assert.equal(modules.current.unit, stable)
  assert.equal(await response(), 'B')

  await writeFile(shared, 'throw new Error("candidate evaluation rejected"); export const version = "C"; export const state = {}; export function next() { return 1 }\n')
  const evaluated = await ctx.hmr.reconcile(() => [shared])
  assert.equal(evaluated.importFailures.length, 1)
  assert.equal(modules.current.unit, stable)
  assert.equal(await response(), 'B')
  assert.deepEqual([...ctx.loader.errors], [])

  await setVersion('D')
  const tails: [string, boolean][] = []
  await ctx.parallel(resident.self, tails)
  assert.deepEqual(tails, [['B', true]])
  assert.equal(await response(), 'D')
  await stable.whenDisposed()
  assert.equal(stable.disposed, true)

  await writeFile(left, 'export function apply() { throw new Error("new apply rejected") }\n')
  await ctx.hmr.reconcile(() => [left])
  assert.equal(ctx.loader.store.left.innerFiber!.state, FiberState.FAILED)
  assert(ctx.loader.errors.some(error => error instanceof Error && error.message === 'new apply rejected'))
  await setVersion('F')
  await writeFile(left, leftCode())
  await ctx.hmr.reconcile(() => [left, shared])
  assert.deepEqual([...ctx.loader.errors], [])
  assert.equal(await response(), 'F')
  assert.equal(ctx.right.version, 'F')
  console.log('BUN_HMR_SMOKE_OK')
} finally {
  await ctx.fiber.dispose()
  await modules.dispose()
  clearTimeout(deadline)
  await rm(directory, { recursive: true, force: true })
}
