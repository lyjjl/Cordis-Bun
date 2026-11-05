import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const sandbox = process.env.CORDIS_BUN_ONLY_CHILD === '1'
const image = process.env.CORDIS_BUN_ONLY_IMAGE === '1'

async function deadline<T>(promise: Promise<T>, label: string) {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => expired.reject(new Error(label + ' exceeded its deadline')), 15000)
  try {
    return await Promise.race([promise, expired.promise])
  } finally {
    clearTimeout(timer)
  }
}

interface Probe {
  port: number
  pid: number
  version: string
  message: string
  activation: number
  runtime: string
  node: string | null
  graph: boolean
}

async function assertBunExecutable(node = Bun.which('node')) {
  if (!node) return
  // Bun may expose a node-named alias even before `bun run` creates a script environment.
  const alias = await stat(node, { bigint: true })
  const executable = await stat(process.execPath, { bigint: true })
  assert.deepEqual([alias.dev, alias.ino], [executable.dev, executable.ino])
}

async function exercise() {
  await assertBunExecutable()
  for (const name of await readdir(join(root, 'packages'))) {
    assert.equal(await Bun.file(join(root, 'packages', name, 'lib/index.js')).exists(), false)
  }
  const installed = Bun.spawn([process.execPath, 'install', '--frozen-lockfile'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  assert.equal(await deadline(installed.exited, 'Bun-only install'), 0)
  await assertBunExecutable()

  const fixture = join(root, 'runtime-fixture')
  const config = join(root, 'cordis.yml')
  const trace = join(root, 'shutdown-trace.txt')
  const shared = join(fixture, 'shared.ts')
  await mkdir(fixture)
  await writeFile(trace, '')
  await writeFile(shared, 'export const version = "A"; export const state = { activations: 0 }\n')
  await writeFile(join(fixture, 'main.ts'), `import { appendFile } from 'node:fs/promises'
import { version, state } from './shared.ts'
export const inject = ['fs']
export async function apply(ctx, config) {
  const activation = ++state.activations
  const watcher = ctx.fs.watch(${JSON.stringify(fixture)})
  const ready = Promise.withResolvers<void>()
  watcher.on('ready', ready.resolve)
  await ready.promise
  await ctx.task(async () => { await Bun.sleep(1) })
  ctx.logger.error('business-log-only')
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return Response.json({ port: server.port, pid: process.pid, version, message: config.message,
      activation, runtime: process.versions.bun, node: Bun.which('node'), graph: !!Bun.ModuleGraph.current })
  } })
  ctx.on('exit', signal => appendFile(${JSON.stringify(trace)}, 'signal:' + signal + '\\n'))
  ctx.effect(() => async () => {
    await appendFile(${JSON.stringify(trace)}, 'stop:' + version + ':' + config.message + ':' + activation + '\\n')
    server.stop(true)
  })
  if (config.reject) throw new Error('boot-apply-rejected')
  console.log(JSON.stringify({ event: 'BUN_ONLY_PORT', port: server.port, pid: process.pid }))
}
`)
  const composition = (message: string, reject = false) => [
    { id: 'logger', name: '@cordisjs/plugin-logger-console' },
    { id: 'fs', name: '@cordisjs/plugin-fs-node' },
    { id: 'timer', name: '@cordisjs/plugin-timer' },
    { id: 'hmr', name: '@cordisjs/plugin-hmr', config: { watch: { enabled: true, files: ['runtime-fixture/*.ts'], debounce: 5 } } },
    { id: 'app', name: './runtime-fixture/main.ts', config: { message, reject } },
  ]
  await writeFile(config, JSON.stringify(composition('one')) + '\n')
  const child = Bun.spawn([process.execPath, 'run', 'start'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  let output = ''
  let errors = ''
  let pending = ''
  let latest: Pick<Probe, 'port' | 'pid'> | undefined
  const collect = async (stream: ReadableStream<Uint8Array>, error: boolean) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true })
      if (error) { errors += text; continue }
      output += text
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop()!
      for (const line of lines) {
        if (!line.startsWith('{')) continue
        const data = JSON.parse(line)
        if (data.event === 'BUN_ONLY_PORT') latest = data
      }
    }
  }
  const stdout = collect(child.stdout, false)
  const stderr = collect(child.stderr, true)
  const observe = async (version: string, message: string) => deadline((async () => {
    while (true) {
      if (child.exitCode !== null) throw new Error(`application exited ${child.exitCode}\n${output}\n${errors}`)
      if (latest) {
        try {
          const response = await fetch(`http://127.0.0.1:${latest.port}`)
          const probe: Probe = await response.json()
          if (probe.version === version && probe.message === message && output.includes('Cordis ready')) return probe
        } catch {}
      }
      await Bun.sleep(10)
    }
  })(), `HTTP ${version}/${message}`)
  try {
    const initial = await observe('A', 'one')
    assert.equal(initial.runtime, process.versions.bun)
    await assertBunExecutable(initial.node)
    assert.equal(initial.graph, true)
    assert.equal(initial.activation, 1)

    await writeFile(config, JSON.stringify(composition('two')) + '\n')
    const configured = await observe('A', 'two')
    assert.equal(configured.activation, 2)

    await writeFile(shared, 'export const version = "B"; export const state = { activations: 0 }\n')
    const updated = await observe('B', 'two')
    assert.equal(updated.activation, 1)
    assert.equal(updated.pid, initial.pid)
    process.kill(updated.pid, 'SIGTERM')
    assert.equal(await deadline(child.exited, 'SIGTERM shutdown'), 0)
    await Promise.all([stdout, stderr])
    const stopped = (await readFile(trace, 'utf8')).trim().split('\n')
    assert.deepEqual(stopped, ['stop:A:one:1', 'stop:A:two:2', 'signal:SIGTERM', 'stop:B:two:1'])
  } catch (error) {
    console.error(output, errors)
    throw error
  } finally {
    if (child.exitCode === null) {
      if (latest) { try { process.kill(latest.pid, 'SIGKILL') } catch {} }
      child.kill('SIGKILL')
    }
    await child.exited
    await Promise.all([stdout, stderr])
  }

  const rejects = async (name: string, content: string, expected: string) => {
    await writeFile(join(root, name), content)
    const process = Bun.spawn([Bun.which('bun')!, 'packages/core/bin.js', name], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    const out = new Response(process.stdout).text()
    const err = new Response(process.stderr).text()
    try {
      assert.equal(await deadline(process.exited, name), 1)
      const diagnostic = await err
      assert(diagnostic.includes(expected), diagnostic)
      assert.equal((await out).includes('Cordis ready'), false)
    } finally {
      if (process.exitCode === null) process.kill('SIGKILL')
      await process.exited
    }
  }
  await rejects('malformed.yml', '- name: [\n', 'malformed.yml')
  await rejects('missing.yml', JSON.stringify([
    ...composition('missing-check'),
    { id: 'missing', name: './runtime-fixture/missing.ts' },
  ]), 'missing.ts')
  assert((await readFile(trace, 'utf8')).includes('stop:B:missing-check:1'))
  await rejects('apply.yml', JSON.stringify(composition('apply-check', true)), 'boot-apply-rejected')
  assert((await readFile(trace, 'utf8')).includes('stop:B:apply-check:1'))

  await rejects('validation.yml', JSON.stringify([
    { id: 'hmr', name: '@cordisjs/plugin-hmr', config: { watch: { debounce: -1 } } },
  ]), 'invalid config')
  await writeFile(join(fixture, 'shutdown.ts'), `export function apply(ctx, config) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('shutdown probe') })
  return () => {
    server.stop(true)
    if (config.reject) throw new Error('shutdown-cleanup-rejected')
  }
}
`)
  for (const [signal, reject] of [['SIGINT', false], ['SIGTERM', true]] as const) {
    const name = `shutdown-${signal}.json`
    await writeFile(join(root, name), JSON.stringify([{ id: 'app', name: './runtime-fixture/shutdown.ts', config: { reject } }]))
    const child = Bun.spawn([process.execPath, 'packages/core/bin.js', 'run', name], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    const ready = Promise.withResolvers<void>()
    const diagnostic = new Response(child.stderr).text()
    const output = (async () => {
      const decoder = new TextDecoder()
      let text = ''
      for await (const chunk of child.stdout) {
        text += decoder.decode(chunk, { stream: true })
        if (text.includes('Cordis ready')) ready.resolve()
      }
    })()
    child.exited.then(() => ready.reject(new Error(`${signal} probe exited before ready`)))
    try {
      await deadline(ready.promise, `${signal} startup`)
      child.kill(signal)
      assert.equal(await deadline(child.exited, signal), reject ? 1 : 0)
      await output
      const errors = await diagnostic
      if (reject) assert(errors.includes('shutdown-cleanup-rejected'), 'shutdown diagnostic accompanies exit 1')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
      await output
    }
  }
  console.log('BUN_ONLY_RUNTIME_OK: install, source boot, HTTP, config refresh, code HMR, signals, shutdown and bootstrap diagnostics')
}

if (sandbox) {
  await exercise()
} else {
  if (image) {
    await assertBunExecutable()
  } else {
    assert.equal(process.platform, 'linux', 'This isolation lane uses Linux bubblewrap')
    assert(Bun.which('bwrap'), 'Install bubblewrap to run the Bun-only isolation lane')
  }
  const temporary = await mkdtemp(join(tmpdir(), 'cordis-bun-only-'))
  const app = join(temporary, 'app')
  await mkdir(app)
  try {
    for (const filename of ['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.test.json']) {
      await cp(join(root, filename), join(app, filename))
    }
    await cp(join(root, 'packages'), join(app, 'packages'), {
      recursive: true,
      filter: (source) => {
        const name = basename(source)
        if (['node_modules', 'lib'].includes(name) || source.endsWith('.tsbuildinfo')) return false
        const tests = join(root, 'packages/host-bun/tests')
        if (name === 'tests') return source === tests
        if (source.startsWith(tests + sep)) return source === join(tests, 'bun-only.ts')
        return true
      },
    })
    const nodes = new Set<string>()
    const bun = await realpath(process.execPath)
    for (const directory of [...(process.env.PATH || '').split(delimiter), '/usr/bin', '/usr/local/bin']) {
      try {
        const candidate = await realpath(join(directory, 'node'))
        if (candidate !== bun && (await stat(candidate)).isFile()) nodes.add(candidate)
      } catch {}
    }
    const args = image ? [join(app, 'packages/host-bun/tests/bun-only.ts')] : [
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      '--bind', app, '/tmp/app', '--tmpfs', root,
      '--dir', '/tmp/runtime-bin', '--ro-bind', bun, '/tmp/runtime-bin/bun',
      '--dir', '/tmp/home', '--setenv', 'HOME', '/tmp/home',
      '--setenv', 'PATH', '/tmp/runtime-bin', '--setenv', 'BUN_INSTALL_CACHE_DIR', '/tmp/cache',
      '--setenv', 'CORDIS_BUN_ONLY_CHILD', '1',
      ...[...nodes].flatMap(node => ['--ro-bind', '/dev/null', node]),
      '--chdir', '/tmp/app', '--', '/tmp/runtime-bin/bun', 'packages/host-bun/tests/bun-only.ts',
    ]
    const isolated = Bun.spawn([image ? process.execPath : 'bwrap', ...args], {
      cwd: image ? app : root,
      env: image ? { ...process.env, PATH: dirname(process.execPath), BUN_INSTALL_CACHE_DIR: '/tmp/cache', CORDIS_BUN_ONLY_CHILD: '1' } : process.env,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    assert.equal(await isolated.exited, 0)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
