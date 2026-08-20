/**
 * Smoke probe: prove the bundle actually loads inside a real dsh composition.
 *
 * Mounted alongside the plugin through a --patch overlay, it waits for the
 * composition to settle, prints the model-visible tool names, and exits before
 * the harness reaches the LLM (so the drill needs no API key).
 *
 * Usage, from the deepseek-harness checkout:
 *   pnpm dsh --profile headless --patch /home/dev/dsh-beads/drill/smoke.patch.yml "probe"
 *
 * See README "Verifying the bundle loads" for the exact commands, including the
 * source-checkout form that needs TSX_TSCONFIG_PATH.
 */

export const name = 'drill-list-tools'
export const inject = ['tools']

const EXPECTED = 9
const DEADLINE_MS = 10_000

export function apply(ctx) {
  const started = Date.now()
  const timer = setInterval(() => {
    const names = ctx.tools.schemas().map((schema) => schema.name).sort()
    const beads = names.filter((name) => name.startsWith('bead_'))
    if (beads.length < EXPECTED && Date.now() - started < DEADLINE_MS) return
    clearInterval(timer)
    process.stdout.write(`[drill] visible tools: ${names.join(', ')}\n`)
    process.stdout.write(`[drill] bead tools (${beads.length}/${EXPECTED}): ${beads.join(', ') || '(none)'}\n`)
    process.exit(beads.length === EXPECTED ? 0 : 1)
  }, 25)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))
}
