/** Package invariant companion for `@deepseek-ai/dsh-memory-admission`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-admission'

export const name = 'memory-admission-invariant'
export const inject = ['invariants']

/** No runtime invariant: reservations are private to the admission waterfall and its paired lifecycle listeners. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
