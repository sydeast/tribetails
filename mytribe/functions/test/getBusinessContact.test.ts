import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

import { getBusinessContactHandler } from '../src/portal/getBusinessContact';

function req(uid: string | null = 'kin1'): CallableRequest<unknown> {
  return {
    data: {},
    auth: uid ? ({ uid } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
});

/**
 * The portal's one read of the business's public contact details. The settings
 * document is admin-only in `firestore.rules`, so this projection is what a
 * kinfolk learns and nothing else.
 */
describe('getBusinessContact', () => {
  it('rejects an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    await expect(getBusinessContactHandler(req(null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('projects the four contact fields and the privacy policy link (#1410)', async () => {
    const ctx = buildDbMock({
      docs: {
        'business_settings/business_settings': {
          businessName: 'Tribe Tails Pet Care',
          businessEmail: 'hello@tribetails.com',
          businessPhone: '555-0100',
          businessAddress: '100 Creekside Ln',
          privacyPolicyUrl: 'https://example.com/privacy',
          // Operational fields never leave the server.
          serviceRates: { Walk: '25' },
          calendarSyncId: 'cal@group.calendar.google.com',
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const dto = await getBusinessContactHandler(req());
    expect(dto).toEqual({
      name: 'Tribe Tails Pet Care',
      email: 'hello@tribetails.com',
      phone: '555-0100',
      address: '100 Creekside Ln',
      privacyPolicyUrl: 'https://example.com/privacy',
    });
  });

  it('returns a blank privacy policy link while none is set', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { businessName: 'Tribe Tails Pet Care' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const dto = await getBusinessContactHandler(req());
    expect(dto.privacyPolicyUrl).toBe('');
  });

  it('blanks a stored link that is not a plain https URL rather than handing it to a href', async () => {
    for (const stored of ['http://example.com/privacy', 'javascript:alert(1)', 'https://example.com/"x', 7]) {
      const ctx = buildDbMock({
        docs: { 'business_settings/business_settings': { businessName: 'X', privacyPolicyUrl: stored } },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const dto = await getBusinessContactHandler(req());
      expect({ stored, link: dto.privacyPolicyUrl }).toEqual({ stored, link: '' });
    }
  });

  it('falls back to the legacy singleton doc and reads the link from there too', async () => {
    const ctx = buildDbMock({
      docs: {
        // `null`, not absent: the mock seeds the canonical settings doc with the
        // household send gate when the path is missing, and this case needs it gone.
        'business_settings/business_settings': null,
        'business_settings/singleton': {
          businessName: 'Legacy Name',
          privacyPolicyUrl: 'https://example.com/legacy-privacy',
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const dto = await getBusinessContactHandler(req());
    expect(dto.name).toBe('Legacy Name');
    expect(dto.privacyPolicyUrl).toBe('https://example.com/legacy-privacy');
  });
});
