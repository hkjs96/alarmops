import type { EventState } from '../types.js';

/** F-8 CloudWatch: ALARM→FIRING, OK→RESOLVED, INSUFFICIENT_DATA, other→FIRING. */
export function cloudwatchState(v: string | null | undefined): EventState {
  switch ((v ?? '').toUpperCase()) {
    case 'OK': return 'RESOLVED';
    case 'INSUFFICIENT_DATA': return 'INSUFFICIENT_DATA';
    default: return 'FIRING';
  }
}

/** F-8 webhook: firing/alerting/active→FIRING, resolved/ok→RESOLVED, no_data/nodata/paused→INSUFFICIENT_DATA. */
export function webhookState(v: string | null | undefined): EventState {
  const s = (v ?? '').toLowerCase();
  if (s === 'resolved' || s === 'ok' || s === 'normal') return 'RESOLVED';
  if (s === 'no_data' || s === 'nodata' || s === 'paused') return 'INSUFFICIENT_DATA';
  return 'FIRING';
}
