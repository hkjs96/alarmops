/** The ingest repository contract against MemoryStore. The SQL store runs the same suite in packages/store-sql. */
import { describe } from 'vitest';
import { MemoryStore } from '../src/index.js';
import { ingestContract } from './contract/ingestContract.js';

describe('ingest store contract: memory', () => {
  ingestContract(async (seed) => {
    const s = new MemoryStore();
    s.sources.push(...structuredClone(seed.sources));
    for (const [a, c] of seed.accounts) s.accounts.set(a, c);
    s.table = { ...seed.severity };
    s.windows = structuredClone(seed.windows);
    return {
      repo: s,
      counts: async () => ({ rawEvents: s.rawEvents.size, alerts: s.alerts.size, groups: s.groups.size, rejections: s.rejections.length }),
      rawEvent: async (id) => { const r = s.rawEvents.get(id); return r ? { decision: r.decision ?? null, decisionReason: r.decisionReason ?? null, groupId: r.groupId ?? null, alertId: r.alertId } : null; },
      sourceLastReceivedAt: async (id) => [...s.touched].reverse().find((t) => t.sourceId === id)?.at ?? null,
      close: async () => undefined,
    };
  });
});
