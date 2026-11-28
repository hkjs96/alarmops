/**
 * planRotationChange (D-28 shift handover) as a pure function: invariants over random starting states.
 *
 * The reference below is written from the criteria, not from the implementation:
 *  - the new anchorAt' keeps the proposed handover (or the one derived from the OLD anchorAt when none is proposed) in KST,
 *    weekday included for WEEKLY;
 *  - the pins of the result never overlap;
 *  - whoever holds the shift that contains `now` (a pin wins over the schedule) is the same before and after.
 *
 * Assumed signature (change it here if the function is named differently):
 *   planRotationChange({ rotation: { cadence, anchorAt, members: [{ contactId, order }] }, pins: [{ contactId, startAt, endAt }],
 *     overrides: [{ contactId, startAt, endAt, status }], proposal: { members?: string[], handover?: { dow?: number, minute: number } }, now })
 *     -> { anchorAt: Date, pins: [{ contactId, startAt, endAt }] }
 */
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import { shiftAt, type Rotation } from '../src/index.js';

type Pin = { contactId: string; startAt: Date; endAt: Date };
interface State { cadence: 'DAILY' | 'WEEKLY'; anchorAt: Date; members: string[]; pins: Pin[] }

const plan = (core as unknown as { planRotationChange: (i: Record<string, unknown>) => { anchorAt: Date; pins: Pin[] } }).planRotationChange;

const HOUR = 3_600_000, DAY = 24 * HOUR;
const kstParts = (d: Date) => { const k = new Date(d.getTime() + 9 * HOUR); return { dow: k.getUTCDay(), minute: k.getUTCHours() * 60 + k.getUTCMinutes() }; };
const asRotation = (s: State): Rotation => ({ id: 'rot', scope: 'MSP', customerId: null, name: 'r', cadence: s.cadence, anchorAt: s.anchorAt, members: s.members.map((contactId, order) => ({ contactId, order })) });
/** Reference: a pin covering `t` wins, else the schedule. */
const holderAt = (s: State, t: Date): string | null => s.pins.find((p) => p.startAt.getTime() <= t.getTime() && t.getTime() < p.endAt.getTime())?.contactId ?? shiftAt(asRotation(s), t).scheduledContactId;

function rng(seed: number): () => number { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

describe('planRotationChange invariants', () => {
  it('is exported', () => { expect(typeof plan).toBe('function'); });

  it('anchorAt\' keeps the handover, pins never overlap and the holder of the current shift never changes (random starts, 600 runs)', () => {
    const r = rng(20261127);
    const int = (n: number) => Math.floor(r() * n);
    const ids = ['ct_a', 'ct_b', 'ct_c', 'ct_d', 'ct_e', 'ct_f'];
    for (let run = 0; run < 600; run++) {
      const cadence: 'DAILY' | 'WEEKLY' = r() < 0.5 ? 'DAILY' : 'WEEKLY';
      const len = cadence === 'DAILY' ? DAY : 7 * DAY;
      const oldMinute = int(48) * 30;
      const members = [...ids].sort(() => r() - 0.5).slice(0, 1 + int(5));
      // anchor: a Monday 00:00 KST (2026-11-09T00:00+09:00), plus a day offset for WEEKLY, plus the handover time, minus a whole number of shifts
      const base = new Date('2026-11-09T00:00:00+09:00').getTime() + (cadence === 'WEEKLY' ? int(7) * DAY : 0) + oldMinute * 60_000;
      const now = new Date(new Date('2026-11-09T00:00:00+09:00').getTime() + int(40 * 24) * HOUR + int(60) * 60_000 + 7 * DAY);
      const k = Math.floor((now.getTime() - base) / len) - int(6); // anchor some shifts before the current one
      const anchorAt = new Date(base + k * len);
      const start: State = { cadence, anchorAt, members, pins: [] };
      const cur = shiftAt(asRotation(start), now);
      // existing pins: none, or one that holds the current shift for somebody (an earlier handover change), optionally a later one (a kept cover)
      if (r() < 0.4) {
        const who = members[int(members.length)]!;
        const shift = new Date(cur.end.getTime() + int(5) * 30 * 60_000);
        start.pins.push({ contactId: who, startAt: cur.start, endAt: shift });
        if (r() < 0.3) start.pins.push({ contactId: members[int(members.length)]!, startAt: shift, endAt: new Date(shift.getTime() + len) });
      }
      const overrides = r() < 0.5 ? [{ contactId: ids[int(6)]!, startAt: cur.end, endAt: new Date(cur.end.getTime() + len * (1 + int(3))), status: r() < 0.5 ? 'PENDING' : 'ACCEPTED' }] : [];
      const proposal: { members?: string[]; handover?: { dow?: number; minute: number } } = {};
      if (r() < 0.6) {
        const next = [...ids].sort(() => r() - 0.5).slice(0, 1 + int(5));
        if (r() < 0.5 && members.length > 1) next.splice(0, next.length, ...[...members].sort(() => r() - 0.5)); // a pure reorder
        proposal.members = next;
      }
      if (r() < 0.6) proposal.handover = { ...(cadence === 'WEEKLY' ? { dow: int(7) } : {}), minute: int(48) * 30 };
      const holderBefore = holderAt(start, now);

      const out = plan({ rotation: { cadence, anchorAt, members: members.map((contactId, order) => ({ contactId, order })) }, pins: start.pins, overrides, proposal, now });

      const label = `run ${run} ${cadence} ${JSON.stringify({ members, proposal, pins: start.pins.map((p) => [p.contactId, p.startAt.toISOString(), p.endAt.toISOString()]), now: now.toISOString(), anchorAt: anchorAt.toISOString() })}`;
      const expected = proposal.handover ?? kstParts(anchorAt);
      const got = kstParts(out.anchorAt);
      expect(got.minute, label).toBe(expected.minute);
      if (cadence === 'WEEKLY') expect(got.dow, label).toBe((expected as { dow?: number }).dow ?? kstParts(anchorAt).dow);
      const pins = [...out.pins].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      for (let i = 0; i < pins.length; i++) {
        expect(pins[i]!.endAt.getTime(), label).toBeGreaterThan(pins[i]!.startAt.getTime());
        if (i > 0) expect(pins[i]!.startAt.getTime(), label).toBeGreaterThanOrEqual(pins[i - 1]!.endAt.getTime());
      }
      const after: State = { cadence, anchorAt: out.anchorAt, members: proposal.members ?? members, pins };
      expect(holderAt(after, now), label).toBe(holderBefore);
    }
  });
});
