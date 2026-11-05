import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Context, FiberState } from 'cordis'
import MockLoader from './utils.ts'

// A child may react to cancellation before its initializing parent has settled.
describe('Loader retiring parent', () => {
  it('keeps a child enabled when it stops on a loading parent cancellation', async () => {
    const root = new Context()
    const firstStarted = Promise.withResolvers<void>()
    const heldPlugin = { apply() {} }
    const releaseImport = Promise.withResolvers<typeof heldPlugin>()
    let reading: Promise<void> | undefined
    let restarting: Promise<void> | undefined
    let activations = 0
    try {
      await root.plugin(MockLoader)
      const loader = root.loader as MockLoader
      const originalImport = loader.import.bind(loader)
      loader.import = name => name === 'held' ? releaseImport.promise : originalImport(name)
      loader.mock('first', (ctx: Context) => {
        activations++
        const canceled = Promise.withResolvers<void>()
        ctx.task((signal) => {
          signal.addEventListener('abort', () => {
            void ctx.fiber.dispose()
            canceled.resolve()
          }, { once: true })
          return canceled.promise
        })
        firstStarted.resolve()
      })
      reading = loader.read([{
        id: 'group',
        name: '@cordisjs/plugin-group',
        group: true,
        config: [
          { id: 'first', name: 'first' },
          { id: 'held', name: 'held' },
        ],
      }])
      await firstStarted.promise
      const parent = loader.store.group.innerFiber!
      const child = loader.store.first
      expect(parent.state).toBe(FiberState.LOADING)
      restarting = parent.restart()
      await setImmediate()
      const persistedDisabled = child.options.disabled
      releaseImport.resolve(heldPlugin)
      await Promise.all([reading, restarting])
      await loader.await()

      expect(persistedDisabled).not.toBe(true)
      expect(loader.store.first.innerFiber?.state).toBe(FiberState.ACTIVE)
      expect(activations).toBe(2)
    } finally {
      releaseImport.resolve(heldPlugin)
      await Promise.allSettled([reading, restarting])
      await root.fiber.dispose()
    }
  })
})
