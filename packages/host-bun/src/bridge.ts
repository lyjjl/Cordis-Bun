import { existsSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ModuleGraph, plugin, resolveSync } from 'bun'
import * as cordis from 'cordis'
import * as loader from '@cordisjs/plugin-loader'
import * as host from './index.ts'

// The process-lifetime coordination graph keeps host receipts alive and only
// switches Bun's graph context, preserving all application AsyncLocalStorage.
const control = new ModuleGraph()

export function runInHost<T>(execute: () => T): T {
  return control.run(execute)
}

export const bootstrapURL = new URL(
  import.meta.url.endsWith('.ts') ? './bootstrap.ts' : './bootstrap.js',
  import.meta.url,
).href

export function fileURL(filename: string): string | undefined {
  if (filename.startsWith('file:')) return pathToFileURL(fileURLToPath(filename)).href
  if (isAbsolute(filename)) return pathToFileURL(filename).href
}

export function sourceLoader(filename: string) {
  const extension = extname(filename).toLowerCase()
  return /^(?:\.ts|\.mts|\.cts)$/.test(extension) ? 'ts'
    : extension === '.tsx' ? 'tsx'
      : extension === '.jsx' ? 'jsx'
        : /^(?:\.js|\.mjs|\.cjs)$/.test(extension) ? 'js' : undefined
}

export function resolveModule(specifier: string, parentURL?: string): string {
  if (isBuiltin(specifier)) return specifier.startsWith('node:') ? specifier : 'node:' + specifier
  const parent = parentURL?.startsWith('file:') ? fileURLToPath(parentURL) : parentURL
  const base = parent ? parentURL!.endsWith('/') ? parent : dirname(parent) : process.cwd()
  const path = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier
  const resolving = resolvingNative
  resolvingNative = true
  try {
    const resolved = resolveSync(path, base)
    return fileURL(resolved) ?? resolved
  } catch (error) {
    // Keep a file root's intended URL even while it is being created or fixed.
    // Bare requests keep their original parent in the loader until resolution.
    if (isAbsolute(path) || path.startsWith('.')) return pathToFileURL(resolve(base, path)).href
    throw error
  } finally {
    resolvingNative = resolving
  }
}

export function abortedImport(): DOMException {
  return new DOMException('Bun module imports have been stopped', 'AbortError')
}

/** Bridge a graph-owned completion and cancellation to a host-owned receipt. */
export function bridgeImport<T>(start: () => PromiseLike<T>, pending: Set<() => void>): Promise<T> {
  return runInHost(() => {
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    let settled = false
    const cancel = () => settle(false, abortedImport())
    const settle = (success: boolean, value: unknown) => {
      if (settled) return
      settled = true
      pending.delete(cancel)
      if (success) resolve(value as T)
      else reject(value)
    }
    pending.add(cancel)
    try {
      start().then(value => settle(true, value), error => settle(false, error))
    } catch (error) {
      settle(false, error)
    }
    return promise
  })
}

export interface Resident {
  namespace: Record<string, unknown>
}

// Bun's object-module registrations are process-wide and have no individual
// unregister operation. Keep one registration per name, never clearAll().
const registered = new Map<string, Resident>()
const residentFiles = new Set<string>([bootstrapURL])
const hostCache = createRequire(import.meta.url).cache
let registration = 0
let resolvingNative = false

function assertResident(specifier: string, previous: Resident, namespace: Record<string, unknown>): void {
  const keys = Object.keys(namespace)
  if (Object.keys(previous.namespace).length !== keys.length
    || keys.some(key => !Object.hasOwn(previous.namespace, key) || previous.namespace[key] !== namespace[key])) {
    throw new Error(`Bun resident ${specifier} already has another host definition`)
  }
}

function installResidents(additions: ReadonlyMap<string, Resident>): void {
  if (!additions.size) return
  const installImporter = !registration
  plugin({
    name: `cordis-host-residents-${++registration}`,
    setup(builder) {
      if (installImporter) {
        // Observe resolution without replacing ordinary source: runtime onLoad
        // in Bun 1.4.4 loses CommonJS format and cannot fall through.
        builder.onResolve({ filter: /.*/, namespace: 'file' }, (args) => {
          if (resolvingNative) return
          const parent = fileURL(args.importer)
          if (parent && sourceLoader(args.importer)) registerResidentFiles(parent)
          let url = fileURL(args.path)
          if (!url && parent && sourceLoader(args.path)) url = fileURL(resolveModule(args.path, parent))
          if (!url) return
          if (!registered.has(url) && sourceLoader(fileURLToPath(url))) registerResidentFiles(url)
          if (registered.has(url)) return { path: fileURLToPath(url), namespace: 'file' }
        })
      }
      for (const [specifier, resident] of additions) {
        const path = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier
        builder.module(path, () => ({ loader: 'object', exports: resident.namespace }))
      }
    },
  })
  for (const specifier of additions.keys()) {
    if (specifier.startsWith('file:')) residentFiles.add(specifier)
  }
  for (const [specifier, resident] of additions) registered.set(specifier, resident)
}

/** Register the same object module under Bun's canonical, importer-resolved path. */
export function registerResidentFiles(parentURL: string): void {
  if (resolvingNative) return
  // Canonical aliases describe installed files. Bun switches to its package
  // manager in scopes outside a node_modules tree; those scopes use resident names.
  const parent = fileURL(parentURL)
  if (!parent) return
  let directory = fileURLToPath(parent)
  if (!parent.endsWith('/')) directory = dirname(directory)
  while (!existsSync(resolve(directory, 'node_modules'))) {
    const ancestor = dirname(directory)
    if (ancestor === directory) return
    directory = ancestor
  }
  resolvingNative = true
  try {
    runInHost(() => {
      const additions = new Map<string, Resident>()
      for (const [specifier, resident] of registered) {
        if (specifier.startsWith('file:')) continue
        let url: string | undefined
        try {
          url = fileURL(resolveModule(specifier, parentURL))
        } catch {
          // A virtual resident, or a package unavailable from this importer.
        }
        if (!url) continue
        const previous = registered.get(url) ?? additions.get(url)
        if (previous) assertResident(url, previous, resident.namespace)
        else additions.set(url, resident)
      }
      installResidents(additions)
    })
  } finally {
    resolvingNative = false
  }
}

export function collectResidentFiles(): Set<string> {
  return runInHost(() => {
    for (const filename of Object.keys(hostCache)) {
      const url = fileURL(filename)
      if (url) residentFiles.add(url)
    }
    return residentFiles
  })
}

export function registerResidents(additional: Record<string, Record<string, unknown>> = {}): ReadonlyMap<string, Resident> {
  return runInHost(() => {
    const requested: [string, Record<string, unknown>][] = [
      ['cordis', cordis],
      ['@cordisjs/plugin-loader', loader],
      ['@cordisjs/host-bun', host],
      ...Object.entries(additional),
    ]
    const additions = new Map<string, Resident>()
    for (const [specifier, namespace] of requested) {
      const key = fileURL(specifier) ?? specifier
      const previous = registered.get(key) ?? additions.get(key)
      if (previous) {
        assertResident(specifier, previous, namespace)
        continue
      }
      additions.set(key, { namespace })
    }
    installResidents(additions)
    return registered
  })
}
