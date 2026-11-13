import { describe, it, expect } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import {
  KIN_TALE_REQUIRED_DEFAULT,
  isKinTaleRequired,
  kinTaleDueAtCompletion,
  kinTaleRequiredFrom,
  kinTaleSent,
} from '../src/lib/kinTaleRequirement';

/**
 * #2123: the "KinTale required" switch and the one question it asks of a visit
 * at completion. It never decides WHETHER a visit completes.
 */
describe('kinTaleRequiredFrom: absent reads OFF (ruling 2026-11-13, "Start it off")', () => {
  it('only an explicit true turns it on', () => {
    expect(KIN_TALE_REQUIRED_DEFAULT).toBe(false);
    expect(kinTaleRequiredFrom(undefined)).toBe(false);
    expect(kinTaleRequiredFrom({})).toBe(false);
    expect(kinTaleRequiredFrom({ kinTaleRequired: true })).toBe(true);
    expect(kinTaleRequiredFrom({ kinTaleRequired: false })).toBe(false);
  });

  it('a wrong type is not an operator switching it on', () => {
    expect(kinTaleRequiredFrom({ kinTaleRequired: 'true' })).toBe(false);
    expect(kinTaleRequiredFrom({ kinTaleRequired: 1 })).toBe(false);
    expect(kinTaleRequiredFrom({ kinTaleRequired: null })).toBe(false);
  });
});

describe('isKinTaleRequired', () => {
  it('reads the settings document', async () => {
    const on = buildDbMock({ docs: { 'business_settings/business_settings': { kinTaleRequired: true } } });
    expect(await isKinTaleRequired(on.db)).toBe(true);
    const off = buildDbMock({ docs: { 'business_settings/business_settings': { kinTaleRequired: false } } });
    expect(await isKinTaleRequired(off.db)).toBe(false);
  });

  it('a business that never saved the switch has it off', async () => {
    const none = buildDbMock({ docs: {} });
    expect(await isKinTaleRequired(none.db)).toBe(false);
    const other = buildDbMock({ docs: { 'business_settings/business_settings': { businessName: 'Tribe' } } });
    expect(await isKinTaleRequired(other.db)).toBe(false);
  });

  it('a failed read falls back to the default, off', async () => {
    const broken = {
      doc: () => ({
        get: async () => {
          throw new Error('unavailable');
        },
      }),
    } as unknown as FirebaseFirestore.Firestore;
    expect(await isKinTaleRequired(broken)).toBe(false);
  });
});

describe('kinTaleSent', () => {
  it('a sent count is a sent KinTale', () => {
    expect(kinTaleSent({ sentReportCount: 1 })).toBe(true);
  });

  it('nothing sent, a zero count or junk is not', () => {
    expect(kinTaleSent({})).toBe(false);
    expect(kinTaleSent({ sentReportCount: 0 })).toBe(false);
    expect(kinTaleSent({ sentReportCount: '2' })).toBe(false);
  });

  it("a listed report is not a sent one: Android lists a draft's id when it is created", () => {
    expect(kinTaleSent({ reportIds: ['draft1'] } as never)).toBe(false);
  });
});

describe('kinTaleDueAtCompletion', () => {
  it('due when the switch is on and nothing has been sent', () => {
    expect(kinTaleDueAtCompletion({}, true)).toBe(true);
  });

  it('never due with the switch off, or once a KinTale is out', () => {
    expect(kinTaleDueAtCompletion({}, false)).toBe(false);
    expect(kinTaleDueAtCompletion({ sentReportCount: 1 }, true)).toBe(false);
  });
});
