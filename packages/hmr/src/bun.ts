import { asHost, Context, executionContext, type ExecutionUnit, type Fiber, FiberState, type FiberTarget, invoke, Service } from 'cordis'
import { BunModuleLoader, type ModuleActivation, type ModuleGeneration } from '@cordisjs/host-bun'
import type {} from '@cordisjs/plugin-fs-node'
import type {} from '@cordisjs/plugin-loader'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Config } from './config.ts'
import type Hmr from './index.ts'
import type { HmrService } from './index.ts'

type Changes = () => Iterable<string> | PromiseLike<Iterable<string>>

interface ActivationScope {
  owners: Set<Fiber>
  previous: ReadonlyMap<Fiber, FiberTarget>
}

function matches(url: string, roots: Set<string>) {
  if (!url.startsWith('file:')) return false
  const filename = fileURLToPath(url)
  for (const root of roots) {
    const path = relative(root, filename)
    if (!path || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)) return true
  }
  return false
}

export default class BunHmr extends Service implements HmrService {
  static Config = Config
  static inject = ['loader']

  public baseDir: string
  public hostModules = new Set<string>()
  private _control: Context
  private _modules: BunModuleLoader
  private _queue: Promise<void> = Promise.resolve()
  private _storage = new AsyncLocalStorage<symbol>()
  private _current?: symbol

  constructor(ctx: Context, public config: Hmr.Config) {
    super(ctx, 'hmr')
    this._control = ctx
    if (!ctx.loader.moduleSource) {
      const owner = ctx.loader.context
      const modules = new BunModuleLoader({
        residents: { '@cordisjs/plugin-hmr': { default: BunHmr } },
        onError: error => owner.logger.error(error),
      })
      owner.resources.onRetire(() => modules.abortImports())
      owner.resources.effect(() => modules.dispose(), 'Bun application module source')
      ctx.loader.moduleSource = modules
    }
    if (!(ctx.loader.moduleSource instanceof BunModuleLoader)) {
      throw new TypeError('Bun HMR requires Loader.Config.modules to use BunModuleLoader')
    }
    this._modules = ctx.loader.moduleSource
    this.baseDir = config.base && isAbsolute(config.base)
      ? resolve(config.base)
      : fileURLToPath(new URL(config.base || '.', ctx.baseUrl || pathToFileURL(process.cwd() + sep).href))
    for (const url of this._modules.residentFiles) this.hostModules.add(url)
    ctx.inject(['fs'], ctx => this._watch(ctx))
  }

  getLinked(url: string) {
    return this._modules.getLinked(url)
  }

  reconcile(callback: Changes): Promise<Hmr.Result> {
    const current = this._storage.getStore()
    if (current && current === this._current) {
      return asHost(() => Promise.reject(new Error('cannot start a transaction inside another transaction')))
    }
    const unit = executionContext.getStore()?.unit
    const release = unit?.retain()
    try {
      return asHost(() => this._control.task(() => {
        const task = this._queue.then(() => {
          const id = Symbol('Bun HMR transaction')
          this._current = id
          return this._storage.run(id, () => this._reconcile(callback, unit)).finally(() => {
            this._current = undefined
          })
        })
        this._queue = task.then(() => {}, () => {})
        return task.finally(release)
      }, 'Bun plugin code replacement'))
    } catch (error) {
      release?.()
      throw error
    }
  }

  private async _reconcile(callback: Changes, unit?: ExecutionUnit): Promise<Hmr.Result> {
    const changes = await invoke(unit, async () => [...await callback()])
    const roots = new Set<string>()
    for (const root of changes) {
      if (typeof root !== 'string' || !isAbsolute(root)) {
        throw new TypeError(`invalid root ${JSON.stringify(root)}, expected an absolute path`)
      }
      roots.add(resolve(root))
    }
    const result: Hmr.Result = { settledFibers: [], importFailures: [], skippedHostModules: [] }
    if (!roots.size) return result
    const old = this._modules.current
    const files = new Set([...old.unit.files(), ...this._modules.roots])
    for (const url of this._modules.residentFiles) this.hostModules.add(url)
    const changed = [...files].filter(url => matches(url, roots))
    for (const url of new Set([...this.hostModules, ...[...files].filter(url => url.endsWith('.node'))])) {
      if (matches(url, roots)) result.skippedHostModules.push(url)
    }
    if (!changed.some(url => !this.hostModules.has(url) && !url.endsWith('.node'))) return result

    let previousFibers = this._fibers(old, undefined, true)
    const previousOwners = new Set(previousFibers)
    for (const entry of this._entries(previousFibers)) {
      if (entry.outerFiber?.uid) previousOwners.add(entry.outerFiber.ctx.fiber)
    }
    const previousTargets = new Map<Fiber, FiberTarget>()
    const scope: ActivationScope = { owners: previousOwners, previous: previousTargets }
    let paused: Fiber[] = []
    let candidate: ModuleGeneration | undefined
    let selected = false
    let activation: ModuleActivation | undefined = this._modules.beginActivation(previousOwners)
    try {
      try {
        await this._modules.prepare()
      } catch (error) {
        this._importFailure(result, changed, error)
        return result
      }
      previousFibers = this._fibers(old, undefined, true)
      previousOwners.clear()
      for (const fiber of previousFibers) previousOwners.add(fiber)
      for (const entry of this._entries(previousFibers)) {
        if (entry.outerFiber?.uid) previousOwners.add(entry.outerFiber.ctx.fiber)
      }
      for (const fiber of previousOwners) previousTargets.set(fiber, fiber._captureTarget())
      paused = this._roots(previousFibers)
      const stops = await activation.run(() => Promise.allSettled(paused.map(fiber => fiber.uid === null ? undefined : fiber._suspend())))
      const errors = stops.filter((stop): stop is PromiseRejectedResult => stop.status === 'rejected').map(stop => stop.reason)
      if (errors.length) throw new AggregateError(errors, 'Bun plugin cleanup during code replacement')
      try {
        candidate = await this._modules.loadGeneration()
        for (const { url, plugin } of candidate.plugins.values()) {
          if (!this._control.registry.resolve(plugin)) throw new TypeError(`invalid plugin export from ${url}`)
        }
      } catch (error) {
        candidate?.unit.dispose()
        this._importFailure(result, changed, error)
        return result
      }
      activation.select(candidate)
      selected = true
      const previousErrors = new Set(this._control.loader.errors)
      const fibers = await activation.run(async () => {
        const fibers = await this._activate(old, candidate!, scope, paused)
        await this._settle(candidate!, scope)
        return fibers
      })
      const failures = new Set<unknown>()
      if (this.config.activationFailure === 'rollback') {
        const members = this._fibers(candidate, scope.owners, true)
        for (const fiber of members) {
          if (fiber.state === FiberState.FAILED) failures.add(fiber.lastError)
        }
        for (const entry of this._entries(members)) {
          for (const error of entry.errors) {
            if (!previousErrors.has(error)) failures.add(error)
          }
        }
      }
      const settled = activation
      activation = undefined
      if (failures.size) {
        const error = failures.size === 1 ? [...failures][0] : new AggregateError(failures, 'Bun candidate activation failed')
        await this._rollback(settled, old, candidate, paused, scope)
        result.activationFailures = [{ urls: changed, error }]
      } else {
        settled.commit()
      }
      result.settledFibers = [...fibers].filter(fiber => fiber.uid !== null)
      return result
    } catch (error) {
      if (activation) {
        const rejected = activation
        activation = undefined
        try {
          await this._rollback(rejected, old, selected ? candidate : undefined, paused, scope)
        } catch (restoration) {
          throw new AggregateError([error, restoration], 'Bun code replacement and restoration failed')
        }
      }
      throw error
    } finally {
      if (activation) await this._rollback(activation, old, undefined, paused, scope)
    }
  }

  private _fibers(generation: ModuleGeneration, owners?: ReadonlySet<Fiber>, includeDependents = false): Set<Fiber> {
    const fibers = new Set<Fiber>()
    for (const runtime of this._control.registry.values()) {
      for (const fiber of runtime.fibers) {
        if (fiber.uid !== null && !fibers.has(fiber) && (fiber.execution === generation.unit || owners?.has(fiber))) {
          fiber._collectAffectedFibers(fibers, includeDependents)
        }
      }
    }
    return fibers
  }

  private _entries(fibers: ReadonlySet<Fiber>) {
    return [...this._control.loader.entries()].filter(entry =>
      fibers.has(entry.ctx.fiber)
      || entry.outerFiber && fibers.has(entry.outerFiber.ctx.fiber)
      || entry.innerFiber && fibers.has(entry.innerFiber.ctx.fiber),
    )
  }

  private _roots(fibers: Set<Fiber>): Fiber[] {
    return [...fibers].filter((fiber) => {
      if (fiber.uid === null) return false
      let parent = fiber.parent.fiber
      while (parent !== parent.parent.fiber) {
        if (parent.uid !== null && fibers.has(parent)) return false
        parent = parent.parent.fiber
      }
      return parent.uid === null || !fibers.has(parent)
    })
  }

  private _replace(previous: ModuleGeneration, next: ModuleGeneration, targets?: ReadonlyMap<Fiber, FiberTarget>): Set<Fiber> {
    const fibers = new Set<Fiber>()
    for (const { url, plugin } of previous.plugins.values()) {
      const replacement = next.plugins.get(url)
      if (!replacement) continue
      for (const fiber of this._control.registry.replace(plugin, replacement.plugin, targets)) fibers.add(fiber)
    }
    return fibers
  }

  private async _activate(previous: ModuleGeneration, next: ModuleGeneration, scope: ActivationScope, paused: Fiber[]) {
    const fibers = this._replace(previous, next)
    await Promise.all([...fibers].map(fiber => fiber.await().catch(() => {})))
    await Promise.allSettled(paused.filter(fiber => fiber.uid !== null && !fibers.has(fiber)).map(fiber => fiber._resume()))
    const retries = [...this._control.loader.entries()].filter(entry =>
      !entry._initTask && !entry.outerFiber?.uid && !entry.innerFiber?.uid
      && (entry.errors.length || entry.innerFiber?.uid === null || entry.outerFiber?.uid === null),
    )
    await Promise.all(retries.map(async (entry) => {
      // Native teardown may leave a terminal wrapper reference. Close it via
      // Entry before refresh applies the current registered/disabled verdict.
      if (entry.outerFiber?.uid === null) await entry.dispose()
      await entry.refresh()
      const fiber = entry.outerFiber ?? entry.innerFiber
      if (fiber?.uid) scope.owners.add(fiber.ctx.fiber)
    }))
    return fibers
  }

  private async _settle(generation: ModuleGeneration, scope: ActivationScope) {
    while (true) {
      const members = this._fibers(generation, scope.owners, true)
      const pending: Promise<unknown>[] = []
      for (const fiber of members) {
        if (fiber.inertia) pending.push(fiber.await())
      }
      for (const entry of this._entries(members)) {
        if (entry._initTask) pending.push(entry._initTask)
      }
      if (!pending.length) return
      await Promise.allSettled(pending)
    }
  }

  private async _rollback(
    activation: ModuleActivation,
    previous: ModuleGeneration,
    candidate: ModuleGeneration | undefined,
    paused: Fiber[],
    scope: ActivationScope,
  ) {
    const errors: unknown[] = []
    if (!candidate && !paused.length) {
      activation.rollback()
      return
    }
    try {
      if (candidate) {
        await activation.run(async () => {
          const restorable = new Set<Fiber>()
          for (const { url, plugin } of candidate.plugins.values()) {
            if (!previous.plugins.has(url)) continue
            for (const fiber of this._control.registry.get(plugin)?.fibers || []) {
              if (fiber.uid !== null) restorable.add(fiber)
            }
          }
          const members = new Set([
            ...this._fibers(candidate),
            ...[...scope.owners].filter(fiber => fiber.uid !== null && !scope.previous.has(fiber)),
          ])
          const obsolete = [...members].filter(fiber => !restorable.has(fiber))
          const obsoleteIds = new Set(obsolete.map(fiber => fiber.uid))
          // Retire a candidate-only entry through Loader so its host-owned outer
          // wrapper and import revisions close too. Native refresh remains the
          // sole admission check when a later corrected graph retries the orphan.
          const entries = [...this._control.loader.entries()].filter(entry =>
            entry.innerFiber && obsoleteIds.has(entry.innerFiber.uid)
            || entry.outerFiber && obsoleteIds.has(entry.outerFiber.uid),
          )
          const roots = this._roots(new Set([...members, ...paused.filter(fiber => fiber.uid !== null)]))
          const stopped = await Promise.allSettled(roots.map(fiber => fiber.uid === null ? undefined : fiber._suspend()))
          errors.push(...stopped.filter((stop): stop is PromiseRejectedResult => stop.status === 'rejected').map(stop => stop.reason))
          const retiredEntries = await Promise.allSettled(entries.map(entry => entry.dispose()))
          errors.push(...retiredEntries.filter((stop): stop is PromiseRejectedResult => stop.status === 'rejected').map(stop => stop.reason))
          const retired = await Promise.allSettled(
            obsolete.filter(fiber => fiber.uid !== null).map(fiber => fiber.dispose()),
          )
          errors.push(...retired.filter((stop): stop is PromiseRejectedResult => stop.status === 'rejected').map(stop => stop.reason))
        })
      }
      activation.restore()
      // New admission is bound to the restored generation. Candidate tails
      // retain their code, but cannot reuse candidate publication privileges.
      await activation.run(async () => {
        if (candidate) this._replace(candidate, previous, scope.previous)
        try {
          await this._restore(scope.previous)
        } catch (error) {
          errors.push(error)
        }
        await this._settle(previous, scope)
        for (const fiber of this._fibers(previous, scope.owners, true)) {
          if (fiber.state === FiberState.FAILED && !fiber._hasTargetError(scope.previous.get(fiber))) errors.push(fiber.lastError)
        }
      })
    } finally {
      activation.rollback()
    }
    if (errors.length) throw new AggregateError(errors, 'Bun plugin restoration after candidate activation')
  }

  private async _restore(targets: ReadonlyMap<Fiber, FiberTarget>) {
    const pending: Promise<unknown>[] = []
    for (const [fiber, target] of targets) {
      if (fiber.uid !== null && fiber.parent.fiber.accepting) pending.push(fiber._resume(target))
    }
    const resumed = await Promise.allSettled(pending)
    const errors = resumed.filter((resume): resume is PromiseRejectedResult => resume.status === 'rejected').map(resume => resume.reason)
    if (errors.length) throw new AggregateError(errors, 'Bun plugin restoration after rejected candidate')
  }

  private _importFailure(result: Hmr.Result, changed: string[], error: unknown) {
    result.importFailures.push({ urls: changed, error })
    this._control.logger.warn(error)
  }

  private _watch(ctx: Context) {
    const { enabled, files, debounce } = this.config.watch
    if (!enabled || !files.length) return
    const stashed = new Set<string>()
    const retained = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let flushing = Promise.resolve()
    ctx.effect(() => () => clearTimeout(timer))
    const flush = async () => {
      if (!stashed.size || !ctx.fiber.accepting) return
      const changes = new Set([...retained, ...stashed])
      retained.clear()
      stashed.clear()
      try {
        const result = await this.reconcile(() => changes)
        for (const { urls } of result.importFailures) {
          for (const url of urls) if (url.startsWith('file:')) retained.add(fileURLToPath(url))
        }
        if (result.skippedHostModules.length) {
          this._control.logger.info(
            'host modules pending process restart: %o',
            result.skippedHostModules.map(url => relative(this.baseDir, fileURLToPath(url))),
          )
        }
      } catch (error) {
        this._control.logger.warn(error)
        for (const filename of changes) retained.add(filename)
      }
    }
    ctx.fs.watch(this.baseDir, { filter: files }).on('change', (filename) => {
      stashed.add(filename)
      clearTimeout(timer)
      timer = setTimeout(() => { flushing = flushing.then(flush) }, debounce)
    })
  }
}
