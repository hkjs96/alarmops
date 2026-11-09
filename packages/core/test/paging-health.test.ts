import { describe, expect, it } from 'vitest';
import {
  applyLeave, byHealth, onCallAt, pagingHealth, pagingPath, resolvePagingConfig, resolveStep, templateSteps,
  type Contact, type PagingConfig, type PagingWorld, type Rotation,
} from '../src/index.js';
import { t } from './helpers.js';

const V = t('2026-01-01T00:00:00Z');
const staff = (id: string, name: string, extra: Partial<Contact> = {}): Contact =>
  ({ id, kind: 'INTERNAL', customerId: null, name, active: true, phone: '+8210', phoneVerifiedAt: V, slackUserId: 'U' + id, slackVerifiedAt: V, ...extra });
const custP = (id: string, name: string, customerId = 'cus_1', extra: Partial<Contact> = {}): Contact =>
  ({ id, kind: 'CUSTOMER', customerId, name, active: true, phone: '+8211', phoneVerifiedAt: V, ...extra });

const rot: Rotation = {
  id: 'rot_msp', scope: 'MSP', customerId: null, name: 'Night desk', cadence: 'DAILY', anchorAt: t('2026-11-09T00:00:00Z'),
  members: [{ contactId: 'junho', order: 0 }, { contactId: 'minjae', order: 1 }],
};
function world(over: Partial<PagingWorld> = {}): PagingWorld {
  const contacts = [staff('junho', 'Junho'), staff('minjae', 'Minjae'), staff('haeun', 'Haeun'), custP('soyeon', 'Soyeon'), custP('other', 'Other', 'cus_2')];
  return {
    customerId: 'cus_1',
    contacts: new Map(contacts.map((c) => [c.id, c])),
    responders: [
      { customerId: 'cus_1', contactId: 'junho', role: 'PAGEABLE' },
      { customerId: 'cus_1', contactId: 'minjae', role: 'PAGEABLE' },
      { customerId: 'cus_1', contactId: 'soyeon', role: 'PAGEABLE' },
    ],
    rotations: new Map([[rot.id, rot]]),
    overrides: [],
    leaves: [],
    ...over,
  };
}
const cfg = (scopeType: PagingConfig['scopeType'], scopeId: string, steps: PagingConfig['steps'], id = `pc_${scopeType}`): PagingConfig =>
  ({ id, customerId: 'cus_1', scopeType, scopeId, style: 'CUSTOM', plan: 'STANDARD', edited: true, repeatCount: 1, version: 3, steps });

describe('paging config resolution: service › project › customer', () => {
  const configs = [cfg('CUSTOMER', 'cus_1', []), cfg('PROJECT', 'prj_1', []), cfg('SERVICE', 'svc_1', [])];
  it('first existing wins, no merging', () => {
    expect(resolvePagingConfig(configs, { customerId: 'cus_1', projectId: 'prj_1', serviceId: 'svc_1' })?.inheritedFrom).toBe('SERVICE');
    expect(resolvePagingConfig(configs, { customerId: 'cus_1', projectId: 'prj_1', serviceId: 'svc_9' })?.inheritedFrom).toBe('PROJECT');
    expect(resolvePagingConfig(configs, { customerId: 'cus_1', projectId: 'prj_9' })?.inheritedFrom).toBe('CUSTOMER');
    expect(resolvePagingConfig(configs, { customerId: 'cus_2' })).toBeNull();
  });
  it('never uses another customer’s config with a colliding scope id', () => {
    const foreign = { ...cfg('SERVICE', 'svc_1', []), customerId: 'cus_2' };
    expect(resolvePagingConfig([foreign, configs[0]!], { customerId: 'cus_1', serviceId: 'svc_1' })?.inheritedFrom).toBe('CUSTOMER');
  });
});

describe('step targets', () => {
  const at = t('2026-11-09T12:00:00Z');
  it('ROTATION → current shift member; next day rotates', () => {
    expect(resolveStep({ index: 0, atMin: 0, targetType: 'ROTATION', targetId: 'rot_msp', channels: ['SLACK_DM'] }, world(), at).map((x) => x.contactId)).toEqual(['junho']);
    expect(onCallAt(rot, world(), t('2026-11-10T01:00:00Z')).contactId).toBe('minjae');
    expect(onCallAt(rot, world(), t('2026-11-11T01:00:00Z')).contactId).toBe('junho');
  });
  it('accepted override wins, pending does not (D-28)', () => {
    const w = world({ overrides: [
      { rotationId: 'rot_msp', contactId: 'haeun', startAt: t('2026-11-09T10:00:00Z'), endAt: t('2026-11-09T14:00:00Z'), status: 'PENDING' },
    ] });
    expect(onCallAt(rot, w, at).contactId).toBe('junho');
    w.overrides[0]!.status = 'ACCEPTED';
    expect(onCallAt(rot, w, at)).toEqual({ contactId: 'haeun', via: ['rotation', 'override'] });
  });
  it('leave replaces person, rotation shift and responders; KST dates inclusive; chains', () => {
    const leaves = [{ contactId: 'junho', replacementId: 'minjae', startDate: '2026-11-09', endDate: '2026-11-09' }];
    const w = world({ leaves });
    expect(resolveStep({ index: 0, atMin: 0, targetType: 'PERSON', targetId: 'junho', channels: ['SMS'] }, w, at)[0]).toMatchObject({ contactId: 'minjae', via: 'leave' });
    expect(onCallAt(rot, w, at).contactId).toBe('minjae');
    const all = resolveStep({ index: 0, atMin: 0, targetType: 'ALL_RESPONDERS', targetId: null, channels: ['SMS'] }, w, at).map((x) => x.contactId);
    expect(all).toEqual(['minjae', 'soyeon']); // junho out, minjae not duplicated
    // 2026-11-09T15:30Z is 11-10 00:30 KST → leave over
    expect(applyLeave(leaves, 'junho', t('2026-11-09T15:30:00Z'))).toBe('junho');
    const chain = [...leaves, { contactId: 'minjae', replacementId: 'haeun', startDate: '2026-11-09', endDate: '2026-11-09' }];
    expect(applyLeave(chain, 'junho', at)).toBe('haeun');
    const cycle = [{ contactId: 'a', replacementId: 'b', startDate: '2026-11-09', endDate: '2026-11-09' }, { contactId: 'b', replacementId: 'a', startDate: '2026-11-09', endDate: '2026-11-09' }];
    expect(['a', 'b']).toContain(applyLeave(cycle, 'a', at));
  });
  it('customer contacts: own customer + PAGEABLE only; NOTIFY_ONLY and inactive drop out', () => {
    const w = world();
    expect(resolveStep({ index: 0, atMin: 0, targetType: 'PERSON', targetId: 'other', channels: ['SMS'] }, w, at)).toEqual([]);
    w.responders.find((r) => r.contactId === 'soyeon')!.role = 'NOTIFY_ONLY';
    expect(resolveStep({ index: 0, atMin: 0, targetType: 'PERSON', targetId: 'soyeon', channels: ['SMS'] }, w, at)).toEqual([]);
    w.contacts.get('minjae')!.active = false;
    expect(resolveStep({ index: 0, atMin: 0, targetType: 'ALL_RESPONDERS', targetId: null, channels: ['SMS'] }, w, at).map((x) => x.contactId)).toEqual(['junho']);
  });
  it('customer rotation of another customer is refused', () => {
    const r2: Rotation = { ...rot, id: 'rot_c2', scope: 'CUSTOMER', customerId: 'cus_2' };
    const w = world({ rotations: new Map([[r2.id, r2]]) });
    expect(resolveStep({ index: 0, atMin: 0, targetType: 'ROTATION', targetId: 'rot_c2', channels: ['SMS'] }, w, at)).toEqual([]);
  });
});

describe('paging path + sentence', () => {
  it('mixed custom steps: MSP night desk → 10 min customer call', () => {
    const configs = [cfg('CUSTOMER', 'cus_1', [
      { index: 0, atMin: 0, targetType: 'ROTATION', targetId: 'rot_msp', channels: ['SLACK_DM', 'SMS'] },
      { index: 1, atMin: 10, targetType: 'PERSON', targetId: 'soyeon', channels: ['VOICE'] },
    ])];
    const p = pagingPath(configs, { customerId: 'cus_1' }, world(), t('2026-11-09T12:00:00Z'))!;
    expect(p.steps.map((s) => s.names)).toEqual([['Junho'], ['Soyeon']]);
    expect(p).toMatchObject({ inheritedFrom: 'CUSTOMER', stopAtMin: 10, repeatCount: 1, version: 3 });
    expect(p.sentence).toBe('Immediately, Slack DM + SMS Junho. At 10 min, call Soyeon. Then repeat once.');
  });
  it('nothing configured → null (caller shows "nobody gets paged", known-bugs 7-3)', () => {
    expect(pagingPath([], { customerId: 'cus_1' }, world(), t('2026-11-09T12:00:00Z'))).toBeNull();
  });
  it('templates (DATA-MODEL §5)', () => {
    const P = { targetType: 'ROTATION' as const, targetId: 'r' };
    expect(templateSteps('STANDARD', P, false).map((s) => [s.atMin, s.channels[0], s.targetType])).toEqual([
      [0, 'SLACK_CHANNEL', 'ROTATION'], [2, 'SMS', 'ROTATION'], [7, 'VOICE', 'ROTATION'], [12, 'VOICE', 'ALL_RESPONDERS']]);
    expect(templateSteps('URGENT', P, true)).toHaveLength(1);
    expect(templateSteps('QUIET', P, false)[1]).toMatchObject({ atMin: 15, targetType: 'ALL_RESPONDERS' });
  });
});

describe('paging health (D-32)', () => {
  const now = t('2026-11-09T12:00:00Z');
  const base = (steps: PagingConfig['steps']) => cfg('CUSTOMER', 'cus_1', steps);
  it('OK when every step reaches a verified contact', () => {
    const h = pagingHealth(base([{ index: 0, atMin: 0, targetType: 'ALL_RESPONDERS', targetId: null, channels: ['SMS'] }]), world(), now);
    expect(h).toEqual({ level: 'OK', problems: [] });
  });
  it('UNREACHABLE when no step reaches a verified contact', () => {
    const w = world();
    for (const c of w.contacts.values()) { c.phoneVerifiedAt = null; c.slackVerifiedAt = null; }
    const h = pagingHealth(base([{ index: 0, atMin: 0, targetType: 'ALL_RESPONDERS', targetId: null, channels: ['SMS'] }]), w, now);
    expect(h.level).toBe('UNREACHABLE');
    expect(h.problems.map((p) => p.code)).toContain('STEP_UNVERIFIED_ONLY');
  });
  it('UNREACHABLE with no steps or no config', () => {
    expect(pagingHealth(null, world(), now).level).toBe('UNREACHABLE');
    expect(pagingHealth(base([]), world(), now).level).toBe('UNREACHABLE');
  });
  it('AT_RISK: one step only unverified; phone step with unverified phone', () => {
    const w = world();
    w.contacts.get('soyeon')!.phoneVerifiedAt = null;
    const h = pagingHealth(base([
      { index: 0, atMin: 0, targetType: 'PERSON', targetId: 'junho', channels: ['SMS'] },
      { index: 1, atMin: 10, targetType: 'PERSON', targetId: 'soyeon', channels: ['VOICE'] },
    ]), w, now);
    expect(h.level).toBe('AT_RISK');
    expect(h.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'STEP_UNVERIFIED_ONLY', stepIndex: 1, contactIds: ['soyeon'] }),
      expect.objectContaining({ code: 'NO_VERIFIED_PHONE', stepIndex: 1, contactIds: ['soyeon'] }),
    ]));
  });
  it('AT_RISK: rotation gap within 14 days (member deactivated)', () => {
    const w = world();
    w.contacts.get('minjae')!.active = false;
    const h = pagingHealth(base([{ index: 0, atMin: 0, targetType: 'ROTATION', targetId: 'rot_msp', channels: ['SLACK_DM'] }]), w, now);
    expect(h.level).toBe('AT_RISK');
    expect(h.problems.find((p) => p.code === 'ROTATION_GAP')).toMatchObject({ rotationId: 'rot_msp', from: '2026-11-10T00:00:00.000Z', to: '2026-11-11T00:00:00.000Z' });
  });
  it('NO_PAGEABLE_RESPONDER flagged; SLACK_CHANNEL counts only if channel verified', () => {
    const w = world({ responders: [] });
    const steps = base([{ index: 0, atMin: 0, targetType: 'ALL_RESPONDERS', targetId: null, channels: ['SLACK_CHANNEL'] }]);
    const h = pagingHealth(steps, w, now, { slackChannelVerified: true });
    expect(h.problems.map((p) => p.code)).toContain('NO_PAGEABLE_RESPONDER');
    expect(h.level).toBe('UNREACHABLE');
  });
  it('list sorts red first', () => {
    const rows = [{ n: 'ok', pagingHealth: { level: 'OK' as const } }, { n: 'red', pagingHealth: { level: 'UNREACHABLE' as const } }, { n: 'y', pagingHealth: { level: 'AT_RISK' as const } }];
    expect(rows.sort(byHealth).map((r) => r.n)).toEqual(['red', 'y', 'ok']);
  });
});
