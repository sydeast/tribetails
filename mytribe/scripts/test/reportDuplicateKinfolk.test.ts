import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  describeTarget,
  findDuplicateKinfolk,
  parseArgs,
  resolveTarget,
  rowOf,
  type KinfolkRow,
} from '../reportDuplicateKinfolk';

const T = Date.UTC(2026, 8, 1, 12, 0, 0);
const MIN = 60_000;
const WINDOW = 10 * MIN;

function row(id: string, atMs: number | null, over: Partial<KinfolkRow> = {}): KinfolkRow {
  return { id, atMs, atSource: 'createdAt', phoneNumber: '', email: '', createdByUid: null, ...over };
}

describe('parseArgs', () => {
  it('defaults to a ten minute window, no project, and no --allow-prod', () => {
    expect(parseArgs([])).toEqual({ projectId: null, allowProd: false, windowMs: WINDOW, samples: 50 });
  });

  it('reads every flag', () => {
    expect(parseArgs(['--project', 'p1', '--allow-prod', '--window-minutes', '30', '--samples', '5'])).toEqual({
      projectId: 'p1',
      allowProd: true,
      windowMs: 30 * MIN,
      samples: 5,
    });
  });

  it('refuses an unknown flag, a flag used as a value, and a zero window', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['--project', '--allow-prod'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--window-minutes', '0'])).toThrow(/positive whole number/);
  });
});

describe('resolveTarget', () => {
  it('refuses --allow-prod while FIRESTORE_EMULATOR_HOST is set', () => {
    expect(() => resolveTarget(parseArgs(['--allow-prod']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toThrow(
      /refusing --allow-prod.*FIRESTORE_EMULATOR_HOST/,
    );
  });

  it('refuses to read production without --allow-prod', () => {
    expect(() => resolveTarget(parseArgs(['--project', 'p1']), {})).toThrow(/pass --allow-prod/);
  });

  it('names the emulator, or production and its project', () => {
    const emu = resolveTarget(parseArgs(['--project', 'demo']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
    expect(emu).toEqual({ kind: 'emulator', host: '127.0.0.1:8080', projectId: 'demo' });
    expect(describeTarget(emu)).toBe('Target: EMULATOR 127.0.0.1:8080, project demo');

    const prod = resolveTarget(parseArgs(['--allow-prod']), { GCLOUD_PROJECT: 'tribetails-prod' });
    expect(prod).toEqual({ kind: 'production', projectId: 'tribetails-prod' });
    expect(describeTarget(prod)).toBe('Target: PRODUCTION, project tribetails-prod');
  });
});

describe('rowOf', () => {
  it('reads createdAt when the household has one, and the document create time otherwise', () => {
    const at = { toMillis: () => T };
    expect(rowOf('a', { createdAt: at, phoneNumber: '1', email: 'e@x', createdByUid: 'op-1' }, T + 5)).toEqual({
      id: 'a',
      atMs: T,
      atSource: 'createdAt',
      phoneNumber: '1',
      email: 'e@x',
      createdByUid: 'op-1',
    });
    expect(rowOf('b', {}, T + 5)).toMatchObject({ atMs: T + 5, atSource: 'createTime', createdByUid: null });
    expect(rowOf('c', {}, null)).toMatchObject({ atMs: null, atSource: 'none' });
  });
});

describe('findDuplicateKinfolk', () => {
  it('finds households with the same phone or email created within the window, closest first', () => {
    const clusters = findDuplicateKinfolk(
      [
        row('phone-a', T, { phoneNumber: '(805) 555-0134' }),
        row('phone-b', T + 4 * MIN, { phoneNumber: '805-555-0134' }),
        row('email-a', T, { email: 'Pat@example.com' }),
        row('email-b', T + 30_000, { email: 'pat@example.com ' }),
      ],
      WINDOW,
    );
    expect(clusters.map((c) => [c.match, c.households.map((h) => h.id)])).toEqual([
      ['email', ['email-a', 'email-b']],
      ['phone', ['phone-a', 'phone-b']],
    ]);
    expect(clusters[0].closestGapMs).toBe(30_000);
  });

  it('counts exactly ten minutes apart as within the window, and anything later as a separate household', () => {
    const rows = [
      row('a', T, { phoneNumber: '8055550134' }),
      row('b', T + WINDOW, { phoneNumber: '8055550134' }),
      row('c', T + 3 * WINDOW, { phoneNumber: '8055550134' }),
    ];
    expect(findDuplicateKinfolk(rows, WINDOW).map((c) => c.households.map((h) => h.id))).toEqual([['a', 'b']]);
  });

  it('joins a household matched by phone to one and by email to another into one group', () => {
    const clusters = findDuplicateKinfolk(
      [
        row('a', T, { phoneNumber: '8055550134', email: 'jamie@example.com' }),
        row('b', T + MIN, { phoneNumber: '8055550134' }),
        row('c', T + 2 * MIN, { email: 'jamie@example.com' }),
      ],
      WINDOW,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].match).toBe('phone and email');
    expect(clusters[0].households.map((h) => h.id)).toEqual(['a', 'b', 'c']);
  });

  it('never matches blanks, and skips a household with no time at all', () => {
    expect(
      findDuplicateKinfolk([row('a', T), row('b', T + MIN), row('c', null, { phoneNumber: '8055550134' }), row('d', T, { phoneNumber: '8055550134' })], WINDOW),
    ).toEqual([]);
  });
});

describe('the report is read-only', () => {
  it('contains no Firestore write call', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'reportDuplicateKinfolk.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/\.(set|update|delete|create|add|batch|runTransaction|bulkWriter|recursiveDelete)\s*\(/);
  });
});
