import z from 'schemastery'
import type Hmr from './index.ts'

export const Config: z<Hmr.Config> = z.object({
  base: z.string().description('The base directory. Defaults to `ctx.baseUrl`.'),
  activationFailure: z.union(['retain', 'rollback']).default('retain').description(
    'Bun only: retain failed candidate activations, or restore the previous application graph. Module-top-level and global side effects are not rolled back.',
  ),
  watch: z.object({
    enabled: z.boolean().default(false).description('Reload on file changes. Requires the `fs` service.'),
    files: z.array(String).role('table').default([
      '.',
      '!**/node_modules',
      '!**/.*',
    ]).description('Files to watch, in glob patterns relative to `base`, as `filter` of `ctx.fs.watch()`.'),
    debounce: z.natural().role('ms').default(100).description('Debounce changes before reloading, in milliseconds.'),
  }).description('Watch'),
})
