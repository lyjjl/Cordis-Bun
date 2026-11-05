import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { Context, FiberState } from '../src/index.ts'
import TimerService from '../../timer/src/index.ts'

declare module '../src/context.ts' {
  interface Context {
    smokeStorage: { read(): Promise<string> }
  }
}

assert.ok(process.versions.bun, 'Run this scenario with Bun')

const root = new Context()
const event = Symbol('native request')
const inheritedEvent = Symbol('native inherited teardown')
const entered = Promise.withResolvers<void>()
const releaseTimer = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const timeline: string[] = []
let endpoint = ''
let requests = 0
let closed = false

const provider = await root.plugin(async (ctx) => {
  const server = createServer((_request, response) => {
    requests++
    response.end('storage available')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  endpoint = `http://127.0.0.1:${address.port}`
  ctx.provide('smokeStorage', {
    async read() {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) })
      return response.text()
    },
  })
  ctx.on(inheritedEvent, async () => {
    assert.equal(closed, false)
    assert.equal(await ctx.smokeStorage.read(), 'storage available')
    timeline.push('inherited callback completed')
  })
  await ctx.plugin(child => () => child.emit(inheritedEvent))
  return () => {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    server.close((error) => {
      if (error) return reject(error)
      closed = true
      timeline.push('provider closed')
      resolve()
    })
    return promise
  }
})

const consumer = await root.inject(['smokeStorage'], (ctx) => {
  ctx.on(event, async () => {
    timeline.push('entered')
    entered.resolve()
    await release.promise
    assert.equal(closed, false)
    assert.equal(await ctx.smokeStorage.read(), 'storage available')
    timeline.push('request completed')
  })
  return () => { timeline.push('consumer cleaned') }
})

try {
  const handling = root.parallel(event)
  await entered.promise
  const stopping = provider.dispose()
  const stoppingAgain = provider.dispose()
  await root.parallel(event)
  assert.equal(closed, false)
  assert.equal(consumer.getTasks().length, 1)
  release.resolve()
  await Promise.all([handling, stopping, stoppingAgain])
  assert.equal(requests, 2)
  assert.deepEqual(timeline, ['entered', 'request completed', 'consumer cleaned', 'inherited callback completed', 'provider closed'])
  assert.equal(consumer.state, FiberState.PENDING)
  assert.equal(provider.state, FiberState.DISPOSED)

  const initializing = Promise.withResolvers<void>()
  const continueInitialization = Promise.withResolvers<void>()
  const applied: number[] = []
  const cleaned: number[] = []
  const configurable = await root.plugin(async (_ctx, config: number) => {
    applied.push(config)
    if (config === 1) {
      initializing.resolve()
      await continueInitialization.promise
    }
    return () => { cleaned.push(config) }
  }, 0)
  const first = configurable.update(1)
  await initializing.promise
  const second = configurable.update(2)
  const third = configurable.update(3)
  continueInitialization.resolve()
  await Promise.all([first, second, third])
  assert.deepEqual(applied, [0, 1, 3])
  assert.deepEqual(cleaned, [0, 1])
  assert.equal(configurable.config, 3)
  await configurable.dispose()
  assert.deepEqual(cleaned, [0, 1, 3])

  const timerProvider = await root.plugin(TimerService)
  const timerEntered = Promise.withResolvers<void>()
  let timerResourceOpen = true
  let timerCompleted = false
  const scheduled = await root.inject(['timer'], (ctx) => {
    ctx.interval(async () => {
      timerEntered.resolve()
      await releaseTimer.promise
      assert.equal(timerResourceOpen, true)
      timerCompleted = true
    }, 5)
    return () => { timerResourceOpen = false }
  })
  await timerEntered.promise
  const stoppingTimer = scheduled.dispose()
  assert.equal(scheduled.getTasks().length, 1)
  assert.equal(scheduled.getTasks()[0].signal.aborted, true)
  assert.equal(timerProvider.getTasks().length, 0)
  releaseTimer.resolve()
  await stoppingTimer
  assert.equal(timerCompleted, true)
  assert.equal(timerResourceOpen, false)

  const selfEvent = Symbol('native self disposal')
  const selfEntered = Promise.withResolvers<void>()
  const resumeSelf = Promise.withResolvers<void>()
  let selfClosed = false
  let selfCompleted = false
  const self = await root.plugin((ctx) => {
    ctx.on(selfEvent, async () => {
      selfEntered.resolve()
      await resumeSelf.promise
      await ctx.fiber.dispose()
      selfCompleted = true
    })
    return () => { selfClosed = true }
  })
  const selfDispatch = root.parallel(selfEvent)
  await selfEntered.promise
  resumeSelf.resolve()
  await selfDispatch
  assert.equal(selfCompleted, true)
  assert.equal(selfClosed, true)
  assert.equal(self.state, FiberState.DISPOSED)

  const releaseFork = Promise.withResolvers<void>()
  const forkRequested = Promise.withResolvers<void>()
  let forkClosed = false
  const forked = await root.plugin(() => () => { forkClosed = true })
  let innerFork: Promise<void> | undefined
  const outerFork = forked.ctx.task(async () => {
    innerFork = forked.ctx.task(async () => {
      const stopping = forked.dispose()
      forkRequested.resolve()
      await stopping
      assert.equal(forkClosed, true)
    }, 'independent stop')
    await releaseFork.promise
    assert.equal(forkClosed, false)
  }, 'independent resource user')
  try {
    await forkRequested.promise
    await setImmediate()
    assert.equal(forkClosed, false)
    assert.equal(forked.getTasks().length, 1)
    releaseFork.resolve()
    await Promise.all([outerFork, innerFork])
  } finally {
    releaseFork.resolve()
    await Promise.allSettled([outerFork, innerFork])
  }

  const joinRequested = Promise.withResolvers<void>()
  const releaseJoin = Promise.withResolvers<void>()
  let joinedClosed = false
  let joinedFinished = false
  const joined = await root.plugin(() => () => { joinedClosed = true })
  const joining = joined.ctx.task(async () => {
    const inner = joined.ctx.task(async () => {
      const stopping = joined.dispose()
      joinRequested.resolve()
      await stopping
    })
    await releaseJoin.promise
    await joined.ctx.join(inner)
    assert.equal(joinedClosed, true)
    joinedFinished = true
  })
  try {
    await joinRequested.promise
    await setImmediate()
    assert.equal(joinedClosed, false)
    releaseJoin.resolve()
    await joining
    assert.equal(joinedFinished, true)
  } finally {
    releaseJoin.resolve()
    await Promise.allSettled([joining])
  }

  const releaseOldTail = Promise.withResolvers<void>()
  const beginNewWork = Promise.withResolvers<void>()
  let generationOpen = true
  const generations = await root.plugin(() => {
    generationOpen = true
    return () => { generationOpen = false }
  })
  const changingGeneration = generations.restart()
  const oldTail = changingGeneration.then(() => releaseOldTail.promise)
  await changingGeneration
  const newWork = generations.ctx.task(async () => {
    await beginNewWork.promise
    await oldTail
    assert.equal(generationOpen, true)
  })
  const closingGeneration = generations.dispose()
  try {
    beginNewWork.resolve()
    await setImmediate()
    assert.equal(generationOpen, true)
    releaseOldTail.resolve()
    await Promise.all([newWork, closingGeneration])
    assert.equal(generationOpen, false)
  } finally {
    beginNewWork.resolve()
    releaseOldTail.resolve()
    await Promise.allSettled([newWork, closingGeneration])
  }

  const waiterEvent = Symbol('native iterator cancellation')
  const waiterEntered = Promise.withResolvers<void>()
  let waiterResourceOpen = true
  let waiterCanceled = false
  let waiterTicks = 0
  const waiter = await root.inject(['timer'], (ctx) => {
    ctx.on(waiterEvent, async () => {
      const iterator = ctx.interval(60_000)
      waiterEntered.resolve()
      try {
        for await (const _ of iterator) waiterTicks++
      } catch (error) {
        assert.ok(error instanceof Error)
        assert.equal(waiterResourceOpen, true)
        waiterCanceled = true
      }
    })
    return () => { waiterResourceOpen = false }
  })
  const waiting = root.parallel(waiterEvent)
  await waiterEntered.promise
  await Promise.all([waiter.dispose(), waiting])
  assert.equal(waiterCanceled, true)
  assert.equal(waiterTicks, 0)
  assert.equal(waiterResourceOpen, false)
} finally {
  release.resolve()
  releaseTimer.resolve()
  await root.fiber.dispose()
}

assert.throws(() => root.plugin(() => {}))
console.log(`Bun ${process.versions.bun}: HTTP and timer drain, cross-context self-disposal, independent forks, declared late joins, activation generations, iterator cancellation, configuration convergence and terminal shutdown passed`)
