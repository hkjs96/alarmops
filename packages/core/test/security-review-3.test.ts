/** Regression tests for the third security review (core): R-19 clamp order, R-20 sanitiser, R-21 empty flags. */
import { describe, expect, it } from 'vitest';
import {
  MAX_ALL_RESPONDERS, MAX_SENDS_PER_CYCLE, MemoryTickStore, allResponders, buildSnapshot, clampMessage, clampSnapshot, loadPolicyFlags, parseFlag, parseSnapshot,
  resolveStep, sanitizeProviderError, type Responder, type StepChannel,
} from '../src/index.js';
import { Sim, T0, closedGroup, config, seedWorld, step } from './world.js';

const V = new Date('2026-10-01T00:00:00Z');
const ALL: StepChannel[] = ['SLACK_CHANNEL', 'SLACK_DM', 'SMS', 'VOICE', 'EMAIL'];

/** Mirae Pay with 43 pageable responders: Haeun (on shift in the MSP night desk at T0), Junho, Yuna + 40 staff. */
function crowd(arrange: (rs: Responder[]) => Responder[] = (rs) => rs): MemoryTickStore {
  const s = seedWorld();
  for (let i = 0; i < 40; i++) {
    const id = `ct_s${String(i).padStart(2, '0')}`;
    s.contacts.set(id, { id, kind: 'INTERNAL', customerId: null, name: `Staff ${String(i).padStart(2, '0')}`, active: true, phone: `+82105550${String(i).padStart(4, '0')}`, email: `${id}@example.test`, slackUserId: `U${id}`, phoneVerifiedAt: V, emailVerifiedAt: V, slackVerifiedAt: V });
    s.responders.push({ customerId: 'cus_mirae', contactId: id, role: 'PAGEABLE' });
  }
  const mine = s.responders.filter((r) => r.customerId === 'cus_mirae');
  s.responders = [...s.responders.filter((r) => r.customerId !== 'cus_mirae'), ...arrange(mine)];
  return s;
}
const shuffle = (seed: number) => <T,>(xs: T[]): T[] => {
  const out = [...xs];
  let a = seed;
  for (let i = out.length - 1; i > 0; i--) { a = (Math.imul(a, 1103515245) + 12345) >>> 0; const j = a % (i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
};
const haeunAt = (pos: number) => (rs: Responder[]): Responder[] => { const h = rs.filter((r) => r.contactId === 'ct_haeun'); const rest = rs.filter((r) => r.contactId !== 'ct_haeun'); return [...rest.slice(0, pos), ...h, ...rest.slice(pos)]; };
const ids = (s: MemoryTickStore, channels: StepChannel[] = ALL, steps = 1) =>
  buildSnapshot([config('cus_mirae', Array.from({ length: steps }, (_, i) => step(i, i * 5, 'ALL_RESPONDERS', null, channels)), { repeatCount: 0 })], { customerId: 'cus_mirae' }, s.worldOf('cus_mirae'), T0)!;

describe('R-19: who the send limits leave out does not depend on the order of the rows, and never the person on shift', () => {
  it('the on-shift person is first whatever their place in the list (was: paged only when listed in the first 14)', () => {
    for (const arrange of [haeunAt(0), haeunAt(14), haeunAt(25), haeunAt(42), (rs: Responder[]) => [...rs].reverse(), shuffle(1), shuffle(2), shuffle(3)]) {
      const s = crowd(arrange);
      const { kept, cut } = allResponders(s.worldOf('cus_mirae'), T0);
      expect(kept[0]).toMatchObject({ contactId: 'ct_haeun', onShift: true });
      expect(kept).toHaveLength(MAX_ALL_RESPONDERS);
      expect(cut).toHaveLength(43 - MAX_ALL_RESPONDERS);
      const snap = ids(s, ALL, 4);
      for (const st of snap.steps) expect(st.resolved.map((r) => r.contactId)).toContain('ct_haeun');
    }
  });

  it('the same people are kept for every order of the rows (no `order` set: by contactId)', () => {
    const want = ids(crowd(), ALL, 4).steps.map((st) => st.resolved.map((r) => r.contactId));
    for (const arrange of [(rs: Responder[]) => [...rs].reverse(), shuffle(7), shuffle(8), shuffle(9), haeunAt(42)]) {
      expect(ids(crowd(arrange), ALL, 4).steps.map((st) => st.resolved.map((r) => r.contactId))).toEqual(want);
    }
    expect(want[0]!.slice(0, 4)).toEqual(['ct_haeun', 'ct_junho', 'ct_s00', 'ct_s01']); // on shift, then contactId
  });

  it('`Responder.order` decides who stays; rows without it come last; ties by contactId', () => {
    const withOrder = (rs: Responder[]): Responder[] => rs.map((r) => (r.contactId === 'ct_yuna' ? { ...r, order: 0 } : r.contactId === 'ct_s39' ? { ...r, order: 1 } : r.contactId === 'ct_s38' ? { ...r, order: 1 } : r));
    for (const arrange of [withOrder, (rs: Responder[]) => shuffle(4)(withOrder(rs)), (rs: Responder[]) => withOrder(rs).reverse()]) {
      const { kept } = allResponders(crowd(arrange).worldOf('cus_mirae'), T0);
      expect(kept.slice(0, 5).map((t) => t.contactId)).toEqual(['ct_haeun', 'ct_yuna', 'ct_s38', 'ct_s39', 'ct_junho']);
    }
    // resolveStep and the snapshot use the same list
    const s = crowd(withOrder);
    expect(resolveStep(step(0, 0, 'ALL_RESPONDERS', null, ['SMS']), s.worldOf('cus_mirae'), T0).map((t) => t.contactId)).toEqual(allResponders(s.worldOf('cus_mirae'), T0).kept.map((t) => t.contactId));
  });

  it('channels are taken off before people: 43 responders × 5 channels → 20 people keep SMS + call (was 14 people)', () => {
    const snap = ids(crowd());
    expect(snap.steps[0]!.channels).toEqual(['SLACK_CHANNEL', 'SMS', 'VOICE']); // e-mail first, then Slack DM
    expect(snap.steps[0]!.resolved).toHaveLength(MAX_ALL_RESPONDERS);
    expect(snap.clamped).toMatchObject({ removedChannels: 2, droppedChannels: [{ stepIndex: 0, channel: 'EMAIL' }, { stepIndex: 0, channel: 'SLACK_DM' }], removedPeople: 23 });
    // only e-mail goes when that is enough: 1 + 20 × 2 = 41
    expect(ids(crowd(), ['SLACK_CHANNEL', 'SMS', 'EMAIL', 'SLACK_DM']).steps[0]!.channels).toEqual(['SLACK_CHANNEL', 'SMS', 'SLACK_DM']);
    expect(ids(crowd(), ['SMS', 'VOICE', 'EMAIL']).steps[0]!.channels).toEqual(['SMS', 'VOICE', 'EMAIL']); // 20 × 3 = 60: inside the cap, nothing is taken off
  });

  it('SMS and voice are never taken off, a step keeps a person channel, and 4 steps keep 7 people each on SMS + call (was 3–4 on five channels)', () => {
    const snap = ids(crowd(), ALL, 4);
    for (const st of snap.steps) {
      expect(st.channels).toEqual(['SLACK_CHANNEL', 'SMS', 'VOICE']);
      expect(st.resolved.length).toBe(7);
      expect(st.resolved[0]).toMatchObject({ contactId: 'ct_haeun', onShift: true });
    }
    expect(snap.steps.reduce((n, st) => n + 1 + st.resolved.length * 2, 0)).toBeLessThanOrEqual(MAX_SENDS_PER_CYCLE);
    // a step whose only person channels are e-mail and Slack DM keeps one of them
    const soft = ids(crowd(), ['EMAIL', 'SLACK_DM'], 4);
    for (const st of soft.steps) { expect(st.channels).toEqual(['SLACK_DM']); expect(st.resolved.length).toBeGreaterThanOrEqual(1); }
    // voice only: nothing to take off, people go — but not the person on shift
    const voice = ids(crowd(), ['VOICE'], 4);
    for (const st of voice.steps) { expect(st.channels).toEqual(['VOICE']); expect(st.resolved).toHaveLength(15); expect(st.resolved[0]!.contactId).toBe('ct_haeun'); }
  });

  it('several people on shift (MSP desk + an accepted override on a customer rotation) are all kept, in every step', () => {
    const s = crowd(shuffle(5));
    s.rotations.set('rot_mirae', { id: 'rot_mirae', scope: 'CUSTOMER', customerId: 'cus_mirae', name: 'Mirae on-call', cadence: 'WEEKLY', anchorAt: new Date('2026-11-09T00:00:00Z'), members: [{ contactId: 'ct_s39', order: 0 }, { contactId: 'ct_s38', order: 1 }] });
    s.overrides.push({ rotationId: 'rot_mirae', contactId: 'ct_s37', startAt: new Date(T0.getTime() - 3600_000), endAt: new Date(T0.getTime() + 3600_000), status: 'ACCEPTED' });
    // another customer's rotation does not count
    const snap = ids(s, ALL, 4);
    for (const st of snap.steps) {
      expect(st.resolved.filter((r) => r.onShift).map((r) => r.contactId).sort()).toEqual(['ct_haeun', 'ct_s37']);
      expect(st.resolved.map((r) => r.contactId)).not.toContain('ct_dohyun');
    }
  });

  it('clamping is idempotent, survives a JSON round trip, and an old snapshot without onShift still clamps from the end', () => {
    const snap = ids(crowd(shuffle(6)), ALL, 4);
    expect(clampSnapshot(snap)).toBe(snap);
    expect(parseSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    const old = { ...snap, clamped: undefined, steps: [{ ...snap.steps[0]!, channels: ['VOICE' as const], resolved: Array.from({ length: 70 }, (_, i) => ({ contactId: `c${i}`, name: `N${i}`, via: 'responders' })) }] };
    const cut = clampSnapshot(old);
    expect(cut.steps[0]!.resolved.map((r) => r.contactId)).toEqual(Array.from({ length: 60 }, (_, i) => `c${i}`));
  });

  it('the timeline note lists who is not paged and which channels were taken off; SEV-1 pages the on-shift person', async () => {
    const s = crowd(haeunAt(42));
    s.configs.push(config('cus_mirae', [0, 1, 2, 3].map((i) => step(i, i * 5, 'ALL_RESPONDERS', null, ALL)), { repeatCount: 0 }));
    const sim = new Sim(s);
    closedGroup(s, { customerId: 'cus_mirae', severity: 'SEV_1', at: T0, alerts: [{ id: 'a' }] });
    await sim.tick();
    const inc = sim.incident();
    const note = s.eventsOf(inc.id).filter((e) => e.data?.note === 'SEND_CAP_CLAMPED');
    expect(note).toHaveLength(1);
    const msg = note[0]!.message;
    expect(msg).toMatch(/channels taken off \(step 1: e-mail, Slack DM; step 2: e-mail, Slack DM; step 3: e-mail, Slack DM; step 4: e-mail, Slack DM\)/);
    expect(msg).toMatch(/Not paged — step 1: .*Staff 39/);
    expect(msg).toMatch(/and \d+ more\./);
    expect(msg).toContain('People on shift now are always kept.');
    expect(msg).not.toContain('Haeun');
    // every dropped person is in the event data, by step
    const dropped = note[0]!.data!.dropped as Array<{ stepIndex: number; contactId: string; name: string }>;
    expect(dropped.filter((d) => d.stepIndex === 0)).toHaveLength(43 - 7);
    expect(dropped.some((d) => d.contactId === 'ct_haeun')).toBe(false);
    // step 1 went out in this tick: Haeun (listed LAST) got the SMS and the call
    expect(sim.sms.sent.map((m) => m.contactId)).toContain('ct_haeun');
    expect(sim.voice.sent.map((m) => m.contactId)).toContain('ct_haeun');
    expect(sim.email.sent).toHaveLength(0);
  });

  it('more than 20 responders inside the send caps: the people beyond the limit are named too (was: silent)', () => {
    const snap = ids(crowd(), ['SMS']);
    expect(snap.steps[0]!.resolved).toHaveLength(MAX_ALL_RESPONDERS);
    expect(snap.clamped).toMatchObject({ removedPeople: 23, removedSteps: 0 });
    expect(clampMessage(snap.clamped!)).toMatch(/^Send limit applied: an "everyone in Responders" step reaches at most 20 people — 23 people were left out\. Not paged — step 1: /);
    // 20 or fewer: untouched
    const few = seedWorld();
    expect(buildSnapshot([config('cus_mirae', [step(0, 0, 'ALL_RESPONDERS', null, ALL)], { repeatCount: 0 })], { customerId: 'cus_mirae' }, few.worldOf('cus_mirae'), T0)!.clamped).toBeUndefined();
  });
});

describe('R-20: sanitiser — JSON bodies, camelCase names, invisible characters', () => {
  const clean = (raw: string) => sanitizeProviderError(raw);
  const SECRET = '9f8e7d6c5b';

  it('the reviewer’s line is masked', () => {
    const out = clean(`{"api_key":"${SECRET}","to":"010​1234​5678"} authToken=abc12345 for dohyun(at)hanbit.example`);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('abc12345');
    expect(out).not.toMatch(/1234|5678/);
    expect(out).not.toContain('dohyun');
    expect(out).not.toContain('hanbit');
  });

  it.each([
    `{"api_key":"${SECRET}"}`, `{"api_key": "${SECRET}"}`, `{'token': '${SECRET}'}`, `{"apiKey":"${SECRET}"}`, `{"API_KEY":"${SECRET}"}`, `{"X-Auth-Token":"${SECRET}"}`,
    `{"Authorization":"${SECRET}"}`, `{"authorization": "Custom ${SECRET}"}`, `{"password":"${SECRET}"}`, `{"Password" : "${SECRET}"}`, `{"userPassword":"${SECRET}"}`, `{"db_password":"${SECRET}"}`,
    `{"client_secret":"${SECRET}"}`, `{"clientSecret":"${SECRET}"}`, `{"SECRETKEY":"${SECRET}"}`, `{"refreshToken":"${SECRET}"}`, `{"access_token":"${SECRET}","expires":3600}`,
    `authToken=${SECRET}`, `accessKey=${SECRET}`, `secretKey: ${SECRET}`, `apiSecret=${SECRET}`, `clientSecret=${SECRET}`, `privatekey=${SECRET}`, `PRIVATE_KEY = ${SECRET}`, `sessionToken:${SECRET}`,
    `token(${SECRET})`, `key%3D${SECRET}`, `sig=${SECRET}`, `otp ${SECRET}`, `pin: ${SECRET}`, `{"signature":"${SECRET}"}`, `{"cookie":"sid=${SECRET}"}`, `{"nested":{"my_token_v2":"${SECRET}"}}`,
    `error {"api_key":"my ${SECRET} phrase"} end`, `x-api-key:\t${SECRET}`, `"pass​word":"${SECRET}"`, `{"to­ken":"${SECRET}"}`,
  ])('secret-like key: %s', (raw) => {
    expect(clean(raw)).not.toContain(SECRET);
  });

  it.each([
    'xoxb-12-ab', 'sk-abcdef0123456789', 'https://hooks.slack.com/services/T0001/B0001/abcd', 'POST /services/T0001/B0001/abcd failed',
  ])('short tokens without a label: %s', (raw) => {
    expect(clean(raw)).toMatch(/\[secret\]/);
    expect(clean(raw)).not.toMatch(/abcd|12-ab/);
  });

  it.each([
    '010​1234​5678', '010‌1234‍5678', '010­1234­5678', '010⁠1234﻿5678', '0​1​0​1​2​3​4​5​6​7​8', '010‎-‏1234-5678',
    '010,1234,5678', '010:1234:5678', '010*1234*5678', '010|1234|5678', '010~1234~5678', '[010][1234][5678]', '010 -- 1234 -- 5678', '010&nbsp;1234&nbsp;5678', '+82 (10) 1234 - 5678', '０１０​１２３４​５６７８',
  ])('number with separators or invisible characters: %j', (raw) => {
    const out = clean(`to ${raw} failed`);
    expect(out).toContain('[number]');
    expect(out).not.toMatch(/1234|5678|１２３４/);
  });

  it.each([
    'haeun at msp.example', 'haeun(at)msp.example', 'haeun [at] msp.example', 'haeun&#64;msp.example', 'haeun&#x40;msp.example', 'haeun%2540msp.example', 'haeun @ msp.example', 'haeun@ msp.example', 'ha​eun@msp.example',
  ])('e-mail written around the @: %s', (raw) => {
    const out = clean(`rejected ${raw} now`);
    expect(out).not.toContain('msp.example');
    expect(out).not.toMatch(/haeun/);
  });

  it('an address cut by the 300-character limit does not leave its local part', () => {
    const out = clean(`${'x '.repeat(146)}a haeun@msp.example`); // the cut falls right after the @
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).not.toContain('haeun');
  });

  it('ordinary provider text stays readable, and the cost stays bounded', () => {
    expect(clean('503 Service Unavailable')).toBe('503 Service Unavailable');
    expect(clean('rate limited, retry later')).toBe('rate limited, retry later');
    expect(clean('{"error":"invalid_number","status":400}')).toBe('{"error":"invalid_number","status":400}');
    for (const evil of ['a_'.repeat(200_000), '"key'.repeat(100_000), 'token '.repeat(100_000), '1 '.repeat(200_000), '​'.repeat(500_000), `${'key.'.repeat(80)}=`, 'at '.repeat(100_000)]) {
      const t0 = performance.now();
      expect(clean(evil).length).toBeLessThanOrEqual(300);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });
});

describe('R-21: an empty value for a safety flag keeps the safe default and is reported', () => {
  it('SMS_VOICE_REQUIRE_VERIFIED= (empty, blanks) → still required, with a warning (was: switched off, no warning)', () => {
    for (const v of ['', ' ', '\t', '\n']) {
      expect(parseFlag(v)).toBeUndefined();
      const r = loadPolicyFlags({ SMS_VOICE_REQUIRE_VERIFIED: v, PORTAL_SHOWS_STAFF_NAMES: v });
      expect(r.flags).toEqual({ smsVoiceRequireVerified: true, portalShowsStaffNames: false });
      expect(r.warnings).toEqual([
        'PORTAL_SHOWS_STAFF_NAMES is set but empty; using the safe default false.',
        'SMS_VOICE_REQUIRE_VERIFIED is set but empty; using the safe default true.',
      ]);
    }
  });

  it('unknown values → safe default + a warning that names the variable, never the value; clear values → no warning', () => {
    for (const v of ['nope', 'disabled', 'null', 'undefined', '2', 'falsee', 0, null, {}, []]) {
      const r = loadPolicyFlags({ SMS_VOICE_REQUIRE_VERIFIED: v });
      expect(r.flags.smsVoiceRequireVerified, String(v)).toBe(true);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/^SMS_VOICE_REQUIRE_VERIFIED is not a boolean/);
      if (typeof v === 'string') expect(r.warnings[0]).not.toContain(v);
    }
    expect(loadPolicyFlags({ SMS_VOICE_REQUIRE_VERIFIED: 'false' })).toEqual({ flags: { smsVoiceRequireVerified: false, portalShowsStaffNames: false }, warnings: [] });
    expect(loadPolicyFlags({ SMS_VOICE_REQUIRE_VERIFIED: ' OFF ' }).flags.smsVoiceRequireVerified).toBe(false);
    expect(loadPolicyFlags({}).warnings).toEqual([]);
    expect(loadPolicyFlags({ SMS_VOICE_REQUIRE_VERIFIED: undefined }).warnings).toEqual([]);
  });
});
