/** Raw error messages (SQL, row values, connection strings) are neither logged nor returned by the tick. */
import { describe, expect, it } from 'vitest';
import { errorTag, runTick } from '../src/index.js';
import { Sim, T0, closedGroup, PATTERNS } from './world.js';

const SECRET = 'duplicate key value violates "Contact_phone_key": (phone)=(+821012345678) postgres://u:pw@db';

describe('errorTag', () => {
  it('name + a short pg code, never the message', () => {
    expect(errorTag(Object.assign(new Error(SECRET), { code: '23505' }))).toBe('Error code=23505');
    expect(errorTag(Object.assign(new TypeError(SECRET), { code: `x; ${SECRET}` }))).toBe('TypeError');
    expect(errorTag(SECRET)).toBe('string');
    expect(errorTag(undefined)).toBe('undefined');
  });
});

describe('tick: thrown store errors', () => {
  it('summary errors and log lines carry the tag only', async () => {
    const sim = new Sim();
    sim.store.configs.push(PATTERNS.allAtOnce());
    closedGroup(sim.store, { customerId: 'cus_mirae', at: T0, alerts: [{ id: 'al_1' }] });
    sim.store.groupMembers = async () => { throw Object.assign(new Error(SECRET), { code: '23505' }); };
    sim.store.outboxBacklog = async () => { throw new Error(SECRET); };
    sim.store.purgeExpired = async () => { throw new Error(SECRET); };
    const logs: unknown[] = [];
    sim.store.clock = () => T0;
    const r = await runTick({ scheduledAt: T0 }, { repo: sim.store, senders: sim.senders, now: () => T0, log: (...a) => { logs.push(a); } });
    const text = JSON.stringify(r) + JSON.stringify(logs);
    expect(text).not.toContain('Contact_phone_key');
    expect(text).not.toContain('postgres://');
    expect(text).toContain('Error code=23505');
  });
});
