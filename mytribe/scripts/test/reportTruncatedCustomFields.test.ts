import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOME_RESERVED_KEYS,
  PROFILE_RESERVED_KEYS,
  classifyRows,
  GROWTH_MAX_BYTES,
  HARD_MAX_BYTES,
  lockoutRiskLines,
  lockoutRiskOf,
  parseArgs,
  resolveTarget,
  schemaFieldKeys,
} from '../reportTruncatedCustomFields';

describe('the #873 truncated customFields report is read-only', () => {
  it('its source contains no write call of any kind', () => {
    const src = readFileSync(join(__dirname, '..', 'reportTruncatedCustomFields.ts'), 'utf8');
    for (const call of ['.update(', '.delete(', '.create(', 'batch(', 'runTransaction', 'bulkWriter', 'recursiveDelete']) {
      expect(src.includes(call), `found ${call}`).toBe(false);
    }
    const firestoreWrites: Array<[string, RegExp]> = [
      ['doc(...).set(', /\.doc\([^)]*\)\s*\.set\(/],
      ['ref/tx/batch/writer .set(', /\b(ref|tx|transaction|batch|writer)\.set\(/],
      ['collection(...).add(', /collection\([^)]*\)\s*\.add\(/],
    ];
    for (const [name, re] of firestoreWrites) expect(re.test(src), `found ${name}`).toBe(false);
  });
});

describe('parseArgs and resolveTarget', () => {
  it('parses --project, --allow-prod and --samples', () => {
    expect(parseArgs(['--project', 'p1', '--allow-prod', '--samples', '5'])).toEqual({ projectId: 'p1', allowProd: true, samples: 5 });
    expect(parseArgs([])).toEqual({ projectId: null, allowProd: false, samples: 50 });
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });

  it('refuses --allow-prod when FIRESTORE_EMULATOR_HOST is set', () => {
    expect(() => resolveTarget({ projectId: 'p1', allowProd: true, samples: 1 }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toThrow(
      /--allow-prod.*FIRESTORE_EMULATOR_HOST/,
    );
  });

  it('refuses production without --allow-prod', () => {
    expect(() => resolveTarget({ projectId: 'p1', allowProd: false, samples: 1 }, {})).toThrow(/--allow-prod/);
  });

  it('names the target it will read', () => {
    expect(resolveTarget({ projectId: 'demo', allowProd: false, samples: 1 }, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toEqual({
      kind: 'emulator',
      host: '127.0.0.1:8080',
      projectId: 'demo',
    });
    expect(resolveTarget({ projectId: 'auntieos-ttpc', allowProd: true, samples: 1 }, {})).toEqual({ kind: 'production', projectId: 'auntieos-ttpc' });
  });
});

describe('schemaFieldKeys', () => {
  it('reads every field key across sections and ignores junk', () => {
    expect(schemaFieldKeys({ sections: [{ fields: [{ key: 'a' }, { key: '' }, {}] }, { fields: [{ key: 'b' }] }, 'x'] })).toEqual(['a', 'b']);
    expect(schemaFieldKeys(undefined)).toEqual([]);
  });
});

describe('classifyRows', () => {
  const schema = ['displayName', 'allergy', 'color'];
  const rows = (...kv: Array<[string, string]>) => kv.map(([key, value]) => ({ key, label: key, value }));

  it('flags a list that is exactly the schema rebuild, reserved keys allowed', () => {
    const v = classifyRows(rows(['allergy', ''], ['color', 'Blue'], ['vetClinicId', 'c1']), schema, PROFILE_RESERVED_KEYS, ['displayName']);
    expect(v).toMatchObject({ looksTruncated: true, emptySchemaValues: 1, keys: ['allergy', 'color', 'vetClinicId'] });
  });

  it('does not flag a list carrying any key outside the schema', () => {
    expect(classifyRows(rows(['gateNote', 'x'], ['allergy', 'a'], ['color', 'b']), schema, PROFILE_RESERVED_KEYS, ['displayName']).looksTruncated).toBe(false);
  });

  it('does not flag a list missing a schema key, since the rebuild writes every one', () => {
    expect(classifyRows(rows(['allergy', 'a']), schema, PROFILE_RESERVED_KEYS, ['displayName']).looksTruncated).toBe(false);
  });

  it('never flags when there is no schema to rebuild from', () => {
    expect(classifyRows(rows(['allergy', 'a']), [], HOME_RESERVED_KEYS, []).looksTruncated).toBe(false);
  });
});

describe('lockout risk counts (#873 review)', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `K${i}`, value: 'v' }));

  it('counts rows, blank or missing labels, and values over 1000, by key', () => {
    const v = classifyRows(
      [{ key: 'a', label: '', value: 'x' }, { key: 'b', value: 'x' }, { key: 'c', label: ' ', value: 'x' }, { key: 'd', label: 'D', value: 'y'.repeat(1001) }, { note: 'no key' }],
      [],
      PROFILE_RESERVED_KEYS,
      [],
    );
    expect(v).toMatchObject({ rowCount: 5, blankLabelKeys: ['a', 'b', 'c'], longValueKeys: ['d'] });
  });

  it('a list of exactly 40 clean rows is no risk; 41 rows, a blank label, or a long value each is', () => {
    const clean = classifyRows(many(40), [], HOME_RESERVED_KEYS, []);
    expect(lockoutRiskOf('homeAccess', 'f1', 'families/f1/homeAccess/current', clean)).toBeNull();
    expect(lockoutRiskOf('homeAccess', 'f1', 'p', classifyRows(many(41), [], HOME_RESERVED_KEYS, []))).toMatchObject({ rows: 41 });
    expect(lockoutRiskOf('families', 'f1', 'p', classifyRows([{ key: 'a', label: '', value: 'x' }], [], PROFILE_RESERVED_KEYS, []))).toMatchObject({ blankLabelKeys: ['a'] });
    expect(lockoutRiskOf('families', 'f1', 'p', classifyRows([{ key: 'a', label: 'A', value: 'z'.repeat(1001) }], [], PROFILE_RESERVED_KEYS, []))).toMatchObject({ longValueKeys: ['a'] });
  });

  it('measures a list in UTF-8 bytes of its JSON, and a list over 64 KiB is a risk on its own', () => {
    const heavy = Array.from({ length: 70 }, (_, i) => ({ key: `h${i}`, label: 'H', value: 'w'.repeat(1000) }));
    const v = classifyRows(heavy, [], HOME_RESERVED_KEYS, []);
    expect(v.bytes).toBe(Buffer.byteLength(JSON.stringify(heavy), 'utf8'));
    expect(v.bytes).toBeGreaterThan(GROWTH_MAX_BYTES);
    expect(lockoutRiskOf('homeAccess', 'f1', 'p', v)).toMatchObject({ rows: 70, bytes: v.bytes, blankLabelKeys: [], longValueKeys: [] });
    expect(classifyRows([{ key: 'e', label: 'E', value: '😀'.repeat(10) }], [], HOME_RESERVED_KEYS, []).bytes).toBe(
      Buffer.byteLength(JSON.stringify([{ key: 'e', label: 'E', value: '😀'.repeat(10) }]), 'utf8'),
    );
  });

  it('prints household and row counts per surface, the 64 KiB and 900 KiB counts, and keys, never a value', () => {
    const risks = [
      { surface: 'families' as const, kinfolkId: 'f1', path: 'families/f1', rows: 41, bytes: 2_000, blankLabelKeys: ['a', 'b'], longValueKeys: [] },
      { surface: 'families' as const, kinfolkId: 'f3', path: 'families/f3', rows: 5, bytes: HARD_MAX_BYTES + 1, blankLabelKeys: [], longValueKeys: [] },
      { surface: 'homeAccess' as const, kinfolkId: 'f2', path: 'families/f2/homeAccess/current', rows: 3, bytes: GROWTH_MAX_BYTES + 1, blankLabelKeys: [], longValueKeys: ['gate'] },
    ];
    const text = lockoutRiskLines(risks, 10).join('\n');
    expect(text).toContain(
      'families: over 40 rows 1 household(s); over 64 KiB 1 household(s); over 900 KiB 1 household(s); empty or missing label 2 row(s) in 1 household(s); value over 1000 characters 0 row(s) in 0 household(s)',
    );
    expect(text).toContain(
      'homeAccess: over 40 rows 0 household(s); over 64 KiB 1 household(s); over 900 KiB 0 household(s); empty or missing label 0 row(s) in 0 household(s); value over 1000 characters 1 row(s) in 1 household(s)',
    );
    expect(text).toContain('families/f1  rows=41  bytes=2000  empty-label keys=[a, b]');
  });
});
