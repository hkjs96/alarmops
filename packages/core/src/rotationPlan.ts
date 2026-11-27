/**
 * Rotation handover plan (D-28): what happens to WHO IS ON SHIFT when a rotation's order, members or handover time change.
 * Pure functions, shared by the API (preview and save) and both stores, so the memory and the SQL store compute the same thing.
 *
 * Model (DATA-MODEL §5 Rotation, RotationPin):
 *  - the shift grid is `anchorAt + k·len` (shiftAt); the KST time of day (weekday for WEEKLY) of anchorAt IS the handover time;
 *  - a RotationPin holds a stretch of time for one person whatever the grid says; the base timetable B(t) is the pin that covers t, else
 *    members[shift mod N];
 *  - a change never moves the person who is on shift now (P0), and never takes a shift away from somebody who asked for cover on it (Q).
 *    Those stretches keep their OLD holder: a pin is written where the new timetable would say somebody else. The new grid starts at the
 *    next person after the current one, at a point that is on the new handover grid (S1), so the KST time of anchorAt' is the handover.
 */
import { sha256 } from './hash.js';
import { orderKey, type Override, type Rotation, type RotationPinLike } from './paging.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const KST_MS = 9 * HOUR_MS;
export const SHIFT_LEN_MS = { DAILY: DAY_MS, WEEKLY: 7 * DAY_MS } as const;
/** Preview window: 8 daily shifts / 4 weekly shifts from the start of the current one. */
export const PREVIEW_SHIFTS = { DAILY: 8, WEEKLY: 4 } as const;
const mod = (a: number, n: number): number => ((a % n) + n) % n;

export type Cadence = 'DAILY' | 'WEEKLY';
export interface Handover { minute: number; dow?: number }
export interface PinIn { contactId: string; startAt: Date; endAt: Date; reason?: string | null }
export interface PlannedPin { contactId: string; startAt: Date; endAt: Date; reason: 'CURRENT_SHIFT' | 'KEEP_OVERRIDE' }

/** Handover time of an anchor: minutes after KST midnight and KST weekday (0 = Sunday … 6 = Saturday). */
export function handoverOf(cadence: Cadence, anchorAt: Date): Handover {
  const k = new Date(anchorAt.getTime() + KST_MS);
  const minute = k.getUTCHours() * 60 + k.getUTCMinutes();
  return cadence === 'WEEKLY' ? { minute, dow: k.getUTCDay() } : { minute };
}

/** t is on the grid iff mod(t + 9h, len) === phase. 1970-01-01 (KST) was a Thursday (dow 4). */
const phaseOf = (cadence: Cadence, h: { minute: number; dow?: number }): number =>
  cadence === 'DAILY' ? h.minute * 60_000 : mod(((h.dow ?? 0) - 4) * DAY_MS + h.minute * 60_000, 7 * DAY_MS);

/** The latest handover time at or before `now` (the first shift of a new rotation starts there). */
export function latestHandover(cadence: Cadence, h: Handover, now: Date): Date {
  const len = SHIFT_LEN_MS[cadence];
  return new Date(now.getTime() - mod(now.getTime() + KST_MS - phaseOf(cadence, h), len));
}

/** Member ids in rotation order (the order shiftAt uses). */
export const orderedMemberIds = (members: ReadonlyArray<{ contactId: string; order: number }>): string[] => sortedIds(members);
const sortedIds = (members: ReadonlyArray<{ contactId: string; order: number }>): string[] =>
  [...members].sort((a, b) => {
    const x = orderKey(a.order); const y = orderKey(b.order);
    return (x < y ? -1 : x > y ? 1 : 0) || (a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0);
  }).map((m) => m.contactId);

// ───────────────────────────── base timetable ─────────────────────────────

interface Timeline { cadence: Cadence; anchor: number; members: string[]; pins: PinIn[] }
export interface Segment { start: Date; end: Date; contactId: string | null; pinned: boolean }

/** The stretch around `t` with ONE holder in the base timetable: a pin, or a grid shift cut at the pins next to it. */
function segmentAt(tl: Timeline, t: number): Segment {
  const pin = tl.pins.find((p) => p.startAt.getTime() <= t && t < p.endAt.getTime());
  if (pin) return { start: pin.startAt, end: pin.endAt, contactId: pin.contactId, pinned: true };
  const len = SHIFT_LEN_MS[tl.cadence];
  const idx = Math.floor((t - tl.anchor) / len);
  let start = tl.anchor + idx * len;
  let end = start + len;
  for (const p of tl.pins) {
    const s = p.startAt.getTime(); const e = p.endAt.getTime();
    if (e <= t && e > start) start = e;
    if (s > t && s < end) end = s;
  }
  const n = tl.members.length;
  return { start: new Date(start), end: new Date(end), contactId: n ? tl.members[mod(idx, n)]! : null, pinned: false };
}

/** Base-timetable segment of a stored rotation at `at` (pins included; Override and Leave are not). Used by GET /rotations/{id}/shifts. */
export function baseSegmentAt(r: Pick<Rotation, 'cadence' | 'anchorAt' | 'members' | 'pins'>, at: Date): Segment {
  return segmentAt({ cadence: r.cadence, anchor: r.anchorAt.getTime(), members: sortedIds(r.members), pins: r.pins ?? [] }, at.getTime());
}

// ───────────────────────────── the plan ─────────────────────────────

export interface RotationPlanInput {
  rotation: { cadence: Cadence; anchorAt: Date; members: Array<{ contactId: string; order: number }> };
  pins?: PinIn[];
  /** Cover requests of THIS rotation; only PENDING and ACCEPTED ones that have not ended count. */
  overrides?: Array<Pick<Override, 'contactId' | 'startAt' | 'endAt' | 'status'>>;
  proposal: { members?: string[]; handover?: Handover };
  now: Date;
}
export interface PlanRow { start: Date; end: Date; before: string | null; after: string | null; kept: boolean; changed: boolean }
export interface PlanSegment { start: Date; end: Date; contactId: string | null }
export interface RotationPlan {
  anchorAt: Date;
  pins: PlannedPin[];
  rows: PlanRow[];
  /** The shift after the protected current stretch: before = old timetable, after = new timetable. */
  nextShift: { before: PlanSegment | null; after: PlanSegment | null };
  /** The shift that holds `now` in the old timetable. */
  current: { start: Date; end: Date; contactId: string | null };
  changedRows: number;
}

const toSeg = (s: Segment): PlanSegment => ({ start: s.start, end: s.end, contactId: s.contactId });
const MAX_Q_SEGMENTS = 2000;

export function planRotationChange(input: RotationPlanInput): RotationPlan {
  const { cadence } = input.rotation;
  const len = SHIFT_LEN_MS[cadence];
  const now = input.now.getTime();
  const oldM = sortedIds(input.rotation.members);
  const newM = input.proposal.members ? [...input.proposal.members] : oldM;
  if (!newM.length) throw new Error('planRotationChange: a rotation needs at least one member');
  const oldAnchor = input.rotation.anchorAt.getTime();
  const old: Timeline = { cadence, anchor: oldAnchor, members: oldM, pins: input.pins ?? [] };

  // the shift that holds `now`
  const cur = segmentAt(old, now);
  const s0 = cur.start.getTime(); const e0 = cur.end.getTime();
  const c0 = cur.contactId;

  // the new handover grid
  const oldPhase = mod(oldAnchor + KST_MS, len);
  const oldH = handoverOf(cadence, input.rotation.anchorAt);
  let newPhase = oldPhase;
  if (input.proposal.handover) {
    const h = { minute: input.proposal.handover.minute, dow: input.proposal.handover.dow ?? oldH.dow ?? 0 };
    const ph = phaseOf(cadence, h);
    newPhase = ph === Math.floor(oldPhase / 60_000) * 60_000 ? oldPhase : ph;
  }
  const G = e0 + mod(newPhase - (e0 + KST_MS), len);
  const g = G - e0;
  const form: 'NONE' | 'LATE' | 'EARLY' = g === 0 ? 'NONE' : g * 2 <= len ? 'LATE' : 'EARLY';

  // who comes next in the new order
  const oldGridNow = oldM.length ? oldM[mod(Math.floor((now - oldAnchor) / len), oldM.length)]! : null;
  const r0 = c0 !== null && oldM.includes(c0) ? c0 : oldGridNow;
  let p: string = newM[0]!;
  if (r0 !== null && newM.includes(r0)) p = newM[(newM.indexOf(r0) + 1) % newM.length]!;
  else if (r0 !== null) {
    const at = oldM.indexOf(r0);
    for (let i = 1; i <= oldM.length; i++) {
      const cand = oldM[(at + i) % oldM.length]!;
      if (newM.includes(cand)) { p = cand; break; }
    }
  }
  // S1: the first shift of the new order after the protected current stretch; always a point of the new grid
  const S1 = form === 'LATE' ? G : form === 'NONE' ? e0 : G - len;
  const anchor = S1 - newM.indexOf(p) * len;
  if (mod(anchor + KST_MS, len) !== newPhase) throw new Error('planRotationChange: the new anchor is off the handover grid');

  // protected stretches: the current shift (P0) and every old shift a cover request sits on (Q)
  const covers = (input.overrides ?? []).filter((o) => (o.status === 'PENDING' || o.status === 'ACCEPTED') && o.endAt.getTime() > now);
  const qs: Array<{ start: number; end: number; contactId: string }> = [];
  if (covers.length) {
    const last = Math.max(...covers.map((o) => o.endAt.getTime()));
    for (let t = e0, n = 0; t < last && n < MAX_Q_SEGMENTS; n++) {
      const seg = segmentAt(old, t);
      const a = seg.start.getTime(); const b = seg.end.getTime();
      if (seg.contactId && covers.some((o) => o.startAt.getTime() < b && a < o.endAt.getTime())) qs.push({ start: a, end: b, contactId: seg.contactId });
      t = b;
    }
  }
  let p0End = form === 'LATE' ? G : e0;
  for (const q of qs) if (q.start < p0End) p0End = Math.max(e0, q.start); // a cover request wins over the late handover
  const protectedAll: Array<{ start: number; end: number; contactId: string | null; reason: PlannedPin['reason'] }> = [
    { start: s0, end: p0End, contactId: c0, reason: 'CURRENT_SHIFT' },
    ...qs.map((q) => ({ ...q, reason: 'KEEP_OVERRIDE' as const })),
  ];

  // pins only where the new timetable (grid only) would put somebody else
  const grid: Timeline = { cadence, anchor, members: newM, pins: [] };
  const sameHolder = (start: number, end: number, who: string | null): boolean => {
    for (let t = start; t < end;) {
      const seg = segmentAt(grid, t);
      if (seg.contactId !== who) return false;
      t = seg.end.getTime();
    }
    return true;
  };
  const pins: PlannedPin[] = protectedAll
    .filter((x) => x.contactId !== null && !sameHolder(x.start, x.end, x.contactId))
    .map((x) => ({ contactId: x.contactId!, startAt: new Date(x.start), endAt: new Date(x.end), reason: x.reason }))
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  for (let i = 1; i < pins.length; i++) if (pins[i]!.startAt.getTime() < pins[i - 1]!.endAt.getTime()) throw new Error('planRotationChange: planned pins overlap');
  const next: Timeline = { cadence, anchor, members: newM, pins };

  // rows: old and new timetable side by side over 8 / 4 shifts
  const wEnd = s0 + PREVIEW_SHIFTS[cadence] * len;
  const marks = [...new Set(protectedAll.flatMap((x) => [x.start, x.end]))].sort((a, b) => a - b);
  const rows: PlanRow[] = [];
  for (let t = s0; t < wEnd;) {
    const o = segmentAt(old, t); const n = segmentAt(next, t);
    const nextMark = marks.find((m) => m > t) ?? Infinity;
    const end = Math.min(o.end.getTime(), n.end.getTime(), nextMark, wEnd);
    const kept = protectedAll.some((x) => x.start <= t && t < x.end);
    const prev = rows[rows.length - 1];
    if (prev && prev.before === o.contactId && prev.after === n.contactId && prev.kept === kept) prev.end = new Date(end);
    else rows.push({ start: new Date(t), end: new Date(end), before: o.contactId, after: n.contactId, kept, changed: o.contactId !== n.contactId });
    t = end;
  }
  return {
    anchorAt: new Date(anchor), pins, rows, current: { start: cur.start, end: cur.end, contactId: c0 },
    nextShift: { before: toSeg(segmentAt(old, e0)), after: toSeg(segmentAt(next, p0End)) },
    changedRows: rows.filter((r) => r.changed).length,
  };
}

// ───────────────────────────── preview hash ─────────────────────────────

const stable = (v: unknown): string =>
  v === undefined ? 'null' : v instanceof Date ? JSON.stringify(v.toISOString()) : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : v !== null && typeof v === 'object' ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v) ?? 'null';

/**
 * SHA-256 over everything the save would write or show: rotation id and version, the proposal (name, member order, handover),
 * the new anchor, ALL planned pins (not cut to the window: what is hashed is what is stored), the rows (who, when, kept) and the
 * ids of the customers that use the rotation. Names and `active` flags are not in it; pin ids and createdAt do not exist yet.
 */
export function rotationPreviewHash(x: {
  rotationId: string; version: number; proposal: { name: string; members: string[]; handover: Handover }; plan: RotationPlan; customerIds: string[];
}): string {
  return sha256(stable({
    rotationId: x.rotationId, version: x.version, proposal: x.proposal, anchorAt: x.plan.anchorAt,
    pins: x.plan.pins.map((p) => ({ contactId: p.contactId, startAt: p.startAt, endAt: p.endAt, reason: p.reason })),
    rows: x.plan.rows.map((r) => ({ start: r.start, end: r.end, before: r.before, after: r.after, kept: r.kept })),
    customerIds: [...x.customerIds].sort(),
  }));
}

export type { RotationPinLike };
