import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { resolveExecution } from 'cordis'
import { BunModuleLoader } from '../src/index.ts'

assert.ok(process.versions.bun, 'Run with Bun: bun packages/host-bun/tests/generations.ts')
const directory = await mkdtemp(join(tmpdir(), 'cordis-bun-generations-'))
const deadline = setTimeout(() => { throw new Error('Bun generation regression deadline exceeded') }, 20000)
let fixtureId = 0

function version(namespace: unknown) {
  assert.ok(namespace && typeof namespace === 'object' && 'version' in namespace)
  return namespace.version
}

async function publication(reject: boolean) {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const state = { entered, released, evaluations: 0 }
  const controls = `@cordisjs/native-publication-${process.pid}-${++fixtureId}`
  const loader = new BunModuleLoader({ residents: { [controls]: { state } } })
  const filename = join(directory, `publication-${fixtureId}.ts`)
  const url = pathToFileURL(filename).href
  const failure = new Error('old graph import rejection')
  const source = `import { state } from '${controls}'
const evaluation = ++state.evaluations
if (evaluation === 1) {
  state.entered.resolve()
  await state.released.promise
}
export const version = evaluation
export default function app() {}
`
  let unlock = () => {}
  let published = false
  let received: unknown
  const old = loader.current.unit
  const releaseOld = old.retain()
  try {
    await writeFile(filename, source)
    const importing = loader.import(url).then(
      value => { published = true; received = value; return value },
      error => { published = true; received = error; throw error },
    )
    // Handle the consumer's receipt even on the red path.
    importing.catch(() => {})
    await entered.promise
    const rawImport = old.import(url)
    rawImport.catch(() => {})
    unlock = loader.lock()
    if (reject) released.reject(failure)
    else released.resolve()
    if (reject) await assert.rejects(rawImport, error => error === failure)
    else assert.equal(version(await rawImport), 1)
    // Native graph completion is observed first. A host event-loop checkpoint
    // then drains its consumer continuations while the lock remains held.
    await setImmediate()
    assert.equal(loader.current.unit, old)
    assert.equal(published, false, 'a completed in-flight import stays private while locked')
    assert.equal(received, undefined)
    if (reject) {
      await loader.prepare()
      const candidate = await loader.loadGeneration()
      loader.commit(candidate)
      const namespace = await importing
      assert.equal(version(namespace), 2)
      assert.equal(namespace, candidate.plugins.get(url)!.namespace)
    } else {
      unlock()
      const namespace = await importing
      assert.equal(version(namespace), 1)
      assert.equal(namespace, loader.current.plugins.get(url)!.namespace)
    }
  } finally {
    released.resolve()
    unlock()
    releaseOld()
    await loader.dispose()
  }
}

async function removedDependency() {
  const loader = new BunModuleLoader()
  const root = join(directory, 'remove-root.ts')
  const dependency = join(directory, 'removed-dependency.ts')
  const url = pathToFileURL(root).href
  try {
    await writeFile(dependency, 'export const version = "old"\n')
    await writeFile(root, 'export { version } from "./removed-dependency.ts"; export default function app() {}\n')
    assert.equal(version(await loader.import(url)), 'old')
    const old = loader.current
    await writeFile(root, 'export const version = "new"; export default function app() {}\n')
    await rm(dependency)
    const roots = await loader.prepare()
    assert.deepEqual(roots, [url])
    const candidate = await loader.loadGeneration()
    assert.equal(version(candidate.plugins.get(url)!.namespace), 'new')
    loader.commit(candidate)
    await old.unit.whenDisposed()
    assert.equal(old.unit.disposed, true)

    // A dependency removed from the candidate closure is irrelevant; a new
    // actual static dependency, or the actual root itself, still participates.
    await writeFile(root, 'import "./required-current-dependency.ts"; export default function app() {}\n')
    await assert.rejects(loader.prepare(), AggregateError)
    assert.equal(loader.current, candidate)
    await writeFile(join(directory, 'required-current-dependency.ts'), 'export const value = ;\n')
    await assert.rejects(loader.prepare(), AggregateError)
    await writeFile(join(directory, 'required-current-dependency.ts'), 'export const value = 1\n')
    assert.deepEqual(await loader.prepare(), [url])
    await rm(root)
    await assert.rejects(loader.prepare(), AggregateError)
    assert.equal(loader.current, candidate)
  } finally {
    await loader.dispose()
  }
}

async function activationPublication(restore: boolean) {
  const loader = new BunModuleLoader()
  const filename = join(directory, `activation-${restore}.ts`)
  const url = pathToFileURL(filename).href
  let finish: (() => void) | undefined
  let unlock = () => {}
  const releaseStale = Promise.withResolvers<void>()
  try {
    await writeFile(filename, 'export const version = "old"; export default function app() {}\n')
    const original = await loader.import(url)
    const previous = loader.current
    await writeFile(filename, 'export const version = "candidate"; export default function app() {}\n')
    await loader.prepare()
    const candidate = await loader.loadGeneration()
    unlock = loader.lock()
    const activation = loader.beginActivation()
    activation.select(candidate)
    finish = () => activation.rollback()
    let published = false
    const importing = loader.import(url).then(namespace => { published = true; return namespace })
    importing.catch(() => {})
    await setImmediate()
    assert.equal(published, false, 'unrelated imports cannot publish a provisional graph')
    assert.equal(previous.unit.disposed, false)
    assert.equal(version(await activation.run(() => loader.import(url))), 'candidate')
    let stalePublished = false
    const stale = activation.run(async () => {
      await releaseStale.promise
      const namespace = await loader.import(url)
      stalePublished = true
      return namespace
    })
    stale.catch(() => {})
    if (restore) {
      activation.restore()
      assert.equal(loader.current, previous)
      assert.equal(await activation.run(() => loader.import(url)), original, 'the old graph remains import-eligible')
      releaseStale.resolve()
      await setImmediate()
      assert.equal(published, false, 'restoration completes before the publication gate opens')
      assert.equal(stalePublished, false, 'candidate continuations lose activation admission when the previous graph is selected')
      activation.rollback()
      finish = undefined
      await setImmediate()
      assert.equal(published, false, 'settling activation preserves an enclosing publication lock')
      unlock()
      assert.equal(await stale, original)
      assert.equal(await importing, original)
      await candidate.unit.whenDisposed()
      assert.equal(candidate.unit.disposed, true)
      assert.equal(previous.unit.disposed, false)
    } else {
      activation.commit()
      finish = undefined
      releaseStale.resolve()
      await setImmediate()
      assert.equal(published, false, 'committing activation preserves an enclosing publication lock')
      unlock()
      assert.equal(version(await stale), 'candidate')
      assert.equal(await importing, candidate.plugins.get(url)!.namespace)
      await previous.unit.whenDisposed()
      assert.equal(previous.unit.disposed, true)
      assert.equal(loader.current, candidate)
    }
  } finally {
    releaseStale.resolve()
    unlock()
    finish?.()
    await loader.dispose()
  }
}

async function residentAliases() {
  const fixture = join(directory, 'resident-aliases')
  const name = `native-resident-${process.pid}-${++fixtureId}`
  const packageDirectory = join(fixture, 'node_modules', name)
  const packageFile = join(packageDirectory, 'index.js')
  const packageURL = pathToFileURL(packageFile).href
  const firstURL = pathToFileURL(join(fixture, 'first.ts')).href
  const secondURL = pathToFileURL(join(fixture, 'second.ts')).href
  await mkdir(packageDirectory, { recursive: true })
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
    name, type: 'module', exports: { '.': './index.js', './sub': './sub.js' },
  }))
  await writeFile(packageFile, 'export const shared = { count: 10 }\n')
  await writeFile(join(packageDirectory, 'sub.js'), 'export const sub = { version: "old" }\n')
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    type: 'module', imports: { '#shared': name },
  }))
  await writeFile(join(fixture, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { 'alias-shared': [`./node_modules/${name}/index.js`] } },
  }))
  await writeFile(join(fixture, 'local.ts'), 'export const local = { version: "old" }\n')
  for (const [filename, specifier] of [['first.ts', '#shared'], ['second.ts', 'alias-shared']]) {
    await writeFile(join(fixture, filename), `
import { shared } from '${specifier}'
import { sub } from '${name}/sub'
import { local } from './local.ts'
export { shared, sub, local }
export const observed = ++shared.count
export default function app() {}
`)
  }
  // The package and its paths are generated at runtime to exercise real host imports.
  const host = await import(packageURL) as { shared: { count: number } }
  const hostSub = await import(pathToFileURL(join(packageDirectory, 'sub.js')).href)
  const loader = new BunModuleLoader({ residents: { [name]: host } })
  type Namespace = { shared: typeof host.shared; sub: { version: string }; local: { version: string }; observed: number }
  try {
    const first = await loader.import(firstURL) as Namespace
    const second = await loader.import(secondURL) as Namespace
    assert.equal(first.shared, host.shared)
    assert.equal(second.shared, host.shared)
    assert.deepEqual([first.observed, second.observed], [11, 12])
    assert.equal(host.shared.count, 12)
    assert.equal(await loader.import(packageURL), host, 'a canonical file root preserves the supplied namespace')
    assert.equal(first.local, second.local)
    assert.equal(first.sub, second.sub)
    assert.notEqual(first.sub, hostSub.sub, 'a resident package entry does not make other subpaths resident')
    assert.ok(loader.residentFiles.has(packageURL))
    assert.equal(loader.current.unit.files().has(packageURL), false)
    assert.deepEqual(await loader.getLinked(firstURL), [
      packageURL, pathToFileURL(join(packageDirectory, 'sub.js')).href, pathToFileURL(join(fixture, 'local.ts')).href,
    ])
    await writeFile(join(fixture, 'local.ts'), 'export const local = { version: "new" }\n')
    await writeFile(join(packageDirectory, 'sub.js'), 'export const sub = { version: "new" }\n')
    const previous = loader.current
    const roots = await loader.prepare()
    assert.deepEqual(new Set(roots), new Set([firstURL, secondURL]))
    const candidate = await loader.loadGeneration()
    const nextFirst = candidate.plugins.get(firstURL)!.namespace as Namespace
    const nextSecond = candidate.plugins.get(secondURL)!.namespace as Namespace
    assert.equal(nextFirst.shared, host.shared)
    assert.equal(nextSecond.shared, host.shared)
    assert.deepEqual([nextFirst.observed, nextSecond.observed].sort(), [13, 14])
    assert.equal(host.shared.count, 14)
    assert.equal(nextFirst.local, nextSecond.local)
    assert.notEqual(nextFirst.local, first.local)
    assert.equal(nextFirst.local.version, 'new')
    assert.equal(nextFirst.sub, nextSecond.sub)
    assert.notEqual(nextFirst.sub, first.sub)
    assert.equal(nextFirst.sub.version, 'new')
    loader.commit(candidate)
    await previous.unit.whenDisposed()
    assert.equal(await loader.import(firstURL), nextFirst)
    assert.equal(await loader.import(secondURL), nextSecond)
    assert.equal(await loader.import(packageURL), host)
    assert.equal(host.shared.count, 14)
  } finally {
    await loader.dispose()
  }
}

async function nestedResidentAliases() {
  const fixture = join(directory, `nested-residents-${++fixtureId}`)
  const nested = join(fixture, 'nested')
  const name = `native-nested-resident-${process.pid}-${fixtureId}`
  const packageDirectory = join(nested, 'node_modules', name)
  const jsxName = 'react'
  const jsxDirectory = join(nested, 'node_modules', jsxName)
  const packageURL = pathToFileURL(join(packageDirectory, 'index.js')).href
  const root = pathToFileURL(join(fixture, 'root.ts')).href
  const subpath = join(packageDirectory, 'sub.js')
  const shared = { count: 7 }
  await mkdir(packageDirectory, { recursive: true })
  await mkdir(jsxDirectory, { recursive: true })
  await writeFile(join(jsxDirectory, 'package.json'), JSON.stringify({
    name: jsxName, type: 'module', exports: { './jsx-runtime': './runtime.js', './jsx-dev-runtime': './runtime.js' },
  }))
  await writeFile(join(jsxDirectory, 'runtime.js'), 'export function jsx(type, props) { return { type, count: props.count } }; export { jsx as jsxs, jsx as jsxDEV }\n')
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
    name, type: 'module', exports: { '.': './index.js', './sub': './sub.js' },
  }))
  await writeFile(join(packageDirectory, 'index.js'), 'export const shared = { count: 100 }\n')
  await writeFile(subpath, 'export const sub = { version: "old" }\n')
  await writeFile(join(nested, 'package.json'), JSON.stringify({
    type: 'module', imports: { '#shared': name },
  }))
  await writeFile(join(nested, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: { 'nested-shared': [`./node_modules/${name}/index.js`] },
    },
  }))
  await writeFile(join(nested, 'imports.ts'), `export { shared } from '#shared'; export { sub } from '${name}/sub'\n`)
  await writeFile(join(nested, 'paths.ts'), "export { shared } from 'nested-shared'\n")
  await writeFile(join(nested, 'view.tsx'), 'const count: number = 3; export const view = <widget count={count} />\n')
  await writeFile(join(fixture, 'data.json'), '{"answer":42}\n')
  await writeFile(join(fixture, 'root.ts'), `
export { shared as importsShared, sub } from './nested/imports.ts'
export { shared as pathsShared } from './nested/paths.ts'
export { view } from './nested/view.tsx'
import payload from './data.json'
export const answer: number = payload.answer
export default function app() {}
`)
  const loader = new BunModuleLoader({ residents: { [name]: { shared } } })
  type Namespace = { importsShared: object; pathsShared: object; sub: { version: string }; view: object; answer: number }
  try {
    const first = await loader.import(root) as Namespace
    assert.equal(first.importsShared, shared, 'package imports resolve residents at the transitive importer')
    assert.equal(first.pathsShared, shared, 'nested tsconfig aliases resolve the same resident namespace')
    assert.ok(loader.residentFiles.has(packageURL))
    assert.equal(loader.current.unit.files().has(packageURL), false)
    assert.equal(first.sub.version, 'old')
    assert.deepEqual(first.view, { type: 'widget', count: 3 })
    assert.equal(first.answer, 42, 'the importer boundary leaves native JSON loading intact')
    await writeFile(subpath, 'export const sub = { version: "new" }\n')
    await loader.prepare()
    const candidate = await loader.loadGeneration()
    const next = candidate.plugins.get(root)!.namespace as Namespace
    assert.equal(next.importsShared, shared)
    assert.equal(next.pathsShared, shared)
    assert.notEqual(next.sub, first.sub, 'registering a package entry does not retain unregistered subpaths')
    assert.equal(next.sub.version, 'new')
    loader.commit(candidate)
  } finally {
    await loader.dispose()
  }
}

async function processResidents() {
  const earlier = new BunModuleLoader()
  const filename = join(directory, `process-resident-${++fixtureId}.ts`)
  const url = pathToFileURL(filename).href
  const name = `native-process-resident-${process.pid}-${fixtureId}`
  const shared = {}
  const namespace = { shared, default: function resident() {} }
  await writeFile(filename, 'export const shared = {}; export default function disk() {}\n')
  const registering = new BunModuleLoader({ residents: { [name]: namespace, [url]: namespace } })
  try {
    assert.equal(await earlier.import(name), namespace, 'an earlier loader uses later process-wide named registration')
    assert.equal(await earlier.import(url), namespace, 'an earlier loader uses later process-wide file registration')
    assert.equal(resolveExecution(earlier.unwrapExports(namespace)), undefined)
    assert.equal(earlier.roots.has(url), false, 'resident file roots never become application roots')
    assert.equal(earlier.current.unit.files().has(url), false)
    assert.ok(earlier.residentFiles.has(url))
    await registering.dispose()
    assert.equal(await earlier.import(name), namespace, 'a process object module outlives its registering loader')
    assert.equal(await earlier.import(url), namespace)
  } finally {
    await earlier.dispose()
    await registering.dispose()
  }
}

async function hostBoundary() {
  const fixture = join(directory, `host-boundary-${++fixtureId}`)
  const nested = join(fixture, 'nested')
  const name = `native-host-boundary-${process.pid}-${fixtureId}`
  const packageDirectory = join(nested, 'node_modules', name)
  const root = pathToFileURL(join(fixture, 'managed.ts')).href
  const first = join(fixture, '01-managed.test.ts')
  const second = join(fixture, '02-host.test.ts')
  await mkdir(packageDirectory, { recursive: true })
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
    name, type: 'module', exports: './index.js',
  }))
  await writeFile(join(packageDirectory, 'index.js'), 'export const shared = { resident: false }\n')
  await writeFile(join(nested, 'package.json'), JSON.stringify({ imports: { '#sdk': name } }))
  await writeFile(join(nested, 'bridge.ts'), "export { shared } from '#sdk'\n")
  await writeFile(join(fixture, 'managed.ts'), `
export { shared } from './nested/bridge.ts'
export const graph = Bun.ModuleGraph.current
export function apply() {}
`)
  await writeFile(first, `
import { expect, test } from 'bun:test'
import { ModuleGraph } from 'bun'
import { BunModuleLoader } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)}
test('managed imports retain real resident identity in their execution graph', async () => {
  const shared = { resident: true }
  const loader = new BunModuleLoader({ residents: { ${JSON.stringify(name)}: { shared } } })
  try {
    const namespace = await loader.import(${JSON.stringify(root)})
    expect(namespace.shared).toBe(shared)
    expect(namespace.graph).toBe(loader.current.unit.invoke(() => ModuleGraph.current))
    expect(namespace.graph).not.toBe(ModuleGraph.current)
  } finally {
    await loader.dispose()
  }
})
`)
  await writeFile(second, `
import { expect, test } from 'bun:test'
const received = []
test.each([1, 2])('ordinary host table callback %d', async value => {
  await Promise.resolve()
  received.push(value)
  expect(typeof value).toBe('number')
})
test('ordinary host asynchronous completion survives managed graph retirement', async () => {
  const gate = Promise.withResolvers()
  queueMicrotask(gate.resolve)
  await gate.promise
  expect(received).toEqual([1, 2])
})
`)
  const child = Bun.spawn([process.execPath, 'test', first, second], {
    cwd: fixture,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  assert.equal(status, 0, stdout + stderr)
}

const cases = {
  success: () => publication(false),
  rejection: () => publication(true),
  removed: removedDependency,
  activation: () => activationPublication(false),
  rollback: () => activationPublication(true),
  residents: residentAliases,
  nestedResidents: nestedResidentAliases,
  processResidents,
  hostBoundary,
}
const selected = new Set(process.argv.slice(2))
try {
  for (const [name, run] of Object.entries(cases)) {
    if (!selected.size || selected.has(name)) await run()
  }
  console.log('BUN_GENERATIONS_NATIVE_OK')
} finally {
  clearTimeout(deadline)
  await rm(directory, { recursive: true, force: true })
}
