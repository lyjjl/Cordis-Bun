import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import * as include from '@cordisjs/plugin-include'
import * as logger from '@cordisjs/plugin-logger-console'
import * as filesystem from '@cordisjs/plugin-fs-node'
import * as timer from '@cordisjs/plugin-timer'
import * as group from '@cordisjs/plugin-group'
import * as hmr from '@cordisjs/plugin-hmr'
import * as packageManager from '@cordisjs/plugin-package-manager'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { file } from 'bun'
import { BunModuleLoader } from './index.ts'

const residents = {
  '@cordisjs/plugin-include': include,
  '@cordisjs/plugin-logger-console': logger,
  '@cordisjs/plugin-fs-node': filesystem,
  '@cordisjs/plugin-timer': timer,
  '@cordisjs/plugin-group': group,
  '@cordisjs/plugin-hmr': hmr,
  '@cordisjs/plugin-package-manager': packageManager,
}

/** Run the application directly; development tooling has its own Node entry. */
export async function run(argv = process.argv.slice(2)) {
  const args = argv[0] === 'run' ? argv.slice(1) : argv
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write('Usage: cordis [run] [app.yml | cordis.yml | config.yaml | config.json]\n')
    return
  }
  if (args.length > 1 || args[0]?.startsWith('-')) {
    throw new TypeError('Usage: cordis [run] [config.yaml|yml|json]')
  }
  const filename = resolve(args[0] || (await file('app.yml').exists() ? 'app.yml' : 'cordis.yml'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(process.cwd() + sep).href
  const modules = new BunModuleLoader({ residents, onError: error => ctx.logger.error(error) })
  const finished = Promise.withResolvers<void>()
  // Startup itself can reject before the lifetime latch is awaited.
  finished.promise.catch(() => {})
  let stopping: Promise<void> | undefined
  let receivedSignal: NodeJS.Signals | undefined

  const stop = (signal?: NodeJS.Signals) => {
    if (stopping) return stopping
    stopping = (async () => {
      modules.abortImports()
      const notifications = signal ? ctx.parallel('exit', signal) : undefined
      const outcomes = await Promise.allSettled([notifications, ctx.fiber.dispose()])
      const errors = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
      try {
        await modules.dispose()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length) throw new AggregateError(errors, 'Cordis runtime shutdown')
    })()
    stopping.then(finished.resolve, finished.reject)
    return stopping
  }
  const terminate = (signal: NodeJS.Signals) => {
    receivedSignal ??= signal
    stop(signal).catch(() => {})
  }
  const interrupt = () => terminate('SIGINT')
  const terminateSignal = () => terminate('SIGTERM')
  const beforeExit = () => { stop().catch(() => {}) }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminateSignal)
  process.once('beforeExit', beforeExit)
  try {
    await ctx.plugin(Loader, { modules })
    await ctx.loader.create({
      name: '@cordisjs/plugin-include',
      config: { path: pathToFileURL(filename).href, watch: true },
    })
    await ctx.loader.await()
    if (ctx.loader.errors.length) throw new AggregateError(ctx.loader.errors, `Cordis bootstrap: ${filename}`)
    if (!stopping) process.stdout.write(`Cordis ready (${filename}, Bun ${process.versions.bun})\n`)
    await finished.promise
  } catch (error) {
    if (!receivedSignal) {
      process.stderr.write(inspect(error, { depth: null }) + '\n')
      process.exitCode = 1
    }
    try {
      await stop()
    } catch (cleanupError) {
      if (receivedSignal || cleanupError !== error) process.stderr.write(inspect(cleanupError, { depth: null }) + '\n')
      process.exitCode = 1
    }
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminateSignal)
    process.off('beforeExit', beforeExit)
  }
}
