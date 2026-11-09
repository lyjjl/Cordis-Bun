import { build, Transpiler } from 'bun'
import {
  bindExecution, type Context, executionContext, type ExecutionUnit, type Fiber, type Plugin, ReflectService, type ResourceOwner,
} from 'cordis'
import type { ModuleSource } from '@cordisjs/plugin-loader'
import { unwrapExports as unwrapModule } from '@cordisjs/loader-utils'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  abortedImport, collectResidentFiles, fileURL, registerResidentFiles, registerResidents, type Resident, resolveModule, runInHost, sourceLoader,
} from './bridge.ts'
import { BunExecutionUnit } from './unit.ts'

export { BunExecutionUnit } from './unit.ts'

export interface LoadedPlugin {
  url: string
  plugin: Plugin
  namespace: unknown
}

export interface ModuleGeneration {
  unit: BunExecutionUnit
  plugins: Map<string, LoadedPlugin>
}

/**
 * Hold publication from old teardown through candidate activation/restoration.
 * Each selection admits only its own run() continuations; old managed tasks
 * captured at admission can finish imports during the initial teardown phase.
 * This does not undo arbitrary module-top-level or global side effects.
 */
export interface ModuleActivation {
  run<T>(execute: () => T): T
  select(generation: ModuleGeneration): void
  restore(): void
  commit(): void
  rollback(): void
}

export interface BunModuleLoaderOptions {
  residents?: Record<string, Record<string, unknown>>
  onError?: (error: unknown) => void
  /** Normalize an unwrapped host description before native execution binding. */
  adaptPlugin?: (exported: unknown) => Plugin
}

interface RootRequest {
  specifier: string
  parentURL?: string
}

interface ImportGate {
  promise: Promise<void>
  resolve(): void
  locks: number
}

interface ActivationPhase {
  generation: ModuleGeneration
  owners?: ReadonlyMap<AbortSignal | ResourceOwner, Context>
}

let generationId = 0

/** One reloadable application graph, with the framework resident in its host. */
export class BunModuleLoader implements ModuleSource {
  private _current: ModuleGeneration
  private _generations = new Set<ModuleGeneration>()
  private _residents: ReadonlyMap<string, Resident>
  private _residentFiles: Set<string>
  private _roots = new Map<string, RootRequest>()
  private _bindings = new WeakMap<object, Plugin>()
  private _normalized = new WeakMap<object, Plugin>()
  private _activationContext = new AsyncLocalStorage<ActivationPhase>()
  private _activation?: ActivationPhase
  private _gate?: ImportGate
  private _aborted = false
  private _closing = false
  private _disposal?: Promise<void>
  private _transpilers = new Map<string, Transpiler>()

  constructor(private readonly _options: BunModuleLoaderOptions = {}) {
    this._residents = registerResidents(_options.residents)
    this._residentFiles = collectResidentFiles()
    registerResidentFiles(import.meta.url)
    this._current = this._createGeneration()
  }

  get current(): ModuleGeneration {
    return this._current
  }

  get residentFiles(): ReadonlySet<string> {
    return this._residentFiles
  }

  get roots(): ReadonlySet<string> {
    return this._resolveRoots(true)
  }

  import(specifier: string, parentURL?: string): Promise<unknown> {
    return runInHost(async () => {
      this._assertOpen()
      // Remember before resolution and evaluation, including the first attempt
      // at a file/package that will become available after an edit or install.
      const requestKey = `${parentURL ?? ''}\0${specifier}`
      if (!this._roots.has(requestKey)) this._roots.set(requestKey, { specifier, parentURL })
      while (true) {
        for (let gate = this._publicationGate(); gate; gate = this._publicationGate()) await gate.promise
        this._assertOpen()
        const key = fileURL(specifier) ?? specifier
        let resident = this._residents.get(key)
        const url = resident ? key : resolveModule(specifier, parentURL)
        // A host namespace already owns its imports and needs no importer-side aliases.
        if (!resident && (url.startsWith('file:') || parentURL)) registerResidentFiles(url.startsWith('file:') ? url : parentURL!)
        resident ??= this._residents.get(url)
        if (resident || this._isResident(url)) {
          const namespace = resident?.namespace ?? await import(/* @vite-ignore */ url)
          for (let gate = this._publicationGate(); gate; gate = this._publicationGate()) await gate.promise
          this._assertOpen()
          this._bind(namespace, undefined)
          collectResidentFiles()
          return namespace
        }
        const generation = this._current
        let namespace: unknown
        try {
          const cachedFiles = generation.plugins.has(url) ? undefined : generation.unit.files()
          if (cachedFiles && !cachedFiles.has(url)) {
            await this._prepareSources([url], cachedFiles)
            this._assertOpen()
            if (generation !== this._current) continue
          }
          namespace = await generation.unit.import(url)
        } catch (error) {
          for (let gate = this._publicationGate(); gate; gate = this._publicationGate()) await gate.promise
          this._assertOpen()
          if (generation !== this._current && !this._aborted && !this._closing) continue
          throw error
        }
        for (let gate = this._publicationGate(); gate; gate = this._publicationGate()) await gate.promise
        this._assertOpen()
        // A lock covers in-flight publication as well as import admission.
        // After unlock, retired results retry against the selected graph.
        if (generation !== this._current) continue
        const plugin = this._bind(namespace, generation.unit)
        generation.plugins.set(url, { url, namespace, plugin })
        return namespace
      }
    })
  }

  unwrapExports(namespace: unknown): Plugin {
    return this._bind(namespace, undefined)
  }

  lock(): () => void {
    return runInHost(() => {
      this._assertOpen()
      if (!this._gate) {
        const { promise, resolve } = Promise.withResolvers<void>()
        this._gate = { promise, resolve, locks: 0 }
      }
      const gate = this._gate
      gate.locks++
      let released = false
      return () => {
        if (released) return
        released = true
        if (this._gate !== gate || --gate.locks) return
        this._openGate()
      }
    })
  }

  prepare(): Promise<readonly string[]> {
    return runInHost(async () => {
      this._assertOpen()
      const roots = this._resolveRoots()
      await this._prepareSources([...roots])
      this._assertOpen()
      return [...roots]
    })
  }

  private async _prepareSources(roots: readonly string[], cachedFiles?: ReadonlySet<string>): Promise<void> {
    if (!roots.length) return
    // Use Bun's own static closure, including extensionless imports. Runtime
    // hooks cannot observe those requests and must not replace ordinary source.
    const result = await build({
      entrypoints: roots.map(url => fileURLToPath(url)),
      target: 'bun',
      format: 'esm',
      packages: 'external',
      external: [
        ...[...this._residents.keys()].filter(specifier => !specifier.startsWith('file:')),
        ...[...this._residentFiles].map(url => fileURLToPath(url)),
      ],
      plugins: [{
        name: 'cordis-resident-importers',
        setup: (builder) => {
          builder.onResolve({ filter: /.*/ }, (args) => {
            // Metadata preparation must not resolve or parse modules before
            // native evaluation reaches import(), require() or require.resolve().
            switch (args.kind) {
              case 'dynamic-import':
              case 'require-call':
              case 'require-resolve':
                return { path: args.path, external: true }
            }
            if (this._residents.has(args.path)) return { path: args.path, external: true }
            const parent = args.importer ? pathToFileURL(args.importer).href : undefined
            if (parent) registerResidentFiles(parent)
            let url: string
            try {
              url = resolveModule(args.path, parent)
            } catch {
              // Let Bun report its own unresolved import with source location.
              return
            }
            if (this._isResident(url) || cachedFiles?.has(url)) {
              return { path: url.startsWith('file:') ? fileURLToPath(url) : url, external: true }
            }
          })
          builder.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ }, (args) => {
            registerResidentFiles(pathToFileURL(args.path).href)
          })
        },
      }],
      throw: false,
    })
    if (!result.success) throw new AggregateError(result.logs, 'Bun source preparation')
  }

  loadGeneration(): Promise<ModuleGeneration> {
    return runInHost(async () => {
      this._assertOpen()
      const roots = this._resolveRoots()
      const generation = this._createGeneration()
      try {
        await Promise.all([...roots].map(async (url) => {
          const namespace = await generation.unit.import(url)
          const plugin = this._bind(namespace, generation.unit)
          generation.plugins.set(url, { url, namespace, plugin })
        }))
        this._assertOpen()
        return generation
      } catch (error) {
        generation.unit.dispose()
        await generation.unit.whenDisposed()
        throw error
      }
    })
  }

  commit(generation: ModuleGeneration): void {
    if (this._activation) throw new Error('Bun activation must settle before committing another generation')
    runInHost(() => {
      this._assertOpen()
      if (!this._generations.has(generation) || generation.unit.disposed) {
        throw new Error('Bun candidate generation belongs to another loader or is disposed')
      }
      const previous = this._current
      this._current = generation
      this._openGate()
      // Core owns the remaining activation/callback leases. In particular,
      // this never waits for a self-HMR callback's actual code continuation.
      if (previous !== generation) previous.unit.dispose()
    })
  }

  /** Begin before old teardown; publication stays private until final settlement. */
  beginActivation(owners?: ReadonlySet<Fiber>): ModuleActivation {
    return runInHost(() => {
      this._assertOpen()
      if (this._activation) throw new Error('Bun generation activation is already in progress')
      const unlock = this.lock()
      const previous = this._current
      let candidate: ModuleGeneration | undefined
      let captured: Map<AbortSignal | ResourceOwner, Context> | undefined
      const teardown: ActivationPhase = { generation: previous }
      let phase = teardown
      const capture = () => {
        if (!owners?.size) return
        captured ??= new Map()
        for (const fiber of owners) {
          const ctx = fiber.ctx
          captured.set(fiber.signal, ctx)
          captured.set(ctx.resources, ctx)
        }
        teardown.owners = captured
      }
      capture()
      this._activation = phase
      let finished = false
      const assertActive = () => {
        if (finished || this._activation !== phase) throw new Error('Bun generation activation has already settled')
      }
      const select = (generation: ModuleGeneration) => {
        phase = { generation }
        this._activation = phase
        this._current = generation
      }
      return {
        run: <T>(execute: () => T): T => runInHost(() => {
          assertActive()
          if (phase === teardown && owners) {
            capture()
            // Admission can renew while preparation is pending. Wake receipts
            // to recheck ownership without opening publication to foreign work.
            const gate = this._gate
            if (gate) {
              const resolve = gate.resolve
              const next = Promise.withResolvers<void>()
              gate.promise = next.promise
              gate.resolve = next.resolve
              resolve()
            }
          }
          return this._activationContext.run(phase, execute)
        }),
        select: generation => runInHost(() => {
          assertActive()
          if (candidate || !this._generations.has(generation) || generation.unit.disposed || generation === previous) {
            throw new Error('Bun activation requires one live candidate from this loader')
          }
          candidate = generation
          select(generation)
        }),
        restore: () => runInHost(() => {
          assertActive()
          select(previous)
        }),
        commit: () => runInHost(() => {
          assertActive()
          if (!candidate || this._current !== candidate) throw new Error('cannot commit a restored Bun generation')
          finished = true
          this._activation = undefined
          try {
            previous.unit.dispose()
          } finally {
            unlock()
          }
        }),
        rollback: () => runInHost(() => {
          if (finished) return
          assertActive()
          this._current = previous
          finished = true
          this._activation = undefined
          try {
            candidate?.unit.dispose()
          } finally {
            unlock()
          }
        }),
      }
    })
  }

  abortImports(): void {
    runInHost(() => {
      this._aborted = true
      for (const generation of this._generations) generation.unit.abortImports()
      this._openGate()
    })
  }

  dispose(): Promise<void> {
    return runInHost(() => {
      if (this._disposal) return this._disposal
      this._closing = true
      this.abortImports()
      const generations = [...this._generations]
      for (const generation of generations) generation.unit.dispose()
      return this._disposal = Promise.all(generations.map(generation => generation.unit.whenDisposed()))
        .then(() => {})
    })
  }

  getLinked(url: string): Promise<string[]> {
    return runInHost(async () => {
      if (!url.startsWith('file:')) return []
      const loader = sourceLoader(fileURLToPath(url))
      if (!loader) return []
      registerResidentFiles(url)
      let transpiler = this._transpilers.get(loader)
      if (!transpiler) {
        transpiler = new Transpiler({ loader, target: 'bun' })
        this._transpilers.set(loader, transpiler)
      }
      const source = await readFile(new URL(url), 'utf8')
      const linked = new Set<string>()
      for (const imported of transpiler.scanImports(source)) {
        if (imported.kind !== 'import-statement' && imported.kind !== 'require-call') continue
        try {
          linked.add(resolveModule(imported.path, url))
        } catch (error) {
          if (!this._residents.has(imported.path)) throw error
        }
      }
      return [...linked]
    })
  }

  private _resolveRoots(ignoreUnresolved = false): Set<string> {
    const roots = new Set<string>()
    for (const { specifier, parentURL } of this._roots.values()) {
      if (this._residents.has(fileURL(specifier) ?? specifier)) continue
      let url: string
      try {
        url = resolveModule(specifier, parentURL)
      } catch (error) {
        if (ignoreUnresolved) continue
        throw error
      }
      registerResidentFiles(url)
      if (!this._isResident(url)) roots.add(url)
    }
    return roots
  }

  private _isResident(url: string): boolean {
    return !url.startsWith('file:') || this._residentFiles.has(url) || url.endsWith('.node')
  }

  private _assertOpen(): void {
    if (this._aborted || this._closing) throw abortedImport()
  }

  // Locks can rotate during import evaluation; read fresh at every publication boundary.
  private _publicationGate(): ImportGate | undefined {
    const phase = this._activation
    if (phase && phase.generation === this._current) {
      if (this._activationContext.getStore() === phase) return
      const context = executionContext.getStore()
      if (this._ownsImport(phase, context?.resourceOwner)) return
      for (let node = context?.node; node; node = node.caller) {
        if (node.finished) continue
        if (this._ownsImport(phase, node.resourceOwner) || this._ownsImport(phase, node.scope?.signal)) return
      }
    }
    return this._gate
  }

  private _ownsImport(phase: ActivationPhase, origin: AbortSignal | ResourceOwner | undefined): boolean {
    const owner = origin && phase.owners?.get(origin)
    return !!owner && ReflectService.isBindingViewOpen(owner)
  }

  private _openGate(): void {
    const gate = this._gate
    this._gate = undefined
    gate?.resolve()
  }

  private _createGeneration(): ModuleGeneration {
    const unit = new BunExecutionUnit(`cordis-${++generationId}`, this._residentFiles, this._options.onError)
    const generation = { unit, plugins: new Map<string, LoadedPlugin>() }
    this._generations.add(generation)
    const released = () => { this._generations.delete(generation) }
    unit.whenDisposed().then(released, released)
    return generation
  }

  private _bind(namespace: unknown, unit: ExecutionUnit | undefined): Plugin {
    const key = namespace && (typeof namespace === 'object' || typeof namespace === 'function') ? namespace : undefined
    if (key && this._bindings.has(key)) return this._bindings.get(key)!
    const exported: unknown = unwrapModule(namespace)
    const description = exported && (typeof exported === 'object' || typeof exported === 'function') ? exported : undefined
    let normalized: Plugin
    if (description && this._normalized.has(description)) {
      normalized = this._normalized.get(description)!
    } else {
      normalized = this._options.adaptPlugin ? this._options.adaptPlugin(exported) : exported as Plugin
      if (description) this._normalized.set(description, normalized)
    }
    // Core owns validation. Binding remains per source namespace, so two roots
    // that re-export one description retain distinct native source identities.
    const plugin = normalized && (typeof normalized === 'object' || typeof normalized === 'function')
      ? bindExecution(normalized, unit)
      : normalized
    if (plugin && (typeof plugin === 'object' || typeof plugin === 'function')) this._bindings.set(plugin, plugin)
    if (key) this._bindings.set(key, plugin)
    return plugin
  }
}
