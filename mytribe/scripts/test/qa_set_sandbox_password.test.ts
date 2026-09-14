import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  resolveProjectId,
  TEST_ADMIN_UID,
  PRODUCTION_PROJECT_ID,
  assertProjectAllowed,
} from '../qa_set_sandbox_password';

describe('qa_set_sandbox_password: CLI args', () => {
  it('parseArgs defaults to dry-run, no --allow-production', () => {
    const a = parseArgs([]);
    expect(a.apply).toBe(false);
    expect(a.allowProduction).toBe(false);
  });

  it('parseArgs --apply --project <id> --allow-production', () => {
    const a = parseArgs(['--apply', '--project', 'p1', '--allow-production']);
    expect(a.apply).toBe(true);
    expect(a.projectId).toBe('p1');
    expect(a.allowProduction).toBe(true);
  });

  it('parseArgs rejects unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });

  // The password is deliberately NOT a CLI flag (see the file header: npm
  // echoes the full command line to stdout, flag included). A reintroduced
  // --password=<pw> flag must be rejected like any other unknown arg, not
  // silently accepted.
  it('parseArgs rejects a --password flag as unknown (it must come from QA_SANDBOX_PASSWORD instead)', () => {
    expect(() => parseArgs(['--password=hunter2'])).toThrow(/unknown arg/);
  });
});

describe('qa_set_sandbox_password: resolveProjectId', () => {
  it('falls back to the production project id by default', () => {
    const prev = process.env.GCLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    try {
      expect(resolveProjectId(parseArgs([]))).toBe(PRODUCTION_PROJECT_ID);
    } finally {
      if (prev !== undefined) process.env.GCLOUD_PROJECT = prev;
    }
  });
});

describe('qa_set_sandbox_password: production guard', () => {
  it('refuses the production project without --allow-production', () => {
    expect(() => assertProjectAllowed(PRODUCTION_PROJECT_ID, false)).toThrow(/production/i);
  });

  it('allows the production project with --allow-production', () => {
    expect(() => assertProjectAllowed(PRODUCTION_PROJECT_ID, true)).not.toThrow();
  });

  it('allows a throwaway (non-production) project id with no flag at all', () => {
    expect(() => assertProjectAllowed('qa-sandbox-emulator-test', false)).not.toThrow();
  });
});

describe('qa_set_sandbox_password: fixed sandbox identity', () => {
  it('targets the known sandbox uid', () => {
    expect(TEST_ADMIN_UID).toBe('V8Z4YsabpNfrHTTOLJw0YY3Wx5G3');
  });
});
