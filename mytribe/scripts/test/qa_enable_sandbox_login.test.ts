import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  resolveProjectId,
  generateTempPassword,
  writePasswordFile,
  TEST_TRIBE_ID,
  TEST_ADMIN_UID,
  PRODUCTION_PROJECT_ID,
  assertProjectAllowed,
} from '../qa_enable_sandbox_login';

describe('qa_enable_sandbox_login: CLI args', () => {
  it('parseArgs defaults to dry-run, no project override, no --allow-production', () => {
    const a = parseArgs([]);
    expect(a.apply).toBe(false);
    expect(a.projectId).toBeNull();
    expect(a.allowProduction).toBe(false);
  });

  it('parseArgs --apply / --project / --allow-production', () => {
    const a = parseArgs(['--apply', '--project', 'p1', '--allow-production']);
    expect(a.apply).toBe(true);
    expect(a.projectId).toBe('p1');
    expect(a.allowProduction).toBe(true);
  });

  it('parseArgs rejects unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });

  it('parseArgs rejects --project with no value', () => {
    expect(() => parseArgs(['--project'])).toThrow(/--project requires a value/);
  });
});

describe('qa_enable_sandbox_login: resolveProjectId', () => {
  it('falls back to the production project id when nothing else is set', () => {
    const prev = process.env.GCLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    try {
      expect(resolveProjectId(parseArgs([]))).toBe(PRODUCTION_PROJECT_ID);
    } finally {
      if (prev !== undefined) process.env.GCLOUD_PROJECT = prev;
    }
  });

  it('prefers --project over GCLOUD_PROJECT', () => {
    const prev = process.env.GCLOUD_PROJECT;
    process.env.GCLOUD_PROJECT = 'env-project';
    try {
      expect(resolveProjectId(parseArgs(['--project', 'flag-project']))).toBe('flag-project');
    } finally {
      if (prev === undefined) delete process.env.GCLOUD_PROJECT;
      else process.env.GCLOUD_PROJECT = prev;
    }
  });
});

describe('qa_enable_sandbox_login: production guard', () => {
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

describe('qa_enable_sandbox_login: password handling', () => {
  it('generateTempPassword returns a fresh, reasonably long value each call', () => {
    const a = generateTempPassword();
    const b = generateTempPassword();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a.startsWith('QA-')).toBe(true);
  });

  it('writePasswordFile writes the exact password to a 0600 file and returns its path', () => {
    const pw = generateTempPassword();
    const filePath = writePasswordFile(pw);
    try {
      const fs = require('fs') as typeof import('fs');
      const contents = fs.readFileSync(filePath, 'utf8');
      expect(contents.trim()).toBe(pw);
      const mode = fs.statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      require('fs').unlinkSync(filePath);
    }
  });
});

describe('qa_enable_sandbox_login: fixed sandbox identity', () => {
  it('targets the known sandbox tribe and uid', () => {
    expect(TEST_TRIBE_ID).toBe('test-kinfolk-001');
    expect(TEST_ADMIN_UID).toBe('V8Z4YsabpNfrHTTOLJw0YY3Wx5G3');
  });
});
