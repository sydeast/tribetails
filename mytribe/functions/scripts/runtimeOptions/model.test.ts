import { describe, expect, it } from 'vitest';

import {
  applyFragments,
  diffShape,
  parseCpu,
  parseMemoryToMiB,
  resolveFleetDefault,
  resolveFunctionShape,
} from './model';
import { OptionsFragment, RuntimeShape } from './types';

/** Mirrors `lib/runtimeOptions.ts` as of #395/ADR-0004 decision 2-3. */
const NAMED_CONSTANTS: Record<string, Partial<RuntimeShape>> = {
  FULL_CPU: { cpu: 1, maxInstances: 10 },
  FULL_CPU_SERIAL: { cpu: 1, maxInstances: 2 },
  SERIAL: { cpu: 0.25, maxInstances: 2 },
};

/** Mirrors `index.ts`'s `setGlobalOptions({ cpu: 1, memory: '256MiB', maxInstances: 20 })`. */
const FLEET_DEFAULT: RuntimeShape = resolveFleetDefault([
  { kind: 'prop', key: 'cpu', value: 1 },
  { kind: 'prop', key: 'memory', value: '256MiB' },
  { kind: 'prop', key: 'maxInstances', value: 20 },
]);

describe('resolveFleetDefault', () => {
  it('merges setGlobalOptions over the SDK defaults for the fields it leaves unset', () => {
    expect(FLEET_DEFAULT).toEqual<RuntimeShape>({
      cpu: 1,
      memory: 256,
      minInstances: 0,
      maxInstances: 20,
      timeoutSeconds: 60,
      region: 'us-central1',
    });
  });
});

describe('resolveFunctionShape: inheritance', () => {
  it('a function with no options object inherits the fleet default verbatim', () => {
    // e.g. `export const getBreeds = onCall(getBreedsHandler)` — one arg, no options.
    const shape = resolveFunctionShape(FLEET_DEFAULT, [], NAMED_CONSTANTS);
    expect(shape).toEqual(FLEET_DEFAULT);
  });

  it('a function that overrides one field still inherits the rest', () => {
    // e.g. a hypothetical `{ timeoutSeconds: 120 }` with no spread.
    const fragments: OptionsFragment[] = [{ kind: 'prop', key: 'timeoutSeconds', value: 120 }];
    const shape = resolveFunctionShape(FLEET_DEFAULT, fragments, NAMED_CONSTANTS);
    expect(shape).toEqual<RuntimeShape>({ ...FLEET_DEFAULT, timeoutSeconds: 120 });
  });
});

describe('resolveFunctionShape: pinned by each named constant', () => {
  it('FULL_CPU: cpu 1, maxInstances 10, everything else inherited', () => {
    // e.g. `getMyHome.ts`: { region: 'us-central1', minInstances: 1, ...FULL_CPU }
    const fragments: OptionsFragment[] = [
      { kind: 'prop', key: 'region', value: 'us-central1' },
      { kind: 'prop', key: 'minInstances', value: 1 },
      { kind: 'spread', constant: 'FULL_CPU' },
    ];
    const shape = resolveFunctionShape(FLEET_DEFAULT, fragments, NAMED_CONSTANTS);
    expect(shape).toEqual<RuntimeShape>({
      cpu: 1,
      memory: 256,
      minInstances: 1,
      maxInstances: 10,
      timeoutSeconds: 60,
      region: 'us-central1',
    });
  });

  it('FULL_CPU_SERIAL: cpu 1, maxInstances 2', () => {
    // e.g. a one-shot operator bulk action.
    const fragments: OptionsFragment[] = [{ kind: 'spread', constant: 'FULL_CPU_SERIAL' }];
    const shape = resolveFunctionShape(FLEET_DEFAULT, fragments, NAMED_CONSTANTS);
    expect(shape).toEqual<RuntimeShape>({ ...FLEET_DEFAULT, cpu: 1, maxInstances: 2 });
  });

  it('SERIAL: cpu 0.25, maxInstances 2 — the one constant that pins BELOW the fleet default', () => {
    // e.g. `cleanupExpiredShareLinks`, one of the four nightly sweep crons.
    const fragments: OptionsFragment[] = [{ kind: 'spread', constant: 'SERIAL' }];
    const shape = resolveFunctionShape(FLEET_DEFAULT, fragments, NAMED_CONSTANTS);
    expect(shape).toEqual<RuntimeShape>({ ...FLEET_DEFAULT, cpu: 0.25, maxInstances: 2 });
  });
});

describe('resolveFunctionShape: source-order merge semantics', () => {
  it('a literal prop BEFORE a spread survives when the constant does not touch that key', () => {
    // The exact shape in src/auth/loginSecurity.ts:328:
    //   { region: 'us-central1', secrets: [...], minInstances: 1, ...FULL_CPU }
    // FULL_CPU is { cpu: 1, maxInstances: 10 } and never mentions minInstances,
    // so the literal `minInstances: 1` that comes textually BEFORE the spread
    // must still win over "nothing" rather than being clobbered by the spread.
    const fragments: OptionsFragment[] = [
      { kind: 'prop', key: 'region', value: 'us-central1' },
      { kind: 'prop', key: 'minInstances', value: 1 },
      { kind: 'spread', constant: 'FULL_CPU' },
    ];
    const shape = resolveFunctionShape(FLEET_DEFAULT, fragments, NAMED_CONSTANTS);
    expect(shape.minInstances).toBe(1);
    expect(shape.cpu).toBe(1);
    expect(shape.maxInstances).toBe(10);
  });

  it('a prop AFTER a spread overrides the field the constant set', () => {
    const fragments: OptionsFragment[] = [
      { kind: 'spread', constant: 'FULL_CPU' }, // maxInstances 10
      { kind: 'prop', key: 'maxInstances', value: 3 }, // overrides it
    ];
    const shape = resolveFunctionShape(FLEET_DEFAULT, fragments, NAMED_CONSTANTS);
    expect(shape.maxInstances).toBe(3);
    expect(shape.cpu).toBe(1); // still picked up from the spread
  });

  it('throws on a spread of an unrecognized constant, rather than silently ignoring it', () => {
    const fragments: OptionsFragment[] = [{ kind: 'spread', constant: 'NOT_A_REAL_CONSTANT' }];
    expect(() => resolveFunctionShape(FLEET_DEFAULT, fragments, NAMED_CONSTANTS)).toThrow(
      /Unknown named constant/,
    );
  });
});

describe('applyFragments', () => {
  it('is the merge primitive both resolveFleetDefault and resolveFunctionShape share', () => {
    const result = applyFragments({ cpu: 1 }, [{ kind: 'prop', key: 'cpu', value: 0.5 }], {});
    expect(result.cpu).toBe(0.5);
  });
});

describe('parseMemoryToMiB', () => {
  it('treats a bare number as already-MiB (the Firebase MCP dump shape)', () => {
    expect(parseMemoryToMiB(256)).toBe(256);
  });

  it('parses source-style "256MiB" and "512MiB"', () => {
    expect(parseMemoryToMiB('256MiB')).toBe(256);
    expect(parseMemoryToMiB('512MiB')).toBe(512);
  });

  it('parses gcloud-style binary shorthand "Mi"/"Gi"', () => {
    expect(parseMemoryToMiB('256Mi')).toBe(256);
    expect(parseMemoryToMiB('1Gi')).toBe(1024);
  });

  it('parses decimal "MB"/"GB" and converts to binary MiB', () => {
    expect(parseMemoryToMiB('256MB')).toBeCloseTo(244.14, 1);
    expect(parseMemoryToMiB('1GB')).toBeCloseTo(953.67, 1);
  });

  it('throws on garbage input rather than returning NaN silently', () => {
    expect(() => parseMemoryToMiB('lots')).toThrow(/Cannot parse memory value/);
    expect(() => parseMemoryToMiB('256XiB')).toThrow(/Unknown memory unit/);
  });
});

describe('parseCpu', () => {
  it('parses numbers and numeric strings the same way', () => {
    expect(parseCpu(1)).toBe(1);
    expect(parseCpu('1')).toBe(1);
    expect(parseCpu('0.25')).toBe(0.25);
  });

  it('throws on non-numeric input', () => {
    expect(() => parseCpu('lots')).toThrow(/Cannot parse cpu value/);
  });
});

describe('diffShape', () => {
  const expected: RuntimeShape = {
    cpu: 1,
    memory: 256,
    minInstances: 1,
    maxInstances: 10,
    timeoutSeconds: 60,
    region: 'us-central1',
  };

  it('reports no mismatches when the deployed shape agrees on every field it reports', () => {
    expect(diffShape(expected, { cpu: 1, memory: 256, region: 'us-central1' })).toEqual([]);
  });

  it('skips a field the deployed dump did not report, rather than flagging "undefined"', () => {
    // The Firebase MCP tool never reports cpu/minInstances/maxInstances/timeoutSeconds.
    const mismatches = diffShape(expected, { memory: 512 });
    expect(mismatches).toEqual([{ field: 'memory', expected: 256, deployed: 512 }]);
  });

  it('catches a disagreement on every one of the six fields at once', () => {
    // This is the "53 functions" case: a deployed shape reported in full that
    // disagrees with source on cpu, memory, minInstances, maxInstances,
    // timeoutSeconds and region simultaneously.
    const deployed = {
      cpu: 0.25,
      memory: 512,
      minInstances: 0,
      maxInstances: 20,
      timeoutSeconds: 540,
      region: 'us-east1',
    };
    const mismatches = diffShape(expected, deployed);
    expect(mismatches).toHaveLength(6);
    expect(mismatches.map((m) => m.field).sort()).toEqual(
      ['cpu', 'maxInstances', 'memory', 'minInstances', 'region', 'timeoutSeconds'].sort(),
    );
    expect(mismatches).toContainEqual({ field: 'cpu', expected: 1, deployed: 0.25 });
    expect(mismatches).toContainEqual({ field: 'memory', expected: 256, deployed: 512 });
    expect(mismatches).toContainEqual({ field: 'minInstances', expected: 1, deployed: 0 });
    expect(mismatches).toContainEqual({ field: 'maxInstances', expected: 10, deployed: 20 });
    expect(mismatches).toContainEqual({ field: 'timeoutSeconds', expected: 60, deployed: 540 });
    expect(mismatches).toContainEqual({
      field: 'region',
      expected: 'us-central1',
      deployed: 'us-east1',
    });
  });

  it('treats differently-spelled equal memory values as equal, not a mismatch', () => {
    expect(diffShape(expected, { memory: parseMemoryToMiB('256MiB') })).toEqual([]);
  });
});
