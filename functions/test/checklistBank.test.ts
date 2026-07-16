import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

import {
  listChecklistBankHandler,
  saveChecklistBankItemHandler,
  mergeChecklistBank,
  slugForBankItem,
  DEFAULT_CHECKLIST_BANK,
} from '../src/admin/checklistBank';

beforeEach(() => {
  mocks.dbFn.mockReset();
});

function req(data: unknown = {}, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(persisted: Array<{ id: string; data: Record<string, unknown> }>) {
  return buildDbMock({ queryDocs: { checklist_bank: persisted } }).db;
}

describe('mergeChecklistBank (pure)', () => {
  it('returns the five defaults when nothing is persisted', () => {
    const out = mergeChecklistBank([]);
    expect(out.length).toBe(DEFAULT_CHECKLIST_BANK.length);
    expect(out.length).toBe(5);
  });

  it('adds persisted items not already in the defaults', () => {
    const out = mergeChecklistBank([{ id: 'litter-box', text: 'Litter box scooped', scope: 'PER_PET' }]);
    expect(out.map((i) => i.text)).toContain('Litter box scooped');
    expect(out.length).toBe(6);
  });

  it('dedups a persisted item against a default by normalized text', () => {
    const out = mergeChecklistBank([{ id: 'x', text: 'fresh water provided', scope: 'PER_VISIT' }]);
    expect(out.length).toBe(5);
    // persisted overrides scope of the matching default
    expect(out.find((i) => i.text.toLowerCase() === 'fresh water provided')!.scope).toBe('PER_VISIT');
  });

  it('ignores blank persisted text', () => {
    const out = mergeChecklistBank([{ id: 'blank', text: '   ', scope: 'PER_PET' }]);
    expect(out.length).toBe(5);
  });

  it('sorts case-insensitively by text', () => {
    const out = mergeChecklistBank([{ id: 'a', text: 'aaa first', scope: 'PER_PET' }]);
    expect(out[0].text).toBe('aaa first');
  });
});

describe('slugForBankItem (pure)', () => {
  it('slugifies text', () => {
    expect(slugForBankItem('Walk / potty break')).toBe('walk-potty-break');
  });
  it('falls back to "item" for symbol-only text', () => {
    expect(slugForBankItem('!!!')).toBe('item');
  });
});

describe('listChecklistBank', () => {
  it('HAPPY: empty collection returns the five defaults', async () => {
    mocks.dbFn.mockReturnValue(seed([]));
    const res = await listChecklistBankHandler(req());
    expect(res.items.length).toBe(5);
    expect(res.schemaVersion).toBe(1);
  });

  it('HAPPY: unions persisted with defaults', async () => {
    mocks.dbFn.mockReturnValue(seed([{ id: 'litter', data: { text: 'Litter box scooped', scope: 'PER_PET' } }]));
    const res = await listChecklistBankHandler(req());
    expect(res.items.map((i) => i.text)).toContain('Litter box scooped');
    expect(res.items.length).toBe(6);
  });

  it('SAD: unauthenticated is rejected', async () => {
    mocks.dbFn.mockReturnValue(seed([]));
    await expect(listChecklistBankHandler(req({}, null))).rejects.toThrow();
  });
});

describe('saveChecklistBankItem', () => {
  it('HAPPY: writes a slugged doc with text + scope', async () => {
    const mock = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(mock.db);
    const res = await saveChecklistBankItemHandler(req({ text: 'Brush coat', scope: 'PER_PET' }));
    expect(res.id).toBe('brush-coat');
    expect(res.text).toBe('Brush coat');
    const write = mock.writes.find((w) => w.path === 'checklist_bank/brush-coat');
    expect(write).toBeDefined();
    expect(write!.data.text).toBe('Brush coat');
    expect(write!.data.scope).toBe('PER_PET');
  });

  it('SAD: blank text is rejected by validation', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    await expect(saveChecklistBankItemHandler(req({ text: '   ' }))).rejects.toThrow();
  });

  it('SAD: unauthenticated is rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    await expect(saveChecklistBankItemHandler(req({ text: "x" }, null))).rejects.toThrow();
  });
});
