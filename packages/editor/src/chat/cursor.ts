/**
 * How long a turn has been going, read at render.
 *
 * Never a number carried in state and ticked. A laptop that sleeps and a phone
 * that locks both suspend timers, so a carried elapsed value is a snapshot from
 * before the lid closed — and the panel would confidently report "12s" over a
 * turn that started an hour ago. ComfyStudio has this rule as *"`elapsedFor` is
 * the only thing that asks the clock"*, arrived at through exactly that bug.
 *
 * So: store `startedAt`, subtract at render. The component re-renders on its
 * poll anyway, so nothing extra is needed to keep it moving.
 */

/** Past this, a turn is worth remarking on rather than merely waiting for. */
export const SLOW_AFTER_MS = 45_000;

export function elapsedFor(startedAt: number | null, now: number): number {
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

export function describeElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * Whether to say something about how long this is taking.
 *
 * A prompt to look, never a verdict: the turn may be a minute from finishing,
 * and a panel that declared it stuck would be wrong in the direction that makes
 * somebody cancel work they had already paid for.
 */
export const isSlow = (elapsedMs: number) => elapsedMs >= SLOW_AFTER_MS;
