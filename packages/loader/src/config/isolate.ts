import { Context } from 'cordis'
import { Dict } from 'cosmokit'
import { Entry } from './entry.ts'
import { swap } from './utils.ts'

declare module './entry.ts' {
  interface EntryOptions {
    isolate?: Dict<true | string> | null
  }

  interface Entry {
    realm: LocalRealm
  }
}

export abstract class Realm {
  protected store: Dict<symbol> = Object.create(null)

  abstract get suffix(): string

  access(key: string, create = false) {
    if (create) {
      return this.store[key] ??= Symbol(`${key}${this.suffix}`)
    } else {
      return this.store[key] ?? Symbol(`${key}${this.suffix}`)
    }
  }

  delete(key: string) {
    delete this.store[key]
  }

  get size() {
    return Object.keys(this.store).length
  }
}

export class LocalRealm extends Realm {
  constructor(private entry: Entry) {
    super()
  }

  get suffix() {
    return '#' + this.entry.options.id
  }
}

export class GlobalRealm extends Realm {
  constructor(public label: string) {
    super()
  }

  get suffix() {
    return '@' + this.label
  }
}

export default function isolate(ctx: Context) {
  const realms: Dict<GlobalRealm> = Object.create(null)
  const delims: Dict<symbol> = Object.create(null)

  function access(entry: Entry, name: string, create: true): symbol
  function access(entry: Entry, name: string, create?: boolean): symbol | undefined
  function access(entry: Entry, name: string, create = false) {
    let realm: Realm | undefined
    const label = entry.options.isolate?.[name]
    if (label === undefined) return
    if (label === true) {
      realm = entry.realm ??= new LocalRealm(entry)
    } else if (create) {
      realm = realms[label] ??= new GlobalRealm(label)
    } else {
      realm = realms[label]
    }
    return realm?.access(name, create)
  }

  ctx.on('loader/entry-init', (entry) => {
    entry.ctx[Context.isolate] = Object.create(entry.ctx[Context.isolate])
  })

  ctx.on('loader/patch-context', async (entry, next) => {
    // step 1: generate new isolate map
    const newMap: Dict<symbol> = Object.create(entry.parent.ctx[Context.isolate])
    for (const name of Object.keys(entry.options.isolate ?? {})) {
      newMap[name] = access(entry, name, true)
    }

    // step 2: generate service diff
    const changed: [string, symbol | undefined, symbol | undefined][] = []
    const oldMap = entry.ctx[Context.isolate]
    for (const name in { ...newMap, ...delims }) {
      if (newMap[name] === oldMap[name]) continue
      changed.push([name, oldMap[name], newMap[name]])
      const delim = delims[name] ??= Symbol(`delim:${name}`)
      entry.ctx[delim] = Symbol(`${name}#${entry.id}`)
    }

    // step 3: set prototype for transferred context
    Object.setPrototypeOf(entry.ctx[Context.isolate], entry.parent.ctx[Context.isolate])
    swap(entry.ctx[Context.isolate], newMap)

    // step 4: reload fiber
    await next()

    // Native reflection owns physical scope relocation and binding refresh.
    for (const [name, from, to] of changed) {
      const delimiter = delims[name]
      const owner = entry.ctx[delimiter]
      entry.ctx.reflect._relocate(name, from, to, target => target[delimiter] === owner)
    }

    // step 7: clean up delimiters
    for (const name in delims) {
      if (!Reflect.ownKeys(newMap).includes(name)) {
        delete entry.ctx[delims[name]]
      }
    }
  })

  ctx.on('loader/partial-dispose', (entry, legacy, active) => {
    for (const [name, label] of Object.entries(legacy.isolate ?? {})) {
      if (label === true) continue
      if (active && entry.options.isolate?.[name] === label) continue
      const realm = realms[label]
      if (!realm) continue

      // realm garbage collection
      for (const entry of ctx.loader.entries()) {
        // has reference to this realm
        if (entry.options.isolate?.[name] === realm.label) return
      }
      realm.delete(name)
      if (!realm.size) {
        delete realms[realm.label]
      }
    }
  })
}
