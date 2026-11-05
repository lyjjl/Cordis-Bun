import { Context, type Message } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import Timer from '../src/index.js'

const modes = ['timeout', 'interval', 'throttle', 'debounce'] as const

describe('Timer task ownership', () => {
  it.each(modes)('%s retains resources for pending callbacks and stops admitting more work', async (mode) => {
    vi.useFakeTimers()
    const root = new Context()
    const release = Promise.withResolvers<void>()
    const order: string[] = []
    let calls = 0
    let scheduled: (() => void) | undefined
    try {
      const timer = await root.plugin(Timer)
      const owner = await root.plugin({
        name: 'timer-task-owner',
        inject: ['timer'],
        apply(ctx) {
          let resourceActive = true
          const callback = async () => {
            calls++
            await release.promise
            order.push(resourceActive ? 'handled' : 'released while handling')
          }
          if (mode === 'timeout' || mode === 'interval') {
            ctx[mode](callback, 10)
            if (mode === 'timeout') ctx.timeout(callback, 20)
          } else {
            scheduled = ctx[mode](callback, 10)
            scheduled()
          }
          return () => {
            resourceActive = false
            order.push('disposed')
          }
        },
      })
      vi.advanceTimersByTime(mode === 'throttle' ? 0 : 10)
      expect(calls).to.equal(1)
      const [task] = owner.getTasks()
      expect(task.signal.aborted).to.equal(false)
      expect(root.fiber.getTasks()).to.deep.equal([])
      expect(timer.getTasks()).to.deep.equal([])
      scheduled?.()
      expect(vi.getTimerCount()).to.equal(1)
      const stopping = owner.dispose()

      try {
        expect(task.signal.aborted).to.equal(true)
        expect(vi.getTimerCount()).to.equal(1)
        scheduled?.()
        vi.advanceTimersByTime(100)
        await Promise.resolve()
        expect(calls).to.equal(1)
        expect(order).to.deep.equal([])
      } finally {
        release.resolve()
        await stopping
      }
      expect(order).to.deep.equal(['handled', 'disposed'])
      expect(owner.getTasks()).to.deep.equal([])
    } finally {
      release.resolve()
      await root.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it.each(modes)('%s logs asynchronous callback errors through the owning fiber', async (mode) => {
    vi.useFakeTimers()
    const root = new Context()
    const logged = Promise.withResolvers<Message>()
    const reason = new Error('asynchronous timer callback')
    root.logger.exporter({
      colors: 0,
      export(message) {
        if (message.type === 'error') logged.resolve(message)
      },
    })
    try {
      await root.plugin(Timer)
      const owner = await root.plugin({
        name: 'timer-task-owner',
        inject: ['timer'],
        apply(ctx) {
          const callback = async () => { throw reason }
          if (mode === 'timeout' || mode === 'interval') {
            ctx[mode](callback, 10)
          } else {
            ctx[mode](callback, 10)()
          }
        },
      })
      vi.advanceTimersByTime(10)
      const message = await logged.promise
      expect(message.fiber?.deref()).to.equal(owner)
      expect(message.name).to.equal('timer-task-owner')
      expect(message.args[0]).to.equal(reason)
      await owner.dispose()
    } finally {
      await root.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it.each(modes)('%s preserves synchronous callback exceptions', async (mode) => {
    vi.useFakeTimers()
    const root = new Context()
    const reason = new Error('synchronous timer callback')
    let scheduled: (() => void) | undefined
    try {
      await root.plugin(Timer)
      const owner = await root.plugin({
        inject: ['timer'],
        apply(ctx) {
          const callback = () => { throw reason }
          if (mode === 'timeout' || mode === 'interval') {
            ctx[mode](callback, 10)
          } else {
            scheduled = ctx[mode](callback, 10)
            if (mode === 'debounce') scheduled()
          }
        },
      })
      if (mode === 'throttle') {
        expect(() => scheduled!()).to.throw(reason)
      } else {
        expect(() => vi.advanceTimersByTime(10)).to.throw(reason)
      }
      expect(owner.getTasks()).to.deep.equal([])
    } finally {
      await root.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it.each(['throttle', 'debounce'] as const)('%s preserves callback arguments', async (mode) => {
    vi.useFakeTimers()
    const root = new Context()
    const first = {}
    const second = {}
    const received: unknown[][] = []
    try {
      await root.plugin(Timer)
      await root.plugin({
        inject: ['timer'],
        apply(ctx) {
          const scheduled = ctx[mode]((...args: unknown[]) => { received.push(args) }, 10)
          scheduled(first, second)
        },
      })
      vi.advanceTimersByTime(10)
      expect(received).to.deep.equal([[first, second]])
    } finally {
      await root.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it.each(['timeout', 'interval'] as const)('%s invokes callbacks with their original argument count', async (mode) => {
    vi.useFakeTimers()
    const root = new Context()
    const counts: number[] = []
    try {
      await root.plugin(Timer)
      await root.plugin({
        inject: ['timer'],
        apply(ctx) {
          ctx[mode](function () { counts.push(arguments.length) }, 10)
        },
      })
      vi.advanceTimersByTime(10)
      expect(counts).to.deep.equal([0])
    } finally {
      await root.fiber.dispose()
      vi.useRealTimers()
    }
  })
})

describe('Timer thenable completion', () => {
  it('subscribes once while retaining ownership through settlement', async () => {
    vi.useFakeTimers()
    const root = new Context()
    const release = Promise.withResolvers<void>()
    const subscribed = Promise.withResolvers<void>()
    let subscriptions = 0
    try {
      await root.plugin(Timer)
      const owner = await root.plugin({
        inject: ['timer'],
        apply(ctx) {
          ctx.timeout(() => ({
            then(resolve: () => void, reject: (reason: unknown) => void) {
              subscriptions++
              subscribed.resolve()
              release.promise.then(resolve, reject)
            },
          }), 10)
        },
      })
      vi.advanceTimersByTime(10)
      await subscribed.promise
      const stopping = owner.dispose()
      try {
        expect(owner.getTasks()).to.have.length(1)
      } finally {
        release.resolve()
        await stopping
      }
      expect(subscriptions).to.equal(1)
    } finally {
      release.resolve()
      await root.fiber.dispose()
      vi.useRealTimers()
    }
  })
})
