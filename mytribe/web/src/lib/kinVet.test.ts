import { describe, it, expect } from 'vitest';
import { kinVetNeedsLookup, resolveKinVet, vetLine } from './kinVet';
import type { VetClinicDto } from '../api/tribeApi';

const HOME = { id: 'home', name: 'Cedar Animal Care', phone: '555 0142', address: '1 Main St', isEmergency: false };
const OWN: VetClinicDto = { id: 'own', name: 'Riverside Vets', phone: '555 0199', address: '2 River Rd', website: '', googleMapsUrl: '', isEmergency: false };

/** #1908 kin-vet: a Kin goes to the household vet unless it has one of its own. */
describe('resolveKinVet', () => {
  it('uses the vet getMyKin resolved when it is there', () => {
    const vet = { clinic: HOME, fromHousehold: true };
    expect(resolveKinVet({ ownVetClinicId: '', vet }, null, [])).toBe(vet);
    expect(resolveKinVet({ ownVetClinicId: 'own', vet: null }, HOME, [OWN])).toBeNull();
  });
  it('direct read, no vet of its own: the household vet', () => {
    expect(resolveKinVet({ ownVetClinicId: '' }, HOME, [OWN])).toEqual({ clinic: HOME, fromHousehold: true });
  });
  it('direct read, a vet of its own: that clinic from the vet list, not the household one', () => {
    expect(resolveKinVet({ ownVetClinicId: 'own' }, HOME, [OWN])).toEqual({
      clinic: { id: 'own', name: 'Riverside Vets', phone: '555 0199', address: '2 River Rd', isEmergency: false },
      fromHousehold: false,
    });
  });
  it('direct read, a vet of its own that is off the list: no vet, never the household one', () => {
    expect(resolveKinVet({ ownVetClinicId: 'gone' }, HOME, [OWN])).toBeNull();
  });
  it('no household vet and none of its own: no vet', () => {
    expect(resolveKinVet({ ownVetClinicId: '' }, null, [OWN])).toBeNull();
  });
  it('asks for the lookup only when the roster carried no resolved vet', () => {
    expect(kinVetNeedsLookup({})).toBe(true);
    expect(kinVetNeedsLookup({ vet: null })).toBe(false);
    expect(kinVetNeedsLookup(undefined)).toBe(false);
  });
  it('vetLine joins the parts it has', () => {
    expect(vetLine({ name: 'Cedar', phone: '', address: '1 Main St' }, (p) => p)).toBe('Cedar · 1 Main St');
  });
});
