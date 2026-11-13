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
describe('kinTaleRequiredFrom: absent reads ON', () => {
  it('only an explicit false turns it off', () => {
    expect(KIN_TALE_REQUIRED_DEFAULT).toBe(true);
    expect(kinTaleRequiredFrom(undefined)).toBe(true);
    expect(kinTaleRequiredFrom({})).toBe(true);
    expect(kinTaleRequiredFrom({ kinTaleRequired: true })).toBe(true);
    expect(kinTaleRequiredFrom({ kinTaleRequired: false })).toBe(false);
  });

  it('a wrong type is not an operator switching it off', () => {
    expect(kinTaleRequiredFrom({ kinTaleRequired: 'false' })).toBe(true);
    expect(kinTaleRequiredFrom({ kinTaleRequired: 0 })).toBe(true);
    expect(kinTaleRequiredFrom({ kinTaleRequired: null })).toBe(true);
  });
});

describe('isKinTaleRequired', () => {
  it('reads the settings document', async () => {
    const off = buildDbMock({ docs: { 'business_settings/business_settings': { kinTaleRequired: false } } });
    expect(await isKinTaleRequired(off.db)).toBe(false);
    const none = buildDbMock({ docs: {} });
    expect(await isKinTaleRequired(none.db)).toBe(true);
  });

  it('a failed read falls back to the default', async () => {
    const broken = {
      doc: () => ({
        get: async () => {
          throw new Error('unavailable');
        },
      }),
    } as unknown as FirebaseFirestore.Firestore;
    expect(await isKinTaleRequired(broken)).toBe(true);
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
