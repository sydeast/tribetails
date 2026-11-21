import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addDoc, collection, doc, getDoc, getDocs, limit, query, setDoc, updateDoc, where } = vi.hoisted(() => ({
  addDoc: vi.fn(),
  collection: vi.fn(),
  doc: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  limit: vi.fn(),
  query: vi.fn(),
  setDoc: vi.fn(),
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
  setDoc,
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
  for (const fn of [addDoc, collection, doc, getDoc, getDocs, limit, query, setDoc, updateDoc, where]) fn.mockReset();
  collection.mockReturnValue('collection-ref');
  // A ref that says where it points, so a test can tell WHICH document a write went to.
  doc.mockImplementation((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }));
  setDoc.mockResolvedValue(undefined);
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
  /**
   * #2289: one record per household. The create used to be an `addDoc` under an
   * auto id while the portal's vet pick made `household_data/{householdId}`,
   * so a save from a screen that loaded with no record, after the household had
   * picked a vet, made a second record.
   */
  describe('the first save for a household (#2289)', () => {
    /** The document the create wrote to, and what it sent. */
    function created() {
      const call = setDoc.mock.calls[0] as [{ path: string }, Record<string, string>, { merge?: boolean }];
      return { path: call[0].path, payload: call[1], options: call[2] };
    }

    it('creates the record at the household id, never under an auto id', async () => {
      getDoc.mockResolvedValue({ exists: () => false });
      const saved = await saveHouseholdSection(blankHouseholdRecord('kf1'), { foodLocation: 'Pantry' });

      expect(addDoc).not.toHaveBeenCalled();
      expect(setDoc).toHaveBeenCalledTimes(1);
      expect(created().path).toBe('household_data/kf1');
      expect(created().options).toEqual({ merge: true });
      expect(saved._id).toBe('kf1');
    });

    it('sends only what was filled in, so a blank form cannot wipe a field another side wrote', async () => {
      getDoc.mockResolvedValue({ exists: () => false });
      await saveHouseholdSection(blankHouseholdRecord('kf1'), { foodLocation: 'Pantry', treatLocation: '' });

      const { payload } = created();
      expect(Object.keys(payload).sort()).toEqual(['createdAt', 'foodLocation', 'kinfolkId', 'updatedAt']);
      expect(payload['kinfolkId']).toBe('kf1');
      // The field the portal's vet pick writes. A blank here is what erased it.
      expect(payload).not.toHaveProperty('primaryVetClinicId');
      // `_id` is ours, not the document's. It must never be written into the body.
      expect(payload).not.toHaveProperty('_id');
    });

    it('stamps createdAt and updatedAt as parseable ISO strings on create', async () => {
      getDoc.mockResolvedValue({ exists: () => false });
      await saveHouseholdSection(blankHouseholdRecord('kf1'), { foodLocation: 'Pantry' });
      const { payload } = created();
      expect(Number.isNaN(Date.parse(payload['createdAt'] ?? ''))).toBe(false);
      expect(Number.isNaN(Date.parse(payload['updatedAt'] ?? ''))).toBe(false);
    });

    it('the household picked a vet since this screen loaded: the save joins that record and the vet stands', async () => {
      getDoc.mockResolvedValue({
        exists: () => true,
        data: () => ({ kinfolkId: 'kf1', primaryVetClinicId: 'clinic_riverside', createdAt: '2026-11-20T09:00:00.000Z' }),
      });
      const saved = await saveHouseholdSection(blankHouseholdRecord('kf1'), { foodLocation: 'Pantry' });

      const { path, payload } = created();
      expect(path).toBe('household_data/kf1');
      expect(addDoc).not.toHaveBeenCalled();
      // Nothing that could move the household's vet or the record's first date.
      expect(payload).not.toHaveProperty('primaryVetClinicId');
      expect(payload).not.toHaveProperty('createdAt');
      expect(payload['foodLocation']).toBe('Pantry');
      // And the screen is handed the vet it had not seen.
      expect(saved).toMatchObject({
        _id: 'kf1',
        kinfolkId: 'kf1',
        primaryVetClinicId: 'clinic_riverside',
        foodLocation: 'Pantry',
        createdAt: '2026-11-20T09:00:00.000Z',
      });
    });

    it('a record is there and the save adds nothing: no write, and the record is handed back', async () => {
      getDoc.mockResolvedValue({ exists: () => true, data: () => ({ kinfolkId: 'kf1', primaryVetClinicId: 'clinic_riverside' }) });
      const saved = await saveHouseholdSection(blankHouseholdRecord('kf1'), { foodLocation: '' });
      expect(setDoc).not.toHaveBeenCalled();
      expect(saved).toMatchObject({ _id: 'kf1', primaryVetClinicId: 'clinic_riverside' });
    });

    it('with no signal the record cannot be looked up: the save still goes to the household id, without a first date', async () => {
      getDoc.mockRejectedValue(new Error('Failed to get document because the client is offline.'));
      const saved = await saveHouseholdSection(blankHouseholdRecord('kf1'), { foodLocation: 'Pantry' });

      const { path, payload, options } = created();
      expect(path).toBe('household_data/kf1');
      expect(options).toEqual({ merge: true });
      expect(Object.keys(payload).sort()).toEqual(['foodLocation', 'kinfolkId', 'updatedAt']);
      expect(saved).toMatchObject({ _id: 'kf1', foodLocation: 'Pantry' });
    });

    it('the next save edits that same record', async () => {
      getDoc.mockResolvedValue({ exists: () => false });
      updateDoc.mockResolvedValue(undefined);
      const saved = await saveHouseholdSection(blankHouseholdRecord('kf1'), { foodLocation: 'Pantry' });
      await saveHouseholdSection(saved, { treatLocation: 'Jar' });

      expect(setDoc).toHaveBeenCalledTimes(1);
      expect((updateDoc.mock.calls[0]?.[0] as { path: string }).path).toBe('household_data/kf1');
      expect(Object.keys(updateDoc.mock.calls[0]?.[1] as Record<string, string>).sort()).toEqual(['treatLocation', 'updatedAt']);
    });

    it('a refused create is reported, not swallowed', async () => {
      getDoc.mockResolvedValue({ exists: () => false });
      setDoc.mockRejectedValue(new Error('permission-denied'));
      await expect(saveHouseholdSection(blankHouseholdRecord('kf1'), { foodLocation: 'Pantry' })).rejects.toThrow(
        'permission-denied',
      );
    });
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

  it('#994: leaves out a section field the operator did not change', async () => {
    // A section dialog passes every field of its section; one sent unchanged
    // would put back the value read at load time over another operator's edit.
    updateDoc.mockResolvedValue(undefined);
    const existing = { ...blankHouseholdRecord('kf1'), _id: 'hd1', foodLocation: 'Pantry', treatLocation: 'Jar' };
    await saveHouseholdSection(existing, { foodLocation: 'Garage shelf', treatLocation: 'Jar' });

    const changes = updateDoc.mock.calls[0]?.[1] as Record<string, string>;
    expect(Object.keys(changes).sort()).toEqual(['foodLocation', 'updatedAt']);
  });

  it('#994: writes nothing, not even updatedAt, when no field changed', async () => {
    const existing = { ...blankHouseholdRecord('kf1'), _id: 'hd1', foodLocation: 'Pantry' };
    const saved = await saveHouseholdSection(existing, { foodLocation: 'Pantry', treatLocation: '' });
    expect(updateDoc).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
    expect(saved).toBe(existing);
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
    expect(setDoc).not.toHaveBeenCalled();
  });
});
