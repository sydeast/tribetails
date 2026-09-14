import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOME_RESERVED_KEYS,
  PROFILE_RESERVED_KEYS,
  classifyRows,
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
