import { describe, expect, it } from 'vitest';
import { USERS, at, body, version, world } from './helpers.js';

describe('GET /incidents/{id}', () => {
  it('detail: members, frozen paging order, escalation progress, RCA placeholder; ETag = version', async () => {
    const w = await world();
    const r = await w.call(USERS.haeun, 'GET', `/incidents/${w.ids.mirae}`);
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe('"1"');
    const d = body(r);
    expect(d.alerts.map((a: any) => [a.id, a.status])).toEqual([['al_m1', 'FIRING'], ['al_m2', 'FIRING']]);
    expect(d.assignmentSnapshot).toMatchObject({ level: 'CUSTOMER', planLabel: 'Shared MSP rotation · Standard', repeatCount: 1, pagingConfigId: 'pc_cus_mirae_CUSTOMER' });
    expect(d.assignmentSnapshot.steps.map((s: any) => [s.atMin, s.targetType, s.resolved.map((p: any) => p.name).join('+'), s.channels.join()])).toEqual([
      [0, 'ROTATION', 'Haeun Kim', 'SLACK_CHANNEL'], [2, 'ROTATION', 'Haeun Kim', 'SMS'], [7, 'ROTATION', 'Haeun Kim', 'VOICE'], [12, 'ALL_RESPONDERS', 'Haeun Kim+Junho Park+Yuna Seo', 'VOICE'],
    ]);
    expect(JSON.stringify(d)).not.toMatch(/\+82|@example\.test|U_ct_/); // no contact addresses anywhere in the incident (R3-2, D-35)
    expect(d.rcaPlaceholder).toEqual({ availableAfterPoc: true });
    expect(d.paged).toEqual([{ label: 'Paged step 1/4: Slack Haeun Kim.', at: '2026-11-09T03:00:00.000Z', done: true }, { label: 'Step 2 · SMS Haeun Kim', at: '2026-11-09T03:02:00.000Z', done: false }]);
    expect(d.notificationCount).toBe(1);
  });

  it('timeline and notification log, paged by cursor', async () => {
    const w = await world();
    await w.sim.run(3);
    const t1 = body(await w.call(USERS.yuna, 'GET', `/incidents/${w.ids.mirae}/timeline`, { query: { limit: '2' } }));
    expect(t1.items.map((e: any) => e.kind)).toEqual(['TRIGGERED', 'NOTE']);
    const t2 = body(await w.call(USERS.yuna, 'GET', `/incidents/${w.ids.mirae}/timeline`, { query: { limit: '2', cursor: t1.nextCursor } }));
    expect(t2.items.map((e: any) => e.kind)).toEqual(['NOTIFIED', 'ESCALATED']);
    expect(t2.items[1].message).toContain('of the previous page 2026-11-09 03:00Z'); // known-bugs 7-2
    expect(t2.nextCursor).toBeNull();
    const n = body(await w.call(USERS.yuna, 'GET', `/incidents/${w.ids.mirae}/notifications`));
    expect(n.items.map((l: any) => [l.channel, l.status, l.targetSummary, l.escalationStep, l.providerMessageId])).toEqual([['SLACK_BOT', 'SENT', 'C_MIRAE', 0, expect.stringMatching(/^slack-\d$/)], ['SMS', 'SENT', 'Haeun Kim', 1, 'sms-1']]);
  });
});

describe('POST /incidents/{id}/ack — If-Match (security R-3)', () => {
  it('missing If-Match → 400, stale → 409 VERSION_CONFLICT with nothing changed, current → 200 + undoToken', async () => {
    const w = await world();
    const id = w.ids.mirae;
    const none = await w.call(USERS.haeun, 'POST', `/incidents/${id}/ack`);
    expect(none.status).toBe(400);
    expect(body(none).error).toMatchObject({ code: 'VALIDATION_FAILED', details: { fields: [{ field: 'If-Match' }] } });
    expect((await w.call(USERS.haeun, 'POST', `/incidents/${id}/ack`, { headers: { 'If-Match': 'abc' } })).status).toBe(400);
    const stale = await w.call(USERS.haeun, 'POST', `/incidents/${id}/ack`, { headers: { 'If-Match': '0' } });
    expect(stale.status).toBe(409);
    expect(body(stale).error).toMatchObject({ code: 'VERSION_CONFLICT', message: 'Incident was updated by someone else.', details: { currentVersion: 1 } });
    expect(w.store.incidents.get(id)!.status).toBe('TRIGGERED');

    const r = await w.call(USERS.haeun, 'POST', `/incidents/${id}/ack`, { headers: { 'if-match': '"1"' } });
    expect(r.status).toBe(200);
    expect(body(r).incident).toMatchObject({ id, status: 'ACKNOWLEDGED', version: 2, acknowledgedBy: { contactId: 'usr_haeun', name: 'Haeun Kim' }, escalation: { state: 'STOPPED_ACKED', nextAt: null, stoppedAt: '2026-11-09T03:00:00.000Z' } });
    expect(body(r).undoToken).toMatch(/^undo_/);
    expect(body(r).incident.alerts.every((a: any) => a.status === 'ACKNOWLEDGED')).toBe(true); // D-24: one ack covers every member alert
    expect(w.store.audits.at(-1)).toMatchObject({ action: 'incident.ack', actorId: 'usr_haeun', targetId: id, customerId: 'cus_mirae' });
    const again = await w.call(USERS.haeun, 'POST', `/incidents/${id}/ack`, { headers: { 'If-Match': '2' } });
    expect(again.status).toBe(409);
    expect(body(again).error.code).toBe('INVALID_TRANSITION');
  });

  it('an ack pressed on a list that is older than the last escalation does not apply', async () => {
    const w = await world();
    const seen = version(w, w.ids.mirae);
    await w.sim.run(2); // the tick pages step 2 → the incident changed
    const r = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': seen } });
    expect(r.status).toBe(409);
    expect(w.store.incidents.get(w.ids.mirae)!.status).toBe('TRIGGERED');
    // …and merely re-scheduling (mute bookkeeping) does not invalidate what the user saw
    w.store.windows.push({ id: 'mw', customerId: 'cus_hanbit', scopeType: 'CUSTOMER', scopeId: null, startsAt: at(0), endsAt: at(600) });
    const hanbitSeen = version(w, w.ids.hanbit);
    await w.sim.run(8);
    expect((await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.hanbit}/ack`, { headers: { 'If-Match': hanbitSeen } })).status).toBe(200);
  });

  it('ack stops paging; the tick sends nothing more', async () => {
    const w = await world();
    await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': '1' } });
    await w.sim.run(40);
    expect(w.sim.timeline(w.ids.mirae)).toEqual(['0 SLACK_BOT scope']);
  });

  it('undo: the same person within 5 minutes; paging continues from the step where it stopped', async () => {
    const w = await world();
    await w.sim.run(2);
    w.sim.now = at(2, 30);
    const ack = body(await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': version(w, w.ids.mirae) } }));
    // someone else cannot use the token, and it stays valid for its owner
    const other = await w.call(USERS.minjae, 'POST', '/incidents/bulk/undo', { body: { undoToken: ack.undoToken } });
    expect(other.status).toBe(404);
    w.sim.now = at(5);
    const undo = await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: ack.undoToken } });
    expect(body(undo)).toEqual({ restored: [w.ids.mirae], skipped: [] });
    expect(w.store.incidents.get(w.ids.mirae)).toMatchObject({ status: 'TRIGGERED', acknowledgedAt: null, acknowledgedBy: null, escalationStep: 2 });
    expect(w.store.alertAcked.get('al_m1')).toBe(false);
    await w.sim.run(12);
    expect(w.sim.timeline(w.ids.mirae)).toEqual(['0 SLACK_BOT scope', '2 SMS Haeun Kim', '7 VOICE Haeun Kim', '12 VOICE Haeun Kim', '12 VOICE Junho Park', '12 VOICE Yuna Seo']);
    // single use
    expect((await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: ack.undoToken } })).status).toBe(404);
  });

  it('undo: expired after 5 minutes; skipped when the incident changed in between', async () => {
    const w = await world();
    const a = body(await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, { headers: { 'If-Match': '1' } }));
    w.sim.now = at(5, 1);
    expect((await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: a.undoToken } })).status).toBe(404);
    const b = body(await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.hanbit}/ack`, { headers: { 'If-Match': version(w, w.ids.hanbit) } }));
    await w.call(USERS.minjae, 'POST', `/incidents/${w.ids.hanbit}/resolve`, { headers: { 'If-Match': version(w, w.ids.hanbit) }, body: {} });
    expect(body(await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: b.undoToken } }))).toEqual({ restored: [], skipped: [{ id: w.ids.hanbit, code: 'VERSION_CONFLICT' }] });
    expect(w.store.incidents.get(w.ids.hanbit)!.status).toBe('RESOLVED');
  });
});

describe('resolve, escalate, roles', () => {
  it('resolve records kind + note, needs If-Match, returns the detail', async () => {
    const w = await world();
    const id = w.ids.mirae;
    expect((await w.call(USERS.haeun, 'POST', `/incidents/${id}/resolve`, { body: { kind: 'RESTART' } })).status).toBe(400);
    expect((await w.call(USERS.haeun, 'POST', `/incidents/${id}/resolve`, { headers: { 'If-Match': '1' }, body: { kind: 'reboot' } })).status).toBe(400);
    w.sim.now = at(4);
    const r = await w.call(USERS.haeun, 'POST', `/incidents/${id}/resolve`, { headers: { 'If-Match': '1' }, body: { kind: 'RESTART', note: 'restarted the pod' } });
    expect(body(r)).toMatchObject({ id, status: 'RESOLVED', resolvedVia: 'MANUAL', resolvedAt: '2026-11-09T03:04:00.000Z', escalation: { state: 'STOPPED_RESOLVED' } });
    expect(w.store.resolutions).toEqual([expect.objectContaining({ via: 'MANUAL', kind: 'RESTART', note: 'restarted the pod', resolvedBy: 'usr_haeun', durationSec: 240, serviceId: 'svc_pay' })]);
    expect(body(await w.call(USERS.haeun, 'POST', `/incidents/${id}/resolve`, { headers: { 'If-Match': '2' }, body: {} })).error.code).toBe('INVALID_TRANSITION');
    await w.sim.run(30);
    expect(w.sim.timeline(id)).toEqual(['0 SLACK_BOT scope']);
  });

  it('escalate pages the next step now, once; stale If-Match → 409 and nobody is paged', async () => {
    const w = await world();
    const id = w.ids.mirae;
    w.sim.now = at(0, 30);
    const stale = await w.call(USERS.haeun, 'POST', `/incidents/${id}/escalate`, { headers: { 'If-Match': '0' } });
    expect(stale.status).toBe(409);
    expect(w.store.jobList(id)).toHaveLength(1);
    const r = await w.call(USERS.haeun, 'POST', `/incidents/${id}/escalate`, { headers: { 'If-Match': '1' } });
    expect(body(r)).toMatchObject({ status: 'TRIGGERED', escalated: true, version: 2, escalation: { step: 1, nextAt: '2026-11-09T03:05:30.000Z' } });
    expect(w.store.eventsOf(id).at(-1)).toMatchObject({ kind: 'ESCALATED', actorType: 'USER', actorId: 'usr_haeun', message: 'Escalated manually by Haeun Kim → step 2/4: SMS Haeun Kim.' });
    await w.sim.run(4);
    expect(w.sim.timeline(id)).toEqual(['0 SLACK_BOT scope', '1 SMS Haeun Kim']); // queued at 00:30, not paged again by the tick at 2
    expect(w.sim.sms.sent).toHaveLength(1);
    // nothing to escalate to
    expect(body(await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.unmapped}/escalate`, { headers: { 'If-Match': version(w, w.ids.unmapped) } })).error)
      .toMatchObject({ code: 'INVALID_TRANSITION', message: 'No call order applies to this incident: there is nobody to escalate to.' });
  });

  it('VIEWER and portal users cannot act on what they can see → 403 ROLE_REQUIRED', async () => {
    const w = await world();
    for (const who of [USERS.viewer, USERS.yuna, { ...USERS.yuna, role: 'ADMIN' as const }]) {
      for (const action of ['ack', 'resolve', 'escalate']) {
        const r = await w.call(who, 'POST', `/incidents/${w.ids.mirae}/${action}`, { headers: { 'If-Match': '1' }, body: {} });
        expect(r.status).toBe(403);
        expect(body(r).error).toMatchObject({ code: 'ROLE_REQUIRED', details: { role: 'OPERATOR' } });
      }
      expect((await w.call(who, 'POST', '/incidents/bulk', { body: { action: 'ack', items: [{ id: w.ids.mirae, version: 1 }], preview: false } })).status).toBe(403);
    }
    expect(w.store.incidents.get(w.ids.mirae)!.status).toBe('TRIGGERED');
  });

  it('Idempotency-Key: the same key replays the first response instead of acting twice', async () => {
    const w = await world();
    const opts = { headers: { 'If-Match': '1', 'Idempotency-Key': 'k-1' } };
    const a = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, opts);
    const b = await w.call(USERS.haeun, 'POST', `/incidents/${w.ids.mirae}/ack`, opts);
    expect(a.status).toBe(200);
    expect(b).toEqual(a);
    expect(w.store.audits.filter((x) => x.action === 'incident.ack')).toHaveLength(1);
    // another user's same key is a different request
    expect((await w.call(USERS.minjae, 'POST', `/incidents/${w.ids.mirae}/ack`, opts)).status).toBe(409);
  });
});

describe('POST /incidents/bulk — items [{ id, version }]', () => {
  it('`ids` without versions is rejected; every item needs a version; preview must be explicit', async () => {
    const w = await world();
    const bad = async (b: unknown) => {
      const r = await w.call(USERS.haeun, 'POST', '/incidents/bulk', { body: b });
      expect(r.status).toBe(400);
      return body(r).error.details.fields.map((f: any) => f.field);
    };
    expect(await bad({ action: 'ack', ids: [w.ids.mirae], preview: false })).toEqual(['ids', 'items']);
    expect(await bad({ action: 'ack', ids: [w.ids.mirae], items: [{ id: w.ids.mirae, version: 1 }], preview: false })).toEqual(['ids']);
    expect(await bad({ action: 'ack', items: [{ id: w.ids.mirae }], preview: false })).toEqual(['items[0].version']);
    expect(await bad({ action: 'ack', items: [{ id: w.ids.mirae, version: 1 }] })).toEqual(['preview']);
    expect(await bad({ action: 'delete', items: [{ id: w.ids.mirae, version: 1 }], preview: true })).toEqual(['action']);
    expect(w.store.incidents.get(w.ids.mirae)!.status).toBe('TRIGGERED');
  });

  it('preview lists targets and skips; execute skips stale and invisible items and runs the rest; undo restores them', async () => {
    const w = await world();
    const items = [
      { id: w.ids.mirae, version: 1 },
      { id: w.ids.hanbit, version: 0 }, // stale
      { id: w.ids.unmapped, version: 0 }, // never paged, so still at its first version
      { id: 'inc-nope', version: 1 },
    ];
    const preview = body(await w.call(USERS.haeun, 'POST', '/incidents/bulk', { body: { action: 'ack', items, preview: true } }));
    expect(preview.targets.map((t: any) => t.id)).toEqual([w.ids.mirae, w.ids.unmapped]);
    expect(preview.skipped).toEqual([{ id: w.ids.hanbit, reason: 'VERSION_CONFLICT' }, { id: 'inc-nope', reason: 'NOT_FOUND' }]);
    expect(w.store.incidents.get(w.ids.mirae)!.status).toBe('TRIGGERED');

    const run = body(await w.call(USERS.haeun, 'POST', '/incidents/bulk', { body: { action: 'ack', items, preview: false } }));
    expect(run.done).toEqual([w.ids.mirae, w.ids.unmapped]);
    expect(run.conflicts).toEqual([{ id: w.ids.hanbit, code: 'VERSION_CONFLICT' }, { id: 'inc-nope', code: 'NOT_FOUND' }]);
    expect(w.store.incidents.get(w.ids.hanbit)!.status).toBe('TRIGGERED');
    const undo = body(await w.call(USERS.haeun, 'POST', '/incidents/bulk/undo', { body: { undoToken: run.undoToken } }));
    expect(undo.restored).toEqual([w.ids.mirae, w.ids.unmapped]);
    expect(w.store.incidents.get(w.ids.mirae)!.status).toBe('TRIGGERED');
  });

  it('another tenant’s id in a bulk request is NOT_FOUND like a made-up id, and is not touched', async () => {
    const w = await world();
    const limited = { ...USERS.haeun, customerIds: ['cus_mirae'] };
    const r = body(await w.call(limited, 'POST', '/incidents/bulk', { body: { action: 'resolve', preview: false, items: [{ id: w.ids.hanbit, version: 1 }, { id: 'inc-nope', version: 1 }, { id: w.ids.mirae, version: 1 }] } }));
    expect(r.conflicts).toEqual([{ id: w.ids.hanbit, code: 'NOT_FOUND' }, { id: 'inc-nope', code: 'NOT_FOUND' }]);
    expect(r.done).toEqual([w.ids.mirae]);
    expect(w.store.incidents.get(w.ids.hanbit)!.status).toBe('TRIGGERED');
    const undo = body(await w.call(limited, 'POST', '/incidents/bulk/undo', { body: { undoToken: r.undoToken } }));
    expect(undo.restored).toEqual([w.ids.mirae]);
    expect(w.store.incidents.get(w.ids.mirae)).toMatchObject({ status: 'TRIGGERED', resolvedAt: null, isMergeTarget: false });
  });
});
