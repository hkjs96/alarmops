import { sha1, stamp14 } from './hash.js';
import { maxAutoPauseSec, type SuppressionPolicy } from './policy.js';
import { sevLabel, severityRank, type Decision, type Severity } from './types.js';

export const GROUP_GRACE_SEC = 5; // G-5
export const STALE_MARGIN_SEC = 300; // G-6

/**
 * G-1: `{customerId or awsAccountId}#{SEV-n}`. Unmapped accounts use their account id so they never collapse
 * into one `#SEV-x` group (F5, known-bugs 3-3). Last resort (no customer, no account) is the source id.
 */
export function groupKey(e: { customerId: string | null; awsAccountId: string | null; sourceId?: string | null; severity: Severity }): string {
  const axis = e.customerId ?? (e.awsAccountId ? `acct:${e.awsAccountId}` : `src:${e.sourceId ?? 'unknown'}`);
  return `${axis}#${sevLabel(e.severity)}`;
}

/** G-4 deterministic id. */
export const groupId = (key: string, openedAt: Date): string => `g-${sha1(key).slice(0, 16)}-${stamp14(openedAt)}`;

export interface GroupRow {
  id: string;
  groupKey: string;
  customerId: string | null;
  severity: Severity;
  status: 'OPEN' | 'CLOSED' | 'FINALIZED' | 'DELIVERED';
  openedAt: Date;
  groupWaitSec: number;
  closeAt: Date;
  pauseUntil: Date | null;
  staleAfter: Date;
  deliveredAt: Date | null;
  version: number;
}

/** Stale deadline fixed per grouping 새 구현 3: wait + grace + max auto-pause + margin (G-6 defect). */
export function staleAfter(openedAt: Date, waitSec: number, p: SuppressionPolicy): Date {
  return new Date(openedAt.getTime() + (waitSec + GROUP_GRACE_SEC + maxAutoPauseSec(p) + STALE_MARGIN_SEC) * 1000);
}

/** G-2: only NOTIFY/DEFER state changes enter groups. */
export const entersGroup = (d: Decision): boolean => d === 'NOTIFY' || d === 'DEFER';

export type GroupAssignment = { action: 'JOIN'; groupId: string } | { action: 'OPEN'; group: GroupRow; staleReplaced?: string };

/**
 * G-3: membership is decided at load time. Join the OPEN group of the axis unless it is stale (G-6.1),
 * otherwise open a new one. Group timers use wall clock (S-4). `idTaken` handles same-second reopen (+1s, G-4).
 */
export function assignGroup(
  open: GroupRow | null,
  key: string,
  ctx: { customerId: string | null; severity: Severity; wallNow: Date; policy: SuppressionPolicy; groupWaitSec?: number; idTaken?: (id: string) => boolean },
): GroupAssignment {
  if (open && open.status === 'OPEN' && ctx.wallNow.getTime() <= open.staleAfter.getTime()) return { action: 'JOIN', groupId: open.id };
  const wait = ctx.groupWaitSec ?? ctx.policy.groupWaitSec;
  let openedAt = new Date(Math.floor(ctx.wallNow.getTime() / 1000) * 1000);
  let id = groupId(key, openedAt);
  for (let i = 0; i < 5 && ctx.idTaken?.(id); i++) {
    openedAt = new Date(openedAt.getTime() + 1000);
    id = groupId(key, openedAt);
  }
  const group: GroupRow = {
    id, groupKey: key, customerId: ctx.customerId, severity: ctx.severity, status: 'OPEN', openedAt,
    groupWaitSec: wait, closeAt: new Date(openedAt.getTime() + wait * 1000), pauseUntil: null,
    staleAfter: staleAfter(openedAt, wait, ctx.policy), deliveredAt: null, version: 0,
  };
  return open && open.status === 'OPEN' ? { action: 'OPEN', group, staleReplaced: open.id } : { action: 'OPEN', group };
}

/** G-9: representative = most severe member (ties: first). */
export function representative<T extends { severity: string | null }>(members: T[]): T | null {
  return members.reduce<T | null>((best, m) => (best == null || severityRank(m.severity) < severityRank(best.severity) ? m : best), null);
}
