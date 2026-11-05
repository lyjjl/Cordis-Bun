// This module is instantiated in each graph, so require.cache belongs to it.
export function files(): string[] {
  return Object.keys(require.cache)
}

export function load(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url)
}
