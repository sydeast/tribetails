import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addDoc, collection, doc, getDoc, getDocs, limit, query, updateDoc, where } = vi.hoisted(() => ({
  addDoc: vi.fn(),
  collection: vi.fn(),
  doc: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  limit: vi.fn(),
  query: vi.fn(),
  updateDoc: vi.fn(),
  where: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  updateDoc,
  where,
}));
vi.mock('../lib/firebase', () => ({ db: {} }));

import {
  blankHouseholdRecord,
  getDossierHouseholdNotes,
  getHouseholdData,
  mergeHouseholdRecord,
  saveHouseholdSection,
} from './householdData';

beforeEach(() => {
  for (const fn of [addDoc, collection, doc, getDoc, getDocs, limit, query, updateDoc, where]) fn.mockReset();
  collection.mockReturnValue('collection-ref');
  doc.mockReturnValue('doc-ref');
  query.mockReturnValue('query-ref');
  where.mockImplementation((...args: unknown[]) => ({ where: args }));
  limit.mockImplementation((n: number) => ({ limit: n }));
});

describe('getHouseholdData', () => {
  it('queries by kinfolkId with a limit and NO orderBy', async () => {
    // The load-bearing assertion of this file. An orderBy on a field a legacy
    // household_data doc lacks would DROP the household's only record, which is
    // the exact defect class that cost invoices 18 rows and sessions 76.
    getDocs.mockResolvedValue({ docs: [] });
    await getHouseholdData('kf1');

    expect(where).toHaveBeenCalledWith('kinfolkId', '==', 'kf1');
    expect(limit).toHaveBeenCalledWith(1);
    const constraints = query.mock.calls[0]?.slice(1) ?? [];
    expect(constraints).toHaveLength(2);
    expect(JSON.stringify(constraints)).not.toMatch(/order/i);
  });

  it('returns null for a household with no record: a real answer, not a failure', async () => {
    getDocs.mockResolvedValue({ docs: [] });
    await expect(getHouseholdData('kf1')).resolves.toBeNull();
  });

  it('merges the stored doc over the blank shape', async () => {
    getDocs.mockResolvedValue({
      docs: [{ id: 'hd1', data: () => ({ kinfolkId: 'kf1', primaryVetName: 'Barton Creek' }) }],
    });
    const record = await getHouseholdData('kf1');
    expect(record?._id).toBe('hd1');
    expect(record?.primaryVetName).toBe('Barton Creek');
    // Absent in the doc, blank in the record, never undefined.
    expect(record?.evacuationPlan).toBe('');
  });

  it('propagates a read rejection so the screen can fail loud', async () => {
    getDocs.mockRejectedValue(new Error('Missing or insufficient permissions'));
    await expect(getHouseholdData('kf1')).rejects.toThrow(/permissions/);
  });

  it('refuses a blank kinfolk id rather than scanning the collection', async () => {
    await expect(getHouseholdData('  ')).rejects.toThrow(/kinfolk id/i);
    expect(getDocs).not.toHaveBeenCalled();
  });
});

describe('mergeHouseholdRecord', () => {
  it('reads a non-string field as blank instead of throwing mid-render', () => {
    const record = mergeHouseholdRecord('hd1', 'kf1', { foodLocation: 42, toysLocation: null });
    expect(record.foodLocation).toBe('');
    expect(record.toysLocation).toBe('');
  });

  it('prefers the doc-s own kinfolkId, falling back to the argument', () => {
    expect(mergeHouseholdRecord('hd1', 'kf1', { kinfolkId: 'kf9' }).kinfolkId).toBe('kf9');
    expect(mergeHouseholdRecord('hd1', 'kf1', {}).kinfolkId).toBe('kf1');
  });
});

describe('getDossierHouseholdNotes', () => {
  it('point-reads dossiers/{kinfolkId}, the doc id IS the household id', async () => {
    getDoc.mockResolvedValue({ exists: () => true, data: () => ({ householdNotes: 'Gate sticks.' }) });
    await expect(getDossierHouseholdNotes('kf1')).resolves.toBe('Gate sticks.');
    expect(doc).toHaveBeenCalledWith({}, 'dossiers', 'kf1');
  });

  it('reads a missing dossier as blank, not an error', async () => {
    getDoc.mockResolvedValue({ exists: () => false });
    await expect(getDossierHouseholdNotes('kf1')).resolves.toBe('');
  });
});

describe('saveHouseholdSection', () => {
  it('creates the full document when no record exists yet', async () => {
    addDoc.mockResolvedValue({ id: 'hd-new' });
    const saved = await saveHouseholdSection(blankHouseholdRecord('kf1'), {
      primaryVetName: 'Barton Creek',
    });

    const payload = addDoc.mock.calls[0]?.[1] as Record<string, string>;
    expect(payload['kinfolkId']).toBe('kf1');
    expect(payload['primaryVetName']).toBe('Barton Creek');
    // All 30 fields plus the three envelope fields, so android's toObject finds
    // a complete document rather than a partial one.
    expect(Object.keys(payload)).toHaveLength(35);
    // `_id` is ours, not the document's. It must never be written into the body.
    expect(payload).not.toHaveProperty('_id');
    expect(saved._id).toBe('hd-new');
  });

  it('stamps createdAt and updatedAt as parseable ISO strings on create', async () => {
    addDoc.mockResolvedValue({ id: 'hd-new' });
    await saveHouseholdSection(blankHouseholdRecord('kf1'), { foodLocation: 'Pantry' });
    const payload = addDoc.mock.calls[0]?.[1] as Record<string, string>;
    expect(Number.isNaN(Date.parse(payload['createdAt'] ?? ''))).toBe(false);
    expect(Number.isNaN(Date.parse(payload['updatedAt'] ?? ''))).toBe(false);
  });

  it('PATCHES an existing record: only the edited fields travel, never all 30', async () => {
    // The android source writes the whole object back, which is how a field
    // another surface changed between the read and the save gets reverted.
    updateDoc.mockResolvedValue(undefined);
    const existing = { ...blankHouseholdRecord('kf1'), _id: 'hd1', foodLocation: 'Pantry' };
    await saveHouseholdSection(existing, { foodLocation: 'Garage shelf' });

    const changes = updateDoc.mock.calls[0]?.[1] as Record<string, string>;
    expect(Object.keys(changes).sort()).toEqual(['foodLocation', 'updatedAt']);
    expect(changes['foodLocation']).toBe('Garage shelf');
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('returns the record as it now stands, so the caller needs no second read', async () => {
    updateDoc.mockResolvedValue(undefined);
    const existing = { ...blankHouseholdRecord('kf1'), _id: 'hd1', foodLocation: 'Pantry' };
    const saved = await saveHouseholdSection(existing, { foodLocation: 'Garage shelf' });
    expect(saved.foodLocation).toBe('Garage shelf');
    expect(saved._id).toBe('hd1');
  });

  it('propagates a write rejection instead of reporting a save that never landed', async () => {
    updateDoc.mockRejectedValue(new Error('permission-denied'));
    const existing = { ...blankHouseholdRecord('kf1'), _id: 'hd1' };
    await expect(saveHouseholdSection(existing, { foodLocation: 'x' })).rejects.toThrow('permission-denied');
  });

  it('refuses to write a record with no household attached', async () => {
    await expect(saveHouseholdSection(blankHouseholdRecord('   '), { foodLocation: 'x' })).rejects.toThrow(
      /kinfolk id/i,
    );
    expect(addDoc).not.toHaveBeenCalled();
  });
});
