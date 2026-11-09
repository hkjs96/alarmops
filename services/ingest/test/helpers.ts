import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MemoryStore, type OutgoingMessage, type QueueSender } from '../src/index.js';

export const coreFixture = <T = any>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../../packages/core/test/fixtures/${name}`, import.meta.url), 'utf8')) as T;

/** Mocked SQS: records messages; delayed messages are held until `drain()`. No AWS calls. */
export class FakeQueue implements QueueSender {
  sent: OutgoingMessage[] = [];
  failNext = false;
  async send(messages: OutgoingMessage[]) {
    if (this.failNext) { this.failNext = false; throw new Error('SQS unavailable'); }
    this.sent.push(...structuredClone(messages));
  }
  take(): OutgoingMessage[] { const m = this.sent; this.sent = []; return m; }
}

export const PROM_TOKEN = 'in_' + 'a'.repeat(40);
export const GRAF_TOKEN = 'in_' + 'b'.repeat(40);
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function store(): MemoryStore {
  const s = new MemoryStore();
  s.sources.push(
    { id: 'src_prom', customerId: 'cus_1', kind: 'PROMETHEUS', tokenHash: sha(PROM_TOKEN), enabled: true },
    { id: 'src_graf', customerId: 'cus_2', kind: 'GRAFANA', tokenHash: sha(GRAF_TOKEN), enabled: true },
  );
  s.accounts.set('123456789012', 'cus_1');
  return s;
}
