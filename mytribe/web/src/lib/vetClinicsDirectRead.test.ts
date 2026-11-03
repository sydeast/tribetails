import { beforeEach, describe, expect, it, vi } from 'vitest';
/**
 * #1503: the direct vet clinic read must hand screens the same DTO, and hide
 * the same rows, as `getVetClinics`. The server rules live in
 * functions/src/portal/getVetClinics.ts; each case below is one of them.
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
import { readVetClinicsDirect, vetClinicDtoFromDoc } from './vetClinicsDirectRead';
function snap(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) };
}
describe('vetClinicDtoFromDoc', () => {
  it('copies every portal field', () => {
    expect(
      vetClinicDtoFromDoc('c1', {
        name: 'Paws Clinic',
        phone: '805-555-0100',
        address: '1 Main St',
        website: 'https://paws.example',
        googleMapsUrl: 'https://maps.example/p',
        isEmergency: true,
        verified: true,
      }),
    ).toEqual({
      id: 'c1',
      name: 'Paws Clinic',
      phone: '805-555-0100',
      address: '1 Main St',
      website: 'https://paws.example',
      googleMapsUrl: 'https://maps.example/p',
      isEmergency: true,
    });
  });
  it('defaults missing or non-string fields to empty strings and isEmergency to false', () => {
    expect(vetClinicDtoFromDoc('c1', { name: 'X', phone: 5, isEmergency: 'yes' })).toEqual({
      id: 'c1',
      name: 'X',
      phone: '',
      address: '',
      website: '',
      googleMapsUrl: '',
      isEmergency: false,
    });
  });
  it('hides a pending submission (verified === false)', () => {
    expect(vetClinicDtoFromDoc('c1', { name: 'X', verified: false })).toBeNull();
  });
  it('keeps a legacy row with no verified flag', () => {
    expect(vetClinicDtoFromDoc('c1', { name: 'X' })).not.toBeNull();
  });
  it('hides an archived clinic, keeps one with archived false or absent', () => {
    expect(vetClinicDtoFromDoc('c1', { name: 'X', archived: true })).toBeNull();
    expect(vetClinicDtoFromDoc('c1', { name: 'X', archived: false })).not.toBeNull();
  });
  it('hides a nameless row', () => {
    expect(vetClinicDtoFromDoc('c1', { name: '' })).toBeNull();
    expect(vetClinicDtoFromDoc('c1', { phone: '1' })).toBeNull();
  });
});
describe('readVetClinicsDirect', () => {
  beforeEach(() => {
    fs.collection.mockClear();
    fs.getDocs.mockReset();
  });
  it('reads the vet_clinics collection and applies the callable filter', async () => {
    fs.getDocs.mockResolvedValue(
      snap([
        { id: 'a', data: { name: 'A' } },
        { id: 'b', data: { name: 'B', verified: false } },
        { id: 'c', data: { name: 'C', archived: true } },
        { id: 'd', data: { name: 'D', verified: true } },
      ]),
    );
    const result = await readVetClinicsDirect();
    expect(fs.collection).toHaveBeenCalledWith({ name: 'test-firestore' }, 'vet_clinics');
    expect(result.clinics.map((c) => c.id)).toEqual(['a', 'd']);
  });
  it('lets a Firestore failure propagate so the caller can fall back', async () => {
    fs.getDocs.mockRejectedValue(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    await expect(readVetClinicsDirect()).rejects.toThrow('denied');
  });
});
