import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1282: the direct kin read must hand screens the same DTO `getMyKin` does.
 * The server mapping lives in functions/src/portal/getMyKin.ts; the cases below
 * are its rules, one per test, so a drift between the two shows up here.
 */

const fs = vi.hoisted(() => ({
  collection: vi.fn((..._segments: unknown[]) => ({ path: 'ref' })),
  getDocs: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  collection: (...args: unknown[]) => fs.collection(...args),
  getDocs: (...args: unknown[]) => fs.getDocs(...args),
}));
vi.mock('./firebase', () => ({ firestore: { name: 'test-firestore' } }));

import { kinDtoFromDoc, readKinDirect } from './kinDirectRead';

function snap(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) };
}

describe('kinDtoFromDoc', () => {
  it('copies every portal field and nulls the missing ones', () => {
    expect(
      kinDtoFromDoc('k1', {
        name: 'Biscuit',
        species: 'Dog',
        breed: 'Beagle',
        ageYears: 4,
        photoUrl: 'https://res.cloudinary.com/x.jpg',
        status: 'active',
        feedingInstructions: 'Half a cup',
        allergies: 'Chicken',
        sex: 'Male',
        weight: '52 lbs',
        spayedNeutered: true,
      }),
    ).toEqual({
      id: 'k1',
      name: 'Biscuit',
      species: 'Dog',
      breed: 'Beagle',
      ageYears: 4,
      photoUrl: 'https://res.cloudinary.com/x.jpg',
      status: 'active',
      feedingInstructions: 'Half a cup',
      walkingInstructions: null,
      medications: null,
      allergies: 'Chicken',
      emergencyNotes: null,
      sitterNotes: null,
      sex: 'Male',
      weight: '52 lbs',
      colorMarkings: null,
      spayedNeutered: true,
      vetInfo: null,
    });
  });

  it('never forwards a field the callable does not project', () => {
    const dto = kinDtoFromDoc('k1', { name: 'Biscuit', legacyKinId: 'L-9', internalNote: 'x', kinfolkId: 'fam1', officeNotes: 'staff', reactive: true });
    expect(Object.keys(dto ?? {})).not.toContain('legacyKinId');
    expect(Object.keys(dto ?? {})).not.toContain('internalNote');
    expect(Object.keys(dto ?? {})).not.toContain('kinfolkId');
    expect(Object.keys(dto ?? {})).not.toContain('officeNotes');
    expect(Object.keys(dto ?? {})).not.toContain('reactive');
  });

  it('reads spayedNeutered as true only for a real true, like the callable', () => {
    expect(kinDtoFromDoc('k1', { spayedNeutered: 'yes' })?.spayedNeutered).toBe(false);
    expect(kinDtoFromDoc('k1', {})?.spayedNeutered).toBe(false);
  });
  it('treats an empty string as missing', () => {
    expect(kinDtoFromDoc('k1', { name: '' })?.name).toBeNull();
  });

  it('parses a numeric string age and drops a junk one', () => {
    expect(kinDtoFromDoc('k1', { ageYears: '3.5' })?.ageYears).toBe(3.5);
    expect(kinDtoFromDoc('k1', { ageYears: 'old' })?.ageYears).toBeNull();
  });

  it('keeps a memorialized kin and reads a missing or unknown status as active', () => {
    expect(kinDtoFromDoc('k1', { status: 'noLongerWithUs' })?.status).toBe('noLongerWithUs');
    expect(kinDtoFromDoc('k1', {})?.status).toBe('active');
    expect(kinDtoFromDoc('k1', { status: 'something-new' })?.status).toBe('active');
  });

  it('hides the two legacy admin statuses', () => {
    expect(kinDtoFromDoc('k1', { status: 'inactive' })).toBeNull();
    expect(kinDtoFromDoc('k1', { status: 'archived' })).toBeNull();
  });
});

describe('readKinDirect', () => {
  beforeEach(() => {
    fs.collection.mockClear();
    fs.getDocs.mockReset();
  });

  it('reads families/{kinfolkId}/kin and drops hidden kin', async () => {
    fs.getDocs.mockResolvedValue(
      snap([
        { id: 'a', data: { name: 'Ash', status: 'active' } },
        { id: 'b', data: { name: 'Bo', status: 'archived' } },
        { id: 'c', data: { name: 'Cy', status: 'noLongerWithUs' } },
      ]),
    );
    const out = await readKinDirect('fam1');
    expect(fs.collection).toHaveBeenCalledWith({ name: 'test-firestore' }, 'families', 'fam1', 'kin');
    expect(out.kin.map((k) => k.id)).toEqual(['a', 'c']);
  });

  it('lets a Firestore refusal through for the caller to handle', async () => {
    fs.getDocs.mockRejectedValue(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
    await expect(readKinDirect('fam1')).rejects.toThrow(/insufficient permissions/);
  });
});
