import { describe, expect, it } from 'vitest';
import { FakeSender, SEED_PHONE_REASON, dispatchJob, isSeedPhone, type Contact, type NotificationJob } from '../src/index.js';

const T0 = new Date('2026-11-13T03:00:00Z');
const job = (channel: 'SMS' | 'VOICE'): NotificationJob => ({
  id: 'j', idempotencyKey: `k-${channel}`, incidentId: 'inc', customerId: null, purpose: 'INITIAL', channel, targetRef: 'ct', contactId: 'ct', contactName: 'X', stepIndex: 0, repeat: 0,
  payload: { title: 't', severity: 'SEV_2', text: 'x', stepLabel: 's' }, status: 'SENDING', attempts: 1, claimSeq: 1, nextAttemptAt: T0, dueAt: T0, lastError: null, providerMessageId: null, createdAt: T0,
} as NotificationJob);
const contact = (phone: string, via: string | null = null): Contact => ({ id: 'ct', kind: 'INTERNAL', customerId: null, name: 'X', active: true, phone, phoneVerifiedAt: T0, phoneVerifiedVia: via });

describe('seed phone guard (HANDOFF)', () => {
  it('recognises seed numbers and the seed verification marker', () => {
    expect(isSeedPhone('+821000000012')).toBe(true);
    expect(isSeedPhone('+82 100000-0099')).toBe(true);
    expect(isSeedPhone('+821012345678', 'admin:seed')).toBe(true);
    expect(isSeedPhone('+821012345678', 'sms:code')).toBe(false);
    expect(isSeedPhone(null)).toBe(false);
  });

  for (const channel of ['SMS', 'VOICE'] as const) {
    it(`${channel}: a seed number is skipped and never reaches the sender`, async () => {
      const s = new FakeSender(channel);
      const byNumber = await dispatchJob(job(channel), { now: T0, senders: { [channel]: s }, incidentStatus: 'TRIGGERED', slackChannels: [], contact: contact('+821000000012') });
      const byMarker = await dispatchJob(job(channel), { now: T0, senders: { [channel]: s }, incidentStatus: 'TRIGGERED', slackChannels: [], contact: contact('+821012345678', 'admin:seed') });
      expect(byNumber).toEqual({ status: 'SKIPPED', reason: SEED_PHONE_REASON });
      expect(byMarker).toEqual({ status: 'SKIPPED', reason: SEED_PHONE_REASON });
      expect(s.attempts).toHaveLength(0);
    });
    it(`${channel}: a real number is still sent`, async () => {
      const s = new FakeSender(channel);
      const out = await dispatchJob(job(channel), { now: T0, senders: { [channel]: s }, incidentStatus: 'TRIGGERED', slackChannels: [], contact: contact('+821012345678', 'sms:code') });
      expect(out.status).toBe('SENT');
      expect(s.attempts).toHaveLength(1);
    });
  }
});
