// Minimal dev seed: MSP org, global suppression policy, D-18/D-25 severity mapping table,
// one demo customer with a CUSTOMER paging config (STANDARD template), one Prometheus integration.
// Fake names only (known-bugs 8-12). Run: `npx prisma migrate dev` then `npm run seed -w @alarmops/db`.
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.mspOrg.upsert({ where: { id: 'msp' }, update: {}, create: { id: 'msp', name: 'Demo MSP' } });
  await prisma.suppressionPolicy.upsert({ where: { id: 'global' }, update: {}, create: { id: 'global' } });

  // D-18 single table; D-25: critical → SEV_2 (SEV_1 only when the customer says so explicitly).
  const mapping: Record<string, 'SEV_1' | 'SEV_2' | 'SEV_3' | 'SEV_4' | 'SEV_5'> = {
    critical: 'SEV_2', high: 'SEV_2', error: 'SEV_2', warning: 'SEV_3', warn: 'SEV_3',
    medium: 'SEV_3', low: 'SEV_4', info: 'SEV_5', informational: 'SEV_5', none: 'SEV_5',
  };
  for (const [matchValue, severity] of Object.entries(mapping)) {
    await prisma.severityMapping.upsert({ where: { matchValue }, update: {}, create: { matchValue, severity } });
  }

  const customer = await prisma.customer.upsert({
    where: { name: 'Acme Demo' }, update: {}, create: { name: 'Acme Demo' },
  });
  const staff = await prisma.contact.create({
    data: { kind: 'INTERNAL', name: 'Demo Engineer', email: 'oncall@example.com', emailVerifiedAt: new Date(), emailVerifiedVia: 'admin:seed' },
  });
  await prisma.responder.create({ data: { customerId: customer.id, contactId: staff.id, role: 'PAGEABLE' } });
  await prisma.pagingConfig.upsert({
    where: { scopeType_scopeId: { scopeType: 'CUSTOMER', scopeId: customer.id } },
    update: {},
    create: {
      customerId: customer.id, scopeType: 'CUSTOMER', scopeId: customer.id, style: 'ALL_AT_ONCE', plan: 'STANDARD',
      steps: { create: [
        { index: 0, atMin: 0, targetType: 'ALL_RESPONDERS', channels: ['SLACK_CHANNEL'] },
        { index: 1, atMin: 2, targetType: 'ALL_RESPONDERS', channels: ['SMS'] },
        { index: 2, atMin: 7, targetType: 'ALL_RESPONDERS', channels: ['VOICE'] },
      ] },
    },
  });

  const token = `in_${randomBytes(20).toString('hex')}`;
  await prisma.integrationSource.upsert({
    where: { customerId_name: { customerId: customer.id, name: 'prometheus-demo' } },
    update: {},
    create: {
      customerId: customer.id, kind: 'PROMETHEUS', name: 'prometheus-demo',
      tokenHash: createHash('sha256').update(token).digest('hex'), tokenPrefix: token.slice(3, 7), tokenRotatedAt: new Date(),
    },
  });
  console.log(`Seeded. Demo Prometheus ingest token (shown once): ${token}`);
}

main().finally(() => prisma.$disconnect());
