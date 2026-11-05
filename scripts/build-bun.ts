import { resolve } from 'node:path'
import type { Context, Events } from 'yakumo'
import type {} from 'yakumo-esbuild'

export const inject = ['yakumo']

export function apply(ctx: Context) {
  // Yakumo's hook augments its barrel, while Context.on uses Cordis's Events.
  const events = ctx as unknown as { on(name: 'yakumo/esbuild', callback: Events['yakumo/esbuild']): () => boolean }
  events.on('yakumo/esbuild', (workspace, options, next) => {
    if (ctx.yakumo.workspaces[workspace].name !== '@cordisjs/host-bun') return next()
    options.plugins?.unshift({
      name: 'bun-builtins',
      setup(build) {
        build.onResolve({ filter: /^bun(?::|$)/ }, (args) => ({ path: args.path, external: true }))
      },
    })
    // ModuleGraph loads this entry by URL, outside the static dependency walk.
    const entries = options.entryPoints
    if (entries && !Array.isArray(entries) && entries.index) {
      entries.bootstrap = resolve(ctx.yakumo.cwd + workspace, 'src/bootstrap.ts')
    }
    return next()
  })
}
