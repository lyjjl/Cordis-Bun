import { createWaitNode, executeCompletion, refreshWaitNode, TaskCompletion, WaitNode } from './completion.ts'
import type { Activation, Fiber } from './fiber.ts'
import { asHost, invoke } from './execution.ts'

export interface TaskInfo {
  readonly label: string
  readonly signal: AbortSignal
}

export type TaskResult<T> = T extends PromiseLike<unknown> ? TaskCompletion<Awaited<T>> : T

export class TaskScope {
  private _accepting = true
  private _controller = new AbortController()
  private _tasks = new Map<TaskInfo, WaitNode>()
  private _stopping: Promise<void> | undefined
  private _draining: Promise<void> | undefined
  private _resolveDrain: (() => void) | undefined

  constructor(readonly owner: Fiber, readonly execution = owner.execution, readonly activation?: Activation) {}

  get accepting() {
    return this._accepting
  }

  get signal() {
    return this._controller.signal
  }

  get pending() {
    return this._tasks.size
  }

  getTasks(): readonly TaskInfo[] {
    return [...this._tasks.keys()]
  }

  run<T>(execute: (signal: AbortSignal) => T, label = 'anonymous', onError?: (error: unknown) => void): TaskResult<T> {
    return asHost(() => {
      if (!this._accepting) throw new Error('cannot create task on inactive context')
      const task: TaskInfo = { label, signal: this._controller.signal }
      const node = createWaitNode(this, task, undefined, this.execution)
      this._tasks.set(task, node)
      return executeCompletion(node, () => execute(task.signal), onError)
    })
  }

  drain(): Promise<void> {
    return asHost(() => {
      if (!this._tasks.size) return Promise.resolve()
      if (!this._draining) {
        const { promise, resolve } = Promise.withResolvers<void>()
        this._draining = promise
        this._resolveDrain = resolve
      }
      return this._draining
    })
  }

  stop(): Promise<void> {
    return asHost(() => {
      if (this._stopping) return this._stopping
      this._accepting = false
      this._stopping = this.drain()
      invoke(this.execution, () => this._controller.abort())
      for (const node of this._tasks.values()) refreshWaitNode(node)
      return this._stopping
    })
  }

  _has(task: TaskInfo): boolean {
    return this._tasks.has(task)
  }

  _release(task: TaskInfo): void {
    if (!this._tasks.delete(task) || this._tasks.size) return
    const resolve = this._resolveDrain
    this._draining = undefined
    this._resolveDrain = undefined
    asHost(() => resolve?.())
  }
}
