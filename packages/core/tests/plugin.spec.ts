import { Context, Service } from '../src/index.ts'
import { expect, describe, it } from 'vitest'
import { mock } from 'node:test'
import { inspect } from 'util'
import { event, getHookSnapshot, sleep } from './utils.ts'

describe('Plugin', () => {
  it('apply functional plugin', async () => {
    const root = new Context()
    const callback = mock.fn()
    const options = { foo: 'bar' }
    await root.plugin(callback, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[1]).to.deep.equal(options)
  })

  it('apply object plugin', async () => {
    const root = new Context()
    const callback = mock.fn()
    const options = { bar: 'foo' }
    const plugin = { apply: callback }
    await root.plugin(plugin, options)

    expect(callback.mock.calls).to.have.length(1)
    expect(callback.mock.calls[0].arguments[1]).to.deep.equal(options)
  })

  it('collect effects returned by a function declaration plugin', async () => {
    const root = new Context()
    const calls: string[] = []
    function plugin() {
      calls.push('start')
      return () => { calls.push('stop') }
    }
    const fiber = await root.plugin(plugin)
    expect(calls).to.deep.equal(['start'])
    await fiber.dispose()
    expect(calls).to.deep.equal(['start', 'stop'])
    await root.fiber.dispose()
  })

  it('await effects returned by a constructible asynchronous factory', async () => {
    const root = new Context()
    const calls: string[] = []
    function plugin() {
      return Promise.resolve(() => { calls.push('stop') })
    }
    const fiber = await root.plugin(plugin)
    expect(calls).to.deep.equal([])
    await fiber.dispose()
    expect(calls).to.deep.equal(['stop'])
    await root.fiber.dispose()
  })

  it('keep callable service instances separate from cleanup functions', async () => {
    const root = new Context()
    let invoked = 0
    class Callable extends Service {
      constructor(ctx: Context) {
        super(ctx, 'callable')
      }

      [Service.invoke]() {
        invoked++
      }
    }
    const fiber = await root.plugin(Callable)
    await fiber.dispose()
    expect(invoked).to.equal(0)
    await root.fiber.dispose()
  })

  it('apply invalid plugin', async () => {
    const root = new Context()
    expect(() => root.plugin(undefined as any)).to.throw()
    expect(() => root.plugin({} as any)).to.throw()
    expect(() => root.plugin({ apply: {} } as any)).to.throw()
  })

  it('inactive context', async () => {
    const root = new Context()
    const callback = mock.fn()
    const fiber = root.plugin((ctx) => {
      return () => {
        expect(() => ctx.plugin(callback)).to.throw('inactive context')
        expect(() => ctx.effect(() => () => {})).to.throw('inactive context')
        expect(() => ctx.on('custom-event', () => {})).to.throw('inactive context')
      }
    })
    await fiber.dispose()
    expect(callback.mock.calls).to.have.length(0)
  })

  it('context inspect', async () => {
    const root = new Context()

    expect(inspect(root)).to.equal('Context <root>')

    await root.plugin((ctx) => {
      expect(inspect(ctx)).to.equal('Context <root>')
    })

    await root.plugin(function foo(ctx) {
      expect(inspect(ctx)).to.equal('Context <foo>')
    })

    await root.plugin({
      name: 'bar',
      apply: (ctx) => {
        expect(inspect(ctx)).to.equal('Context <bar>')
      },
    })

    await root.plugin(class Qux {
      constructor(ctx: Context) {
        expect(inspect(ctx)).to.equal('Context <Qux>')
      }
    })
  })

  it('ctx.registry', () => {
    // make coverage happy
    const root = new Context()
    root.registry.keys()
    root.registry.values()
    root.registry.entries()
    root.registry.forEach(() => {})
  })

  it('nested plugins', async () => {
    const plugin = async (ctx: Context) => {
      ctx.on(event, callback)
      await ctx.plugin(async (ctx) => {
        ctx.on(event, callback)
        await ctx.plugin((ctx) => {
          ctx.on(event, callback)
        })
      })
    }

    const root = new Context()
    const callback = mock.fn()
    root.on(event, callback)
    const fiber = await root.plugin(plugin)

    // 4 handlers by now
    expect(callback.mock.calls).to.have.length(0)
    expect(root.registry.size).to.equal(3)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(4)

    // only 1 handler left
    callback.mock.resetCalls()
    await fiber.dispose()
    expect(root.registry.size).to.equal(0)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)

    // subsequent calls should be noop
    callback.mock.resetCalls()
    await fiber.dispose()
    expect(root.registry.size).to.equal(0)
    root.emit(event)
    expect(callback.mock.calls).to.have.length(1)
  })

  it('compare snapshot', async () => {
    async function plugin(ctx: Context) {
      ctx.on(event, () => {})
      await ctx.plugin(async (ctx) => {
        ctx.on(event, () => {})
        await ctx.plugin((ctx) => {
          ctx.on(event, () => {})
        })
      })
    }

    const root = new Context()
    const before = getHookSnapshot(root)
    const fiber = await root.plugin(plugin)
    const after = getHookSnapshot(root)
    await fiber.dispose()
    expect(before).to.deep.equal(getHookSnapshot(root))
    await root.plugin(plugin)
    expect(after).to.deep.equal(getHookSnapshot(root))
  })

  it('Service.init', async () => {
    const start = mock.fn()
    const stop = mock.fn()

    class Foo {
      [Service.init]() {
        start()
        return stop
      }
    }

    const root = new Context()
    const fiber = await root.plugin(Foo)
    expect(start.mock.calls).to.have.length(1)
    expect(stop.mock.calls).to.have.length(0)
    await fiber.dispose()
    expect(start.mock.calls).to.have.length(1)
    expect(stop.mock.calls).to.have.length(1)
  })
})
