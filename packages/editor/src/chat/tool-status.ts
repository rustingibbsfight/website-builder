import type { ChatEvent } from '../types';

/**
 * What a tool call in the transcript is *now*, which the transcript cannot say.
 *
 * The durable log is a record of what happened; liveness is not in it. A call
 * that never returned — the turn was killed, the deploy went out mid-run —
 * stays at `input-available` for ever, so a feed that reads the log literally
 * draws a pulsing "running" dot on every reload, permanently.
 *
 * So this takes two things: the event, and whether it is in the **last**
 * message of a turn that is still live. Only the last one can be running. Any
 * unfinished call before it belongs to a turn that has already ended.
 *
 * **An unfinished call is `interrupted`, never `failed`.** ComfyStudio states
 * this for a render and the reason transfers exactly: a `deploy_site` killed
 * after it pushed really did push, and calling that "failed" invites doing it
 * twice. `interrupted` says the honest thing — nobody knows — and the honest
 * thing is what stops a second deploy.
 */

export type ToolStatus = 'running' | 'done' | 'failed' | 'interrupted';

export function toolStatus(event: ChatEvent, live: boolean): ToolStatus {
  if (event.kind !== 'tool') return 'done';
  const state = event.state.toLowerCase();

  if (/error|failed/.test(state)) return 'failed';
  if (/output|result|complete/.test(state)) return 'done';
  // Everything else is a call that had not returned when this was written down.
  return live ? 'running' : 'interrupted';
}

/**
 * Which events may be considered live at all.
 *
 * The index of the last event, and only when the turn itself is still going.
 * Passing `live: false` for everything is what a finished turn looks like, and
 * it is the state a reload lands in.
 */
export function liveAt(events: readonly ChatEvent[], turnLive: boolean): number {
  return turnLive ? events.length - 1 : -1;
}

export const STATUS_LABEL: Record<ToolStatus, string> = {
  running: 'running…',
  done: 'done',
  failed: 'failed',
  // Said in words, because the whole point is that it is not "failed".
  interrupted: 'interrupted — may have run',
};
