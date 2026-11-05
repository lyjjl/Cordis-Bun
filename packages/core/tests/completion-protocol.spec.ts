import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Context } from '../src/index.ts'

async function settleWithin<T>(value: PromiseLike<T>): Promise<T> {
  const deadline = Promise.withResolvers<never>()
  const timeout = setTimeout(() => deadline.reject(new Error('completion remained pending')), 1000)
  try {
    return await Promise.race([value, deadline.promise])
  } finally {
    clearTimeout(timeout)
  }
}

describe('Completion Promise protocol', () => {
  it('keeps ownership tied to the first thenable resolution while its value is pending', async () => {
    const root = new Context()
    const gate = Promise.withResolvers<void>()
    const subscribed = Promise.withResolvers<void>()
    const order: string[] = []
    let available = true
    let stopping: Promise<void> | undefined
    const owner = await root.plugin(() => () => {
      available = false
      order.push('resource closed')
    })
    const source = owner.ctx.task(() => ({
      then(resolve: (value: PromiseLike<void>) => void) {
        resolve(gate.promise)
        stopping = owner.dispose()
        resolve(stopping)
        subscribed.resolve()
      },
    }))
    const working = owner.ctx.task(async () => {
      await owner.ctx.join(source)
      order.push(available ? 'read open' : 'read closed')
    })
    try {
      await subscribed.promise
      await setImmediate()
      const availableDuringWait = available
      gate.resolve()
      await Promise.all([working, stopping])
      expect(availableDuringWait).toBe(true)
      expect(order).toEqual(['read open', 'resource closed'])
    } finally {
      gate.resolve()
      await Promise.allSettled([working, stopping])
      await root.fiber.dispose()
    }
  })

  it.each(['fulfill', 'reject'] as const)('rejects a %s handler returning its own public completion', async (state) => {
    const root = new Context()
    const source = root.task(async () => {
      if (state === 'reject') throw new Error('source rejection')
      return 1
    })
    let chain: Promise<number>
    chain = state === 'fulfill' ? source.then(() => chain) : source.catch(() => chain)
    try {
      await expect(settleWithin(chain)).rejects.toBeInstanceOf(TypeError)
    } finally {
      await root.fiber.dispose()
    }
  })

  it('reads a returned then getter in its task rather than its independent caller', async () => {
    const root = new Context()
    const gate = Promise.withResolvers<void>()
    const order: string[] = []
    let available = true
    let reads = 0
    let inner: PromiseLike<void> | undefined
    const owner = await root.plugin(() => () => {
      available = false
      order.push('resource closed')
    })
    const outer = owner.ctx.task(async () => {
      inner = owner.ctx.task(() => ({
        get then() {
          reads++
          const stopped = owner.dispose().then(() => {})
          return stopped.then.bind(stopped)
        },
      }))
      await gate.promise
      order.push(available ? 'read open' : 'read closed')
    })
    try {
      await setImmediate()
      const availableDuringWait = available
      gate.resolve()
      await Promise.all([outer, inner])
      expect(availableDuringWait).toBe(true)
      expect(order).toEqual(['read open', 'resource closed'])
      expect(reads).toBe(1)
    } finally {
      gate.resolve()
      await Promise.allSettled([outer, inner])
      await root.fiber.dispose()
    }
  })

  it('adopts externally supplied control values in the returned thenable task context', async () => {
    const root = new Context()
    const subscribed = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const order: string[] = []
    let available = true
    let accept!: (value: PromiseLike<void>) => void
    let stopping: Promise<void> | undefined
    const owner = await root.plugin(() => () => {
      available = false
      order.push('resource closed')
    })
    const adopted = owner.ctx.task(() => ({
      then(resolve: (value: PromiseLike<void>) => void) {
        accept = resolve
        subscribed.resolve()
      },
    }))
    await subscribed.promise
    const supplier = owner.ctx.task(async () => {
      stopping = owner.dispose()
      accept(stopping)
      await gate.promise
      order.push(available ? 'read open' : 'read closed')
    })
    try {
      await setImmediate()
      const availableDuringWait = available
      gate.resolve()
      await Promise.all([adopted, supplier, stopping])
      expect(availableDuringWait).toBe(true)
      expect(order).toEqual(['read open', 'resource closed'])
    } finally {
      gate.resolve()
      await Promise.allSettled([adopted, supplier, stopping])
      await root.fiber.dispose()
    }
  })
})
