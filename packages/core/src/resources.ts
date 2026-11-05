import { asHost, invoke } from './execution.ts'
import type { ExecutionUnit } from './execution.ts'

export type Cleanup = () => void | Promise<void>

export interface ResourceOwner {
  readonly signal: AbortSignal
  readonly active: boolean
  onRetire(callback: () => void): () => void
  effect(cleanup: Cleanup, label?: string): () => Promise<void>
  acquire(): (() => void) | undefined
  run<T>(execute: () => T): T
}

export interface ResourceDiagnostics {
  readonly label: string
}

export interface ScopeDiagnostics {
  readonly label: string
  readonly state: 'active' | 'retiring' | 'disposed'
  readonly active: boolean
  readonly leases: number
  readonly resources: readonly ResourceDiagnostics[]
  readonly error: unknown
}

interface EffectRecord {
  cleanup: Cleanup | undefined
  readonly label: string
  promise: Promise<void> | undefined
}

/** Strict resource lifetime, independent of managed-task lifecycle handoff. */
export class ResourceScope implements ResourceOwner {
  private readonly _controller = new AbortController()
  private readonly _retire = new Set<() => void>()
  private readonly _effects: EffectRecord[] = []
  private readonly _pending = new Set<EffectRecord>()
  private readonly _errors: unknown[] = []
  private _state: ScopeDiagnostics['state'] = 'active'
  private _leases = 0
  private _drain: PromiseWithResolvers<void> | undefined
  private _disposePromise: Promise<void> | undefined
  private _error: unknown
  private _execution: ExecutionUnit | undefined
  private _releaseExecution: (() => void) | undefined

  constructor(private readonly _label = 'scope', execution?: ExecutionUnit) {
    this._execution = execution
    this._releaseExecution = asHost(() => execution?.retain())
  }

  get signal(): AbortSignal {
    return this._controller.signal
  }

  get active(): boolean {
    return this._state === 'active'
  }

  onRetire(callback: () => void): () => void {
    if (!this.active) {
      // A late hook only detaches; after final disposal there is no owned unit.
      invoke(this._execution, callback)
      return () => {}
    }
    this._retire.add(callback)
    return () => { this._retire.delete(callback) }
  }

  effect(cleanup: Cleanup, label = 'effect'): () => Promise<void> {
    if (!this.active) throw new Error(`Resource scope "${this._label}" is retired`)
    return this._collectCleanup(cleanup, label)
  }

  /** Framework-only collection of cleanup returned by already-admitted setup. */
  _collectCleanup(cleanup: Cleanup, label: string): () => Promise<void> {
    if (this._state === 'disposed') throw new Error(`Resource scope "${this._label}" is disposed`)
    const record: EffectRecord = { cleanup, label, promise: undefined }
    this._effects.push(record)
    return () => {
      if (!record.promise) this._effects.splice(this._effects.indexOf(record), 1)
      return this._startEffect(record)
    }
  }

  acquire(): (() => void) | undefined {
    if (!this.active) return
    this._leases++
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this._leases) return
      const drain = this._drain
      this._drain = undefined
      drain?.resolve()
    }
  }

  /** Framework barrier before child teardown; retire first to close admission. */
  _waitForLeases(): Promise<void> {
    return asHost(async () => {
      while (this._leases) {
        this._drain ??= Promise.withResolvers<void>()
        await this._drain.promise
      }
    })
  }

  /** Switch execution only; callers retain strict leases for asynchronous work. */
  run<T>(execute: () => T): T {
    if (this._state === 'disposed') throw new Error(`Resource scope "${this._label}" is disposed`)
    return invoke(this._execution, execute, this)
  }

  retire(): void {
    if (!this.active) return
    this._state = 'retiring'
    try {
      this.run(() => this._controller.abort())
    } catch (error) {
      this._errors.push(error)
    }
    for (const callback of this._retire) {
      try {
        this.run(callback)
      } catch (error) {
        this._errors.push(error)
      }
    }
    this._retire.clear()
  }

  dispose(): Promise<void> {
    if (this._disposePromise) return this._disposePromise
    const completion = asHost(() => Promise.withResolvers<void>())
    this._disposePromise = completion.promise
    this.retire()
    asHost(() => this._finish()).then(completion.resolve, completion.reject)
    return completion.promise
  }

  diagnostics(): ScopeDiagnostics {
    return {
      label: this._label,
      state: this._state,
      active: this.active,
      leases: this._leases,
      resources: [...this._effects, ...this._pending].map(({ label }) => ({ label })),
      error: this._error,
    }
  }

  private _startEffect(record: EffectRecord): Promise<void> {
    if (record.promise) return record.promise
    this._pending.add(record)
    record.promise = asHost(() => this._clean(record))
    record.promise.then(
      () => { this._pending.delete(record) },
      (error) => {
        this._errors.push(error)
        this._pending.delete(record)
      },
    )
    return record.promise
  }

  private async _clean(record: EffectRecord): Promise<void> {
    // Install the idempotent completion before cleanup can reenter its handle.
    await undefined
    while (this._leases) await this._waitForLeases()
    const cleanup = record.cleanup!
    record.cleanup = undefined
    await this.run(cleanup)
  }

  private async _finish(): Promise<void> {
    // retire() may have called dispose() reentrantly from a detachment hook.
    await this._waitForLeases()
    while (this._effects.length || this._pending.size) {
      while (this._effects.length) {
        try {
          await this._startEffect(this._effects.pop()!)
        } catch {
          // Each failure is collected once by _startEffect, including manual cleanup.
        }
      }
      if (this._pending.size) {
        await Promise.allSettled([...this._pending].map(record => record.promise!))
      }
    }
    this._state = 'disposed'
    const release = this._releaseExecution
    this._releaseExecution = undefined
    this._execution = undefined
    try {
      if (release) asHost(release)
    } catch (error) {
      this._errors.push(error)
    }
    if (this._errors.length) {
      this._error = new AggregateError(this._errors, `Resource scope "${this._label}" failed to dispose`)
      throw this._error
    }
  }
}
