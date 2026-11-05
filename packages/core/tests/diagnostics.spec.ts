import { describe, expect, it } from 'vitest'
import { Context, FiberState } from '../src/index.ts'

describe('Native composition diagnostics', () => {
  it('reports resolved required/optional provenance, owned services, tasks and strict leases', async () => {
    const root = new Context()
    const scope = root.scope('child')
    await scope.fiber.await()
    const provider = await root.plugin(ctx => { ctx.provide('diagnostic-required', 'ready') })
    const consumer = await scope.plugin({
      inject: ['diagnostic-required'], optional: ['diagnostic-optional'],
      apply(ctx: Context, config: { version: number }) {
        ctx.provide('diagnostic-owned', config.version)
        ctx.resources.effect(() => {}, 'owned resource')
      },
    }, { version: 1 })
    const first = consumer.diagnostics()
    const required = first.dependencies.find(value => value.name === 'diagnostic-required')!
    const optional = first.dependencies.find(value => value.name === 'diagnostic-optional')!
    expect(first).toMatchObject({ state: FiberState.ACTIVE, config: { version: 1 }, effective: { version: 1 }, leases: 0 })
    expect(required).toMatchObject({ optional: false, resolved: true, owner: provider.uid, targetBinding: required.binding })
    expect(optional).toMatchObject({ optional: true, resolved: false, binding: undefined, owner: undefined })
    expect(first.provided).toHaveLength(1)
    expect(first.provided[0]).toMatchObject({ name: 'diagnostic-owned', available: true })
    expect(scope.reflect.diagnostics('diagnostic-owned')).toEqual([{
      name: 'diagnostic-owned', binding: first.provided[0].binding,
      owner: consumer.uid, ownerName: consumer.name, scope: 'child',
      isolation: scope[Context.isolate]['diagnostic-owned'], available: true, selected: true,
    }])
    expect(root.reflect.diagnostics('diagnostic-owned')).toEqual([])
    expect(first.resources.resources).toEqual([{ label: 'owned resource' }])
    const releaseTask = Promise.withResolvers<void>()
    const work = consumer.ctx.task(() => releaseTask.promise, 'in flight')
    const releaseLease = consumer.ctx.resources.acquire()!
    const running = consumer.diagnostics()
    expect(running.tasks.map(value => value.label)).toEqual(['in flight'])
    expect(running.leases).toBe(1)
    const stopping = consumer.dispose()
    const retiring = consumer.diagnostics()
    expect(retiring.resources.state).toBe('retiring')
    expect(retiring.tasks[0].signal.aborted).toBe(true)
    expect(scope.reflect.diagnostics('diagnostic-owned')[0].available).toBe(false)
    releaseTask.resolve()
    releaseLease()
    await Promise.all([work, stopping])
    const stopped = consumer.diagnostics()
    expect(stopped.state).toBe(FiberState.DISPOSED)
    expect(stopped.resources.state).toBe('disposed')
    expect(stopped.tasks).toEqual([])
    expect(stopped.leases).toBe(0)
    expect(stopped.provided).toEqual([])
    expect(scope.reflect.diagnostics('diagnostic-owned')).toEqual([])
    await root.fiber.dispose()
  })

  it('keeps target/effective/revision/error diagnostics authoritative through superseded setup and recovery', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const staleFailure = new Error('superseded')
    const currentFailure = new Error('current')
    const cleaned: number[] = []
    const fiber = await root.plugin(async (ctx, config: { version: number }) => {
      ctx.resources.effect(() => { cleaned.push(config.version) }, `version ${config.version}`)
      if (config.version === 1) {
        entered.resolve()
        await release.promise
        throw staleFailure
      }
      if (config.version === 3) throw currentFailure
    }, { version: 0 })
    const initialRevision = fiber.diagnostics().revision
    const first = fiber.update({ version: 1 })
    await entered.promise
    const staleContext = fiber.ctx
    const second = fiber.update({ version: 2 })
    const loading = fiber.diagnostics()
    expect(loading.config).toEqual({ version: 2 })
    expect(loading.effective).toEqual({ version: 0 })
    expect(loading.revision).toBeGreaterThan(initialRevision)
    expect(staleContext.resources.active).toBe(false)
    release.resolve()
    await Promise.all([first, second])
    const recovered = fiber.diagnostics()
    expect(recovered.state).toBe(FiberState.ACTIVE)
    expect(recovered.effective).toEqual({ version: 2 })
    expect(recovered.lastError).toBeUndefined()
    expect(cleaned).toEqual([0, 1])
    await expect(fiber.update({ version: 3 })).rejects.toBe(currentFailure)
    const failed = fiber.diagnostics()
    expect(failed.state).toBe(FiberState.FAILED)
    expect(failed.config).toEqual({ version: 3 })
    expect(failed.effective).toEqual({ version: 2 })
    expect(failed.lastError).toBe(currentFailure)
    expect(failed.resources.state).toBe('disposed')
    await fiber.update({ version: 4 })
    expect(fiber.diagnostics()).toMatchObject({ state: FiberState.ACTIVE, config: { version: 4 }, effective: { version: 4 }, lastError: undefined })
    expect(fiber.diagnostics().revision).toBeGreaterThan(failed.revision)
    expect(staleContext.resources.active).toBe(false)
    await root.fiber.dispose()
    expect(cleaned).toEqual([0, 1, 2, 3, 4])
  })

  it('aggregates resource and native cleanup failures without skipping dependency release', async () => {
    const root = new Context()
    root.logger.error = () => {}
    const resourceFailure = new Error('resource cleanup')
    const nativeFailure = new Error('native cleanup')
    const order: string[] = []
    const provider = await root.plugin(ctx => {
      ctx.provide('diagnostic-error-dependency', {})
      return () => { order.push('provider') }
    })
    const consumer = await root.plugin({ inject: ['diagnostic-error-dependency'], apply(ctx: Context) {
      ctx.resources.effect(() => { order.push('resource'); throw resourceFailure })
      return () => { order.push('native'); throw nativeFailure }
    } })
    await expect(consumer.dispose()).rejects.toMatchObject({ errors: [resourceFailure, nativeFailure] })
    expect(consumer.diagnostics().lastError).toMatchObject({ errors: [resourceFailure, nativeFailure] })
    await provider.dispose()
    expect(order).toEqual(['resource', 'native', 'provider'])
    await root.fiber.dispose()
  })
})
