import { Context, Service } from 'cordis'

declare module 'cordis' {
  interface Context extends Pick<TimerService, 'interval' | 'timeout' | 'throttle' | 'debounce' | 'setTimeout' | 'setInterval'> {
    timer: TimerService
  }
}

type Scheduled<F extends (...args: any[]) => any> = ((...args: Parameters<F>) => void) & { dispose: () => void }

function invoke(
  ctx: Context,
  callback: (...args: never[]) => unknown,
  label: string,
  thisArg?: unknown,
  args?: unknown[],
) {
  const owner = ctx.fiber
  if (!owner.accepting) return
  ctx.task(() => {
    const result = args ? Reflect.apply(callback, thisArg, args) : callback.call(thisArg)
    if (result && (typeof result === 'object' || typeof result === 'function')
      && 'then' in result && typeof result.then === 'function') {
      return Promise.resolve(result).catch(error => owner.ctx.logger.error(error))
    }
  }, label)
}

export class TimerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'timer')
    ctx.mixin('timer', ['timeout', 'interval', 'throttle', 'debounce', 'setTimeout', 'setInterval'])
  }

  /** @deprecated use `ctx.timeout()` instead */
  setTimeout(callback: () => void, delay: number) {
    return this.timeout(callback, delay)
  }

  /** @deprecated use `ctx.interval()` instead */
  setInterval(callback: () => void, delay: number) {
    return this.interval(callback, delay)
  }

  timeout(callback: () => void, delay: number): () => void
  timeout(delay: number): Promise<void>
  timeout(...args: any[]): any {
    const callback = typeof args[0] === 'function' ? args.shift() : undefined
    const delay = args[0] as number
    if (callback) {
      const ctx = this.ctx
      const dispose = ctx.effect(() => {
        const timer = setTimeout(() => {
          dispose()
          invoke(ctx, callback, 'ctx.timeout()')
        }, delay)
        return () => clearTimeout(timer)
      }, 'ctx.timeout()')
      return dispose
    } else {
      const signal = this.ctx.fiber.signal
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      const dispose = this.ctx.effect(() => {
        let active = true
        const timer = setTimeout(() => {
          active = false
          signal.removeEventListener('abort', cancel)
          resolve()
        }, delay)
        const cancel = () => {
          if (!active) return
          active = false
          clearTimeout(timer)
          signal.removeEventListener('abort', cancel)
          reject(new Error('Context has been disposed'))
        }
        signal.addEventListener('abort', cancel)
        if (signal.aborted) cancel()
        return cancel
      }, 'ctx.timeout()')
      return promise.finally(dispose)
    }
  }

  interval(callback: () => void, delay: number): () => void
  interval<R = any>(delay: number): AsyncIterableIterator<void, R, void>
  interval(...args: any[]): any {
    const callback = typeof args[0] === 'function' ? args.shift() : undefined
    const delay = args[0] as number
    if (callback) {
      const ctx = this.ctx
      return ctx.effect(() => {
        const timer = setInterval(function (this: unknown) {
          invoke(ctx, callback, 'ctx.interval()', this)
        }, delay)
        return () => clearInterval(timer)
      }, 'ctx.interval()')
    } else {
      const signal = this.ctx.fiber.signal
      let done: { kind: 'return'; value: any } | { kind: 'throw'; reason: any } | undefined
      const nextTasks: PromiseWithResolvers<IteratorResult<void>>[] = []
      const dispose = this.ctx.effect(() => {
        let active = true
        const timer = setInterval(() => {
          nextTasks.shift()?.resolve({ done: false, value: undefined })
        }, delay)
        const cancel = () => {
          if (!active) return
          active = false
          clearInterval(timer)
          signal.removeEventListener('abort', cancel)
          if (done) return
          done = { kind: 'throw', reason: new Error('Context has been disposed') }
          for (const task of nextTasks.splice(0)) task.reject(done.reason)
        }
        signal.addEventListener('abort', cancel)
        if (signal.aborted) cancel()
        return cancel
      }, 'ctx.interval()')
      return {
        next: () => {
          if (!done) {
            const task = Promise.withResolvers<IteratorResult<void>>()
            nextTasks.push(task)
            return task.promise
          }
          if (done.kind === 'return') return Promise.resolve({ done: true, value: done.value })
          return Promise.reject(done.reason)
        },
        return: (value) => {
          if (!done) done = { kind: 'return', value }
          for (const task of nextTasks.splice(0)) task.resolve({ done: true, value })
          dispose()
          return Promise.resolve({ done: true, value })
        },
        throw: (reason) => {
          if (!done) done = { kind: 'throw', reason }
          for (const task of nextTasks.splice(0)) task.reject(reason)
          dispose()
          return Promise.resolve({ done: true, value: undefined })
        },
        [Symbol.asyncIterator]() {
          return this
        },
      } satisfies AsyncIterableIterator<void>
    }
  }

  private _schedule(label: string, trigger: (args: any[]) => number | NodeJS.Timeout | undefined) {
    let timer: number | NodeJS.Timeout | undefined
    let isDisposed = false
    const ctx = this.ctx
    const dispose = ctx.effect(() => () => {
      isDisposed = true
      clearTimeout(timer)
      timer = undefined
    }, label)
    const wrapper: any = (...args: any[]) => {
      if (isDisposed || !ctx.fiber.accepting) return
      clearTimeout(timer)
      timer = trigger(args)
    }
    wrapper.dispose = dispose
    return wrapper
  }

  throttle<F extends (...args: any[]) => any>(callback: F, delay: number, noTrailing?: boolean): Scheduled<F> {
    let lastCall = -Infinity
    const ctx = this.ctx
    const execute = (...args: any[]) => {
      lastCall = Date.now()
      invoke(ctx, callback, 'ctx.throttle()', undefined, args)
    }
    return this._schedule('ctx.throttle()', (args) => {
      const now = Date.now()
      const remaining = delay - now + lastCall
      if (remaining <= 0) {
        execute(...args)
      } else if (!noTrailing) {
        return setTimeout(execute, remaining, ...args)
      }
    })
  }

  debounce<F extends (...args: any[]) => any>(callback: F, delay: number): Scheduled<F> {
    const ctx = this.ctx
    return this._schedule('ctx.debounce()', (args) => {
      return setTimeout(function (this: unknown) {
        invoke(ctx, callback, 'ctx.debounce()', this, args)
      }, delay)
    })
  }
}

export default TimerService
