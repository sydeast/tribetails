// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HOUSEHOLD_SECTIONS } from '../lib/householdDataSchema';
import { blankHouseholdRecord, type HouseholdRecord } from '../api/householdData';
import { type VetClinic } from '../api/vetClinics';

/**
 * Issue #677: linking a vet from the clinic bank left the old typed
 * `primaryVet*` / `emergencyVet*` text sitting on the record, because this
 * dialog's save only ever wrote the two clinic ids. From the operator's chair
 * that reads as "cannot update vet": the picker shows the new clinic, but the
 * same record still carries a name nobody chose. A save now clears a slot's
 * legacy keys in the same write, the moment that slot links a clinic.
 */
const { saveHouseholdSection } = vi.hoisted(() => ({ saveHouseholdSection: vi.fn() }));
vi.mock('../api/householdData', async (orig) => ({
  ...(await orig<typeof import('../api/householdData')>()),
  saveHouseholdSection,
}));

import { VetSectionDialog } from './VetSectionDialog';

const SECTION = HOUSEHOLD_SECTIONS.find((s) => s.id === 'veterinary')!;

const RIVERSIDE: VetClinic = {
  _id: 'clinic_riverside',
  name: 'Riverside Animal Hospital',
  phone: '(512) 555 0100',
  address: '418 Mill St',
};
const AUSTIN_ER: VetClinic = {
  _id: 'clinic_er',
  name: 'Austin Pet ER',
  phone: '(512) 555 0300',
  address: '9 Night Ln',
  isEmergency: true,
};
const CATALOG = [RIVERSIDE, AUSTIN_ER];

function record(over: Partial<HouseholdRecord> = {}): HouseholdRecord {
  return { ...blankHouseholdRecord('kf1'), _id: 'hd1', ...over };
}

const user = userEvent.setup();

function mount(record: HouseholdRecord) {
  return render(
    <VetSectionDialog
      section={SECTION}
      kinfolkName="Nora Whitfield"
      record={record}
      clinics={{ status: 'ready', data: CATALOG }}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
}

beforeEach(() => {
  saveHouseholdSection.mockReset();
  saveHouseholdSection.mockImplementation(
    async (current: HouseholdRecord, patch: Partial<HouseholdRecord>) => ({ ...current, ...patch }),
  );
});

describe('VetSectionDialog: the patch clears a slot\'s legacy keys once that slot links a clinic', () => {
  it('clears the primary legacy keys when the primary slot is already linked, and leaves emergency untouched', async () => {
    mount(
      record({
        primaryVetClinicId: 'clinic_riverside',
        primaryVetName: 'dd',
        primaryVetPhone: '555-0000',
        primaryVetHours: 'Mon to Fri',
        primaryVetAddress: '1 Old Rd',
      }),
    );

    await user.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(saveHouseholdSection).toHaveBeenCalled());
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    expect(patch['primaryVetClinicId']).toBe('clinic_riverside');
    expect(patch['primaryVetName']).toBe('');
    expect(patch['primaryVetPhone']).toBe('');
    expect(patch['primaryVetHours']).toBe('');
    expect(patch['primaryVetAddress']).toBe('');
    // Emergency was never linked and carries nothing, so its legacy keys never travel.
    expect(patch).not.toHaveProperty('emergencyVetName');
    expect(patch).not.toHaveProperty('emergencyVetPhone');
    expect(patch).not.toHaveProperty('emergencyVetAddress');
  });

  it('clears the emergency legacy keys once the operator links an emergency clinic', async () => {
    mount(
      record({
        emergencyVetName: 'Old ER',
        emergencyVetPhone: '555-1111',
        emergencyVetAddress: '2 Old Rd',
      }),
    );

    await user.type(screen.getByLabelText('Emergency vet'), 'Pet ER');
    await user.click(await screen.findByText('Austin Pet ER'));
    await user.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(saveHouseholdSection).toHaveBeenCalled());
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    expect(patch['emergencyVetClinicId']).toBe('clinic_er');
    expect(patch['emergencyVetName']).toBe('');
    expect(patch['emergencyVetPhone']).toBe('');
    expect(patch['emergencyVetAddress']).toBe('');
    // The primary slot was never touched and carries no legacy text.
    expect(patch).not.toHaveProperty('primaryVetName');
  });

  it('clears both slots when both are linked', async () => {
    mount(
      record({
        primaryVetClinicId: 'clinic_riverside',
        primaryVetName: 'dd',
        emergencyVetClinicId: 'clinic_er',
        emergencyVetName: 'Old ER',
      }),
    );

    await user.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(saveHouseholdSection).toHaveBeenCalled());
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    expect(patch['primaryVetName']).toBe('');
    expect(patch['emergencyVetName']).toBe('');
  });

  it('writes only the two clinic ids when neither slot is linked and there is no legacy text on file', async () => {
    mount(record());

    await user.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(saveHouseholdSection).toHaveBeenCalled());
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    expect(Object.keys(patch).sort()).toEqual(['emergencyVetClinicId', 'primaryVetClinicId']);
  });

  it('never types the seven legacy fields back in when a save is rejected: the dialog just reports the error', async () => {
    saveHouseholdSection.mockRejectedValue(new Error('permission-denied'));
    const dialog = mount(record({ primaryVetClinicId: 'clinic_riverside', primaryVetName: 'dd' }));

    await user.click(screen.getByRole('button', { name: /^Save/ }));

    expect(await within(dialog.container).findByText(/permission-denied/)).toBeInTheDocument();
  });
});
