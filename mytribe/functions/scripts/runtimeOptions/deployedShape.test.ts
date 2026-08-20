import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  fromFirebaseCliDump,
  loadDeployedFleetShape,
  loadDeployedTimestamps,
} from './deployedShape';

/**
 * The `firebase functions:list --json` adapter (#504).
 *
 * This shape was missing because nobody had run the command. The RUNBOOK and
 * this file's own header both said the six-field picture needed an operator
 * running gcloud, and that was true of the Firebase MCP tool and false of the
 * Firebase CLI, which reports all six and runs anywhere.
 */
function writeTemp(name: string, contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'deployed-shape-'));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

/** One row, shaped exactly as the CLI emits it (fields this tool ignores trimmed). */
const CLI_ROW = {
  platform: 'gcfv2',
  id: 'getMyHome',
  region: 'us-central1',
  runtime: 'nodejs22',
  timeoutSeconds: 60,
  availableMemoryMb: 256,
  cpu: 1,
  minInstances: 1,
  maxInstances: 10,
  source: { storageSource: { generation: '1786492311548441' } },
};

describe('fromFirebaseCliDump', () => {
  it('reads all six fields, which is the whole reason this adapter exists', () => {
    expect(fromFirebaseCliDump({ result: [CLI_ROW] })).toEqual({
      getMyHome: {
        cpu: 1,
        memory: 256,
        minInstances: 1,
        maxInstances: 10,
        timeoutSeconds: 60,
        region: 'us-central1',
      },
    });
  });

  it('leaves a field the dump omits undefined rather than defaulting it', () => {
    // Diffing has to skip a field neither side reported. Manufacturing a 256
    // here would invent a mismatch out of nothing, which is the failure mode
    // PartialRuntimeShape exists to prevent.
    const shape = fromFirebaseCliDump({ result: [{ id: 'x', region: 'us-central1' }] });
    expect(shape.x).toEqual({ region: 'us-central1' });
    expect(shape.x.memory).toBeUndefined();
  });
});

describe('loadDeployedFleetShape auto-detection', () => {
  it('picks the CLI shape out of the three', () => {
    const path = writeTemp('cli.json', { status: 'success', result: [CLI_ROW] });
    expect(loadDeployedFleetShape(path).getMyHome.cpu).toBe(1);
  });

  it('still reads an MCP dump, which reports only memory and region', () => {
    const path = writeTemp('mcp.json', {
      functions: [{ function: 'getMyHome', location: 'us-central1', memory: 256 }],
    });
    expect(loadDeployedFleetShape(path).getMyHome).toEqual({ memory: 256, region: 'us-central1' });
  });

  it('still reads a gcloud dump', () => {
    const path = writeTemp('gcloud.json', [
      {
        name: 'projects/p/locations/us-central1/functions/getMyHome',
        serviceConfig: { availableMemory: '256Mi', availableCpu: '1', timeoutSeconds: 60 },
      },
    ]);
    expect(loadDeployedFleetShape(path).getMyHome).toEqual({
      memory: 256,
      cpu: 1,
      timeoutSeconds: 60,
      region: 'us-central1',
    });
  });

  it('names all three shapes when it recognises none of them', () => {
    const path = writeTemp('junk.json', { nope: true });
    expect(() => loadDeployedFleetShape(path)).toThrow(/functions:list --json/);
  });
});

describe('loadDeployedTimestamps', () => {
  it('decodes the GCS generation from microseconds to millis', () => {
    const path = writeTemp('cli.json', { result: [CLI_ROW] });
    // 1786492311548441 microseconds -> 1786492311548 ms.
    expect(loadDeployedTimestamps(path)).toEqual({ getMyHome: 1_786_492_311_548 });
  });

  it('answers empty for a shape that cannot carry a deploy time', () => {
    // Not 'never deployed'. 'This dump cannot tell you', which is a different
    // fact and must not be reported as the first one.
    const path = writeTemp('mcp.json', { functions: [{ function: 'getMyHome', memory: 256 }] });
    expect(loadDeployedTimestamps(path)).toEqual({});
  });

  it('skips a row with no generation, or an unparseable one', () => {
    const path = writeTemp('cli.json', {
      result: [
        { id: 'noSource' },
        { id: 'emptyGeneration', source: { storageSource: {} } },
        { id: 'notANumber', source: { storageSource: { generation: 'abc' } } },
        CLI_ROW,
      ],
    });
    expect(Object.keys(loadDeployedTimestamps(path))).toEqual(['getMyHome']);
  });
});
