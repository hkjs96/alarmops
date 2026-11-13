import { describe, expect, it } from 'vitest';
import { MAX_EXPORT_ROWS } from '../src/retentionApi.js';
import { USERS, T0, world } from './helpers.js';
import { body } from './helpers.js';

const csvOf = async (r: { stream?: AsyncIterable<string> }): Promise<string> => { let t = ''; for await (const c of r.stream!) t += c; return t; };
const terminate = async (w: Awaited<ReturnType<typeof world>>) => {
  w.store.customers.set('cus_mirae', { ...w.store.customers.get('cus_mirae')!, status: 'TERMINATED', statusChangedAt: w.sim.now });
};

describe('GET /customers/{id}/export.csv', () => {
  it('quotes commas and quotes, and defuses spreadsheet formulas in titles', async () => {
    const w = await world();
    w.store.incidents.get(w.ids.mirae)!.title = '=HYPERLINK("http://x","a,b")';
    await terminate(w);
    const csv = (await csvOf(await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/export.csv'))).replace(/^﻿/, '');
    const row = csv.trim().split('\r\n')[1]!;
    expect(row).toContain(`"'=HYPERLINK(""http://x"",""a,b"")"`);
  });

  it('pages through more rows than one page and refuses a history above the cap before sending anything (413)', async () => {
    const w = await world();
    await terminate(w);
    const base = w.store.incidents.get(w.ids.mirae)!;
    for (let i = 0; i < 1300; i++) w.store.incidents.set(`inc-x${i}`, { ...structuredClone(base), id: `inc-x${i}`, axis: `ax${i}`, number: 1000 + i });
    const r = await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/export.csv');
    const lines = (await csvOf(r)).trim().split('\r\n');
    expect(lines).toHaveLength(1 + 1 + 1300);
    expect(new Set(lines.slice(1).map((l) => l.split(',')[1])).size).toBe(1301);
    w.store.exportIncidents = async () => { throw new Error('must not be read'); };
    w.store.countExportIncidents = async () => MAX_EXPORT_ROWS + 1;
    const big = await w.call(USERS.minjae, 'GET', '/customers/cus_mirae/export.csv');
    expect(big.status).toBe(413);
    expect(body(big).error).toMatchObject({ code: 'EXPORT_TOO_LARGE', details: { max: MAX_EXPORT_ROWS } });
    expect(big.stream).toBeUndefined();
    void T0;
  });

  it('the configured return period moves the window', async () => {
    const w = await world();
    await terminate(w);
    const { createApi } = await import('../src/index.js');
    const api = createApi({ repo: w.store, now: () => new Date(w.sim.now.getTime() + 10 * 86_400_000), retention: { returnDays: 7, auditDays: 730, slaDays: 1826 } });
    const r = await api.handle({ method: 'GET', path: '/customers/cus_mirae/export.csv', auth: USERS.minjae, requestId: 'r' });
    expect(r.status).toBe(410);
    const ok = createApi({ repo: w.store, now: () => new Date(w.sim.now.getTime() + 10 * 86_400_000), retention: { returnDays: 14, auditDays: 730, slaDays: 1826 } });
    expect((await ok.handle({ method: 'GET', path: '/customers/cus_mirae/export.csv', auth: USERS.minjae, requestId: 'r' })).status).toBe(200);
  });
});
