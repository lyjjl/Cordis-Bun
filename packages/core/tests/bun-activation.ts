import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { bindExecution, Context } from '../src/index.ts'
import { BunExecutionUnit } from '../../host-bun/src/unit.ts'

assert.ok(process.versions.bun, 'Run this scenario with Bun')

const root = new Context()
const rejectedUnit = new BunExecutionUnit('already disposed constructor')
rejectedUnit.dispose()
const rejected = bindExecution(() => {}, rejectedUnit)
assert.throws(() => root.plugin(rejected), /disposed/)
assert.equal(root.registry.has(rejected), false, 'a rejected construction must not publish an empty runtime')

const unit = new BunExecutionUnit('constructor ownership')
const parent = await root.plugin(() => {})
let stopping!: Promise<void>
let starts = 0
root.provide('constructor-dependency', {}, {
  check() {
    stopping = parent.dispose()
    return true
  },
})
const child = bindExecution({
  inject: ['constructor-dependency'],
  apply() { starts++ },
}, unit)
try {
  assert.throws(() => parent.ctx.plugin(child), /inactive/)
  await stopping
  await root.fiber.dispose()
  await setImmediate()
  assert.equal(starts, 0)
  assert.equal(unit.references, 1, 'failed construction must release both Fiber and ResourceScope ownership')
  unit.dispose()
  assert.equal(unit.disposed, true, 'a failed constructor must not retain its code graph')
  await unit.whenDisposed()
} finally {
  await root.fiber.dispose()
  unit.dispose()
}

console.log('Bun activation constructor ownership passed')
