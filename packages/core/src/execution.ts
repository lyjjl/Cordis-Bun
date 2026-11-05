import { AsyncLocalStorage } from 'node:async_hooks'
import type { WaitNode } from './completion.ts'
import type { Plugin } from './registry.ts'
import type { ResourceOwner } from './resources.ts'

export interface ExecutionUnit {
  readonly name: string
  invoke<T>(execute: () => T): T
  host<T>(execute: () => T): T
  retain(): () => void
}

export interface ExecutionContext {
  node?: WaitNode
  unit?: ExecutionUnit
  resourceOwner?: ResourceOwner
}

export const executionContext = new AsyncLocalStorage<ExecutionContext>()

const bindings = new WeakMap<Plugin, { unit: ExecutionUnit | undefined; key: Function }>()

export function asHost<T>(execute: () => T): T {
  const context = executionContext.getStore()
  return context?.unit
    ? context.unit.host(() => executionContext.run(context, execute))
    : execute()
}

export function invoke<T>(unit: ExecutionUnit | undefined, execute: () => T, resourceOwner?: ResourceOwner): T {
  const current = executionContext.getStore()
  const context: ExecutionContext = { ...current, unit, resourceOwner: resourceOwner ?? current?.resourceOwner }
  if (unit) {
    const release = asHost(() => unit.retain())
    try {
      return unit.invoke(() => executionContext.run(context, execute))
    } finally {
      asHost(release)
    }
  }
  return asHost(() => executionContext.run(context, execute))
}

export function bindExecution(plugin: Plugin, unit: ExecutionUnit | undefined): Plugin {
  const bound = new Proxy(Object.create(plugin) as Plugin.Object, {
    get: (_, key) => typeof plugin === 'function' && key === 'apply' ? plugin : Reflect.get(plugin, key, plugin),
  })
  // A binding owns its registry identity; the original callback remains intact.
  bindings.set(bound, { unit, key: function executionBinding() {} })
  return bound
}

export function resolveExecution(plugin: Plugin, fallback?: ExecutionUnit): ExecutionUnit | undefined {
  return bindings.has(plugin) ? bindings.get(plugin)!.unit : fallback
}

export function executionKey(plugin: Plugin): Function | undefined {
  return bindings.get(plugin)?.key
}
