import { ModuleGraph } from 'bun'
import type { ExecutionUnit } from 'cordis'
import { abortedImport, bootstrapURL, bridgeImport, fileURL, runInHost } from './bridge.ts'

interface Bootstrap {
  files(): string[]
  load(url: string): Promise<unknown>
}

export class BunExecutionUnit implements ExecutionUnit {
  private _graph: ModuleGraph
  private _references = 1
  private _closing = false
  private _disposed = false
  private _aborted = false
  private _imports = new Set<() => void>()
  private _bootstrap?: Bootstrap
  private _loading?: Promise<Bootstrap>
  private _files = new Set<string>()
  private _completion = runInHost(() => Promise.withResolvers<void>())

  constructor(
    public readonly name: string,
    private readonly _residents: ReadonlySet<string> = new Set(),
    onError?: (error: unknown) => void,
  ) {
    this._graph = runInHost(() => new ModuleGraph({ onError }))
  }

  get disposed(): boolean {
    return this._disposed
  }

  get references(): number {
    return this._references
  }

  invoke<T>(execute: () => T): T {
    return this._graph.run(execute)
  }

  host<T>(execute: () => T): T {
    return runInHost(execute)
  }

  retain(): () => void {
    if (this._disposed) throw new Error(`Bun execution unit ${this.name} is disposed`)
    this._references++
    let released = false
    return () => {
      if (released) return
      released = true
      this._references--
      this._release()
    }
  }

  import(url: string): Promise<unknown> {
    return this.host(async () => {
      if (this._aborted || this._closing) throw abortedImport()
      this._loading ??= bridgeImport(() => this._graph.import<Bootstrap>(bootstrapURL), this._imports)
        .then(bootstrap => this._bootstrap = bootstrap)
      const bootstrap = await this._loading
      if (this._aborted || this._closing) throw abortedImport()
      return bridgeImport(() => this.invoke(() => bootstrap.load(url)), this._imports)
    })
  }

  files(): ReadonlySet<string> {
    if (!this._disposed && this._bootstrap) {
      this._files.clear()
      for (const filename of this.invoke(() => this._bootstrap!.files())) {
        const url = fileURL(filename)
        if (url && url !== bootstrapURL && !this._residents.has(url)) this._files.add(url)
      }
    }
    return this._files
  }

  abortImports(): void {
    this._aborted = true
    for (const cancel of this._imports) cancel()
  }

  dispose(): void {
    if (this._closing) return
    this._closing = true
    this.abortImports()
    this._references--
    this._release()
  }

  whenDisposed(): Promise<void> {
    return this._completion.promise
  }

  private _release(): void {
    if (!this._closing || this._references) return
    this.host(() => {
      try {
        this.files()
        this._graph.dispose()
        this._disposed = true
        this._bootstrap = undefined
        this._loading = undefined
        this._completion.resolve()
      } catch (error) {
        this._completion.reject(error)
        throw error
      }
    })
  }
}
