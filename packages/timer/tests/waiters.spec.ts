import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import Timer from '../src/index.js'

describe('Timer waiter cancellation', () => {
  it.each(['timeout', 'interval'] as const)('%s releases a tracked event waiter before resource cleanup', async (mode) => {
    vi.useFakeTimers()
    const root = new Context()
    const event = Symbol('timer waiter')
    const entered = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const order: string[] = []
    let interval: AsyncIterableIterator<void> | undefined
    let caught: unknown
    let ticks = 0
    let handling: Promise<unknown> | undefined
    let stopping: Promise<void> | undefined
    try {
      await root.plugin(Timer)
      const owner = await root.plugin({
        inject: ['timer'],
        apply(ctx) {
          let resourceActive = true
          ctx.on(event, async () => {
            try {
              if (mode === 'timeout') {
                const waiting = ctx.timeout(60_000)
                entered.resolve()
                await waiting
              } else {
                interval = ctx.interval(60_000)
                entered.resolve()
                for await (const _ of interval) ticks++
              }
            } catch (error) {
              caught = error
              order.push(resourceActive ? 'caught' : 'caught after cleanup')
              await release.promise
            } finally {
              order.push(resourceActive ? 'finished' : 'finished after cleanup')
            }
          })
          return () => {
            resourceActive = false
            order.push('disposed')
          }
        },
      })
      handling = root.parallel(event)
      await entered.promise
      const [task] = owner.getTasks()
      expect(task).to.be.ok
      expect(task.signal.aborted).to.equal(false)
      expect(root.fiber.getTasks()).to.deep.equal([])
      task.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      stopping = owner.dispose()
      await aborted.promise
      await vi.advanceTimersByTimeAsync(0)

      expect(caught).to.be.instanceOf(Error)
      expect(order).to.deep.equal(['caught'])
      expect(ticks).to.equal(0)
      expect(vi.getTimerCount()).to.equal(0)
      expect(owner.getTasks()).to.have.length(1)
      release.resolve()
      await Promise.all([handling, stopping])
      expect(order).to.deep.equal(['caught', 'finished', 'disposed'])
      expect(owner.getTasks()).to.deep.equal([])
    } finally {
      release.resolve()
      await interval?.return!()
      await vi.advanceTimersByTimeAsync(60_000)
      await Promise.all([handling, stopping])
      await root.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('preserves an explicit iterator return through owner cancellation', async () => {
    vi.useFakeTimers()
    const root = new Context()
    let iterator!: AsyncIterableIterator<void, number, void>
    try {
      await root.plugin(Timer)
      const owner = await root.plugin({
        inject: ['timer'],
        apply(ctx) {
          iterator = ctx.interval<number>(60_000)
        },
      })
      const reads = [iterator.next(), iterator.next()]
      expect(await iterator.return!(42)).to.deep.equal({ done: true, value: 42 })
      expect(await Promise.all(reads)).to.deep.equal([
        { done: true, value: 42 },
        { done: true, value: 42 },
      ])
      expect(vi.getTimerCount()).to.equal(0)
      await owner.dispose()
      expect(await iterator.next()).to.deep.equal({ done: true, value: 42 })
    } finally {
      await root.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('preserves an explicit iterator throw through owner cancellation', async () => {
    vi.useFakeTimers()
    const root = new Context()
    const reason = new Error('iterator stopped explicitly')
    let iterator!: AsyncIterableIterator<void>
    try {
      await root.plugin(Timer)
      const owner = await root.plugin({
        inject: ['timer'],
        apply(ctx) {
          iterator = ctx.interval(60_000)
        },
      })
      const reads = [iterator.next(), iterator.next()]
      const rejected = reads.map(read => expect(read).rejects.to.equal(reason))
      expect(await iterator.throw!(reason)).to.deep.equal({ done: true, value: undefined })
      await Promise.all(rejected)
      expect(vi.getTimerCount()).to.equal(0)
      await owner.dispose()
      await expect(iterator.next()).rejects.to.equal(reason)
    } finally {
      await root.fiber.dispose()
      vi.useRealTimers()
    }
  })
})
