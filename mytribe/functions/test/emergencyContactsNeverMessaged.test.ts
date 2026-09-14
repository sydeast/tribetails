import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildDbMock } from './_helpers/mockDb';
import type { CallableRequest } from 'firebase-functions/v2/https';
import type { NotificationDef } from '../src/notifications/types';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  twilioCreate: vi.fn(),
  sendTemplatedEmail: vi.fn(),
  multicast: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: () => ({ messaging: () => ({ sendEachForMulticast: mocks.multicast }) }),
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: mocks.sendTemplatedEmail }));
vi.mock('../src/lib/twilio', () => ({
  getTwilio: () => ({ messages: { create: mocks.twilioCreate } }),
  getTwilioFromNumber: () => '+15550000000',
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { broadcastMessageHandler } from '../src/admin/broadcastMessage';
import { resolveMarketingAudience } from '../src/admin/marketingAudience';
import { resolveRecipients } from '../src/notifications/recipientResolver';
import { sendSmsChannel } from '../src/notifications/senders/smsChannel';

/** Phones that belong to Emergency Contacts, in both the new and the legacy store. */
const EC_PHONE = '+18055550199';
const EC_FLAT_PHONE = '+18055550198';
const PRIMARY_PHONE = '+14155552671';

const KINFOLK_WITH_EC = {
  status: 'active',
  tags: [],
  email: 'a@x.com',
  phoneNumber: PRIMARY_PHONE,
  uid: 'u1',
  emergencyContacts: [{ name: 'Rae Mercer', phone: EC_PHONE, relationship: 'Sister', recordedAt: null, updatedAt: null }],
  emergencyContactName: 'Rae Mercer',
  emergencyContactPhone: EC_FLAT_PHONE,
};

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.twilioCreate.mockReset().mockResolvedValue({ sid: 'SM1' });
  mocks.sendTemplatedEmail.mockReset().mockResolvedValue('sg-1');
  mocks.multicast.mockReset().mockResolvedValue({ successCount: 1, responses: [{ success: true, messageId: 'fcm-1' }] });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('Emergency Contacts are never a recipient (#829)', () => {
  it('STATIC: only the Emergency Contact lib, its callable and index.ts name the fields', () => {
    const src = join(__dirname, '..', 'src');
    const allowed = new Set([
      'lib/emergencyContacts.ts',
      'portal/emergencyContacts.ts',
      'index.ts',
      // #843 gates writes to the OLDER, unrelated `families/{id}.customFields`
      // generic profile fields (a name/value bag the portal's Tribe Profile
      // screen predates this feature with); it reads no phone into any
      // recipient and never touches `kinfolk/{id}.emergencyContacts` or the
      // audience/notification code this test guards.
      'portal/saveTribeProfile.ts',
    ]);
    const offenders = walk(src)
      .map((f) => relative(src, f).split('\\').join('/'))
      .filter((rel) => !allowed.has(rel))
      .filter((rel) => /emergencyContact(s|Name|Phone|Relation)\b/.test(readFileSync(join(src, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('broadcastMessage texts the household phone and never an Emergency Contact phone', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'clients/u1': { notificationPrefs: { byKey: { 'broadcast.message': { sms: true } } } } },
      queryDocs: { kinfolk: [{ id: 'k1', data: KINFOLK_WITH_EC }], fcm_tokens: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await broadcastMessageHandler({
      data: { criteria: { kind: 'all' }, channels: ['sms'], body: 'Closed Monday' },
      auth: { uid: 'admin1', token: { admin: true } },
    } as unknown as CallableRequest<unknown>);
    const tos = mocks.twilioCreate.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(tos).toEqual([PRIMARY_PHONE]);
    expect(tos).not.toContain(EC_PHONE);
    expect(tos).not.toContain(EC_FLAT_PHONE);
  });

  it('resolveMarketingAudience resolves account uids only', async () => {
    const ctx = buildDbMock({ queryDocs: { kinfolk: [{ id: 'k1', data: KINFOLK_WITH_EC }] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const audience = await resolveMarketingAudience({ criteria: { kind: 'all' } });
    expect(audience.uids).toEqual(['u1']);
    expect(JSON.stringify(audience)).not.toContain(EC_PHONE);
    expect(JSON.stringify(audience)).not.toContain('Rae');
  });

  it('resolveRecipients returns the supplied account and nothing from the household record', async () => {
    const def = {
      key: 't.k', label: 'Test', audience: 'kinfolk', audiences: { kinfolk: true }, category: 'visit',
      allowedChannels: ['sms'], required: {}, alwaysEnabled: false, kinfolkFacing: true, deliveryMode: 'trigger',
      recipientResolver: 'kinfolkAcct', templates: { sms: 't.k' }, description: 'test',
    } as NotificationDef;
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'kinfolk/k1': KINFOLK_WITH_EC } }).db);
    const out = await resolveRecipients(def, { key: 't.k', recipientUid: 'u1', data: { kinfolkId: 'k1' } } as never);
    expect(out).toEqual([{ uid: 'u1', collection: 'clients' }]);
  });

  it('sendSmsChannel sends to the account phone even when the household carries Emergency Contacts', async () => {
    const def = {
      key: 't.k', label: 'Test', audience: 'kinfolk', audiences: { kinfolk: true }, category: 'visit',
      allowedChannels: ['sms'], required: {}, alwaysEnabled: false, kinfolkFacing: true, deliveryMode: 'trigger',
      recipientResolver: 'kinfolkAcct', templates: { sms: 't.k' }, description: 'test',
    } as NotificationDef;
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: { 'smsTemplates/t.k': { text: 'Hi' }, 'clients/u1': { phone: PRIMARY_PHONE }, 'kinfolk/k1': KINFOLK_WITH_EC },
      }).db,
    );
    await sendSmsChannel({ def, recipientUid: 'u1', data: { kinfolkId: 'k1' } });
    expect(mocks.twilioCreate).toHaveBeenCalledTimes(1);
    expect((mocks.twilioCreate.mock.calls[0][0] as { to: string }).to).toBe(PRIMARY_PHONE);
  });
});
