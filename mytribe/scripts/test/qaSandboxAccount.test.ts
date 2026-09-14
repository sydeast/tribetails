import { describe, it, expect } from 'vitest';
import {
  PRODUCTION_PROJECT_ID,
  PRODUCTION_PROJECT_NUMBER,
  assertProjectAllowed,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_UID,
} from '../lib/qaSandboxAccount';

describe('qaSandboxAccount: assertProjectAllowed', () => {
  it('refuses the production project id without --allow-production', () => {
    expect(() => assertProjectAllowed(PRODUCTION_PROJECT_ID, false)).toThrow(/production/i);
  });

  it('allows the production project id with --allow-production', () => {
    expect(() => assertProjectAllowed(PRODUCTION_PROJECT_ID, true)).not.toThrow();
  });

  // #878 review: --project accepts either the string id or the numeric
  // project number, and both resolve to the identical Firebase project.
  it('refuses the production project NUMBER without --allow-production', () => {
    expect(() => assertProjectAllowed(PRODUCTION_PROJECT_NUMBER, false)).toThrow(/production/i);
  });

  it('allows the production project NUMBER with --allow-production', () => {
    expect(() => assertProjectAllowed(PRODUCTION_PROJECT_NUMBER, true)).not.toThrow();
  });

  it('allows a throwaway (non-production) project id with no flag at all', () => {
    expect(() => assertProjectAllowed('qa-sandbox-emulator-test', false)).not.toThrow();
  });
});

describe('qaSandboxAccount: fixed sandbox identity', () => {
  it('names the known sandbox email and uid', () => {
    expect(TEST_ADMIN_EMAIL).toBe('test-admin+sandbox@tribetails.test');
    expect(TEST_ADMIN_UID).toBe('V8Z4YsabpNfrHTTOLJw0YY3Wx5G3');
  });
});
