// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { blankHouseholdRecord, type HouseholdRecord } from '../api/householdData';

/**
 * The screen raises a toast on a landed save, and `useToast` throws outside its
 * provider on purpose (a swallowed confirmation is indistinguishable from a save
 * that never happened). Rendering the real provider keeps these tests exercising
 * the tree the app actually mounts. Mirrors KinTaleCompose.test.tsx.
 */
function render(ui: React.ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

const { getHouseholdData, getDossierHouseholdNotes, saveHouseholdSection } = vi.hoisted(() => ({
  getHouseholdData: vi.fn(),
  getDossierHouseholdNotes: vi.fn(),
  saveHouseholdSection: vi.fn(),
}));
vi.mock('../api/householdData', async (orig) => ({
  ...(await orig<typeof import('../api/householdData')>()),
  getHouseholdData,
  getDossierHouseholdNotes,
  saveHouseholdSection,
}));
/**
 * The veterinary section is READ THROUGH from the household profile (punchlist
 * A2), so this screen now opens two more reads: the kinfolk record that owns the
 * vet, and the clinic catalog that owns its opening hours.
 */
const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', async (orig) => ({
  ...(await orig<typeof import('../lib/firestore')>()),
  useCollection,
}));

import { HouseholdData } from './HouseholdData';

function record(over: Partial<HouseholdRecord> = {}): HouseholdRecord {
  return {
    ...blankHouseholdRecord('kf1'),
    _id: 'hd1',
    primaryVetName: 'Barton Creek Animal Hospital',
    primaryVetPhone: '(512) 555 0134',
    foodLocation: 'Pantry, second shelf',
    groomerName: 'Paws and Claws Grooming',
    securitySystemInfo: 'Panel by the garage, code 4417',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...over,
  };
}

const user = userEvent.setup();

beforeEach(() => {
  getHouseholdData.mockReset();
  getDossierHouseholdNotes.mockReset();
  saveHouseholdSection.mockReset();
  getHouseholdData.mockResolvedValue(record());
  getDossierHouseholdNotes.mockResolvedValue('');
  useCollection.mockReset();
  useCollection.mockReturnValue({ status: 'ready', data: [CLINIC] });
});
/** The catalog row the household's regular vet is linked to. Owns the hours. */
const CLINIC = {
  _id: 'clinic_riverside',
  name: 'Riverside Animal Hospital',
  phone: '(512) 555 0100',
  address: '418 Mill St',
  hours: 'Mon to Fri 8a to 6p',
};

function mount(over: Partial<{ kinfolkName: string }> = {}) {
  return render(
    <HouseholdData kinfolkId="kf1" kinfolkName={over.kinfolkName ?? 'Nora Whitfield'} onBack={() => {}} />,
  );
}

/**
 * #689. This record is a sub-view of the household PROFILE, held in that
 * screen's state, so closing it never leaves `/directory/{id}`. The button used
 * to say "Back to household", which named no screen the operator could find.
 */
describe('HouseholdData: Back', () => {
  it('names the household it closes back down to', async () => {
    const onBack = vi.fn();
    render(<HouseholdData kinfolkId="kf1" kinfolkName="Nora Whitfield" onBack={onBack} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Back to Nora Whitfield' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('falls back to the id when the profile passed no name down', async () => {
    render(<HouseholdData kinfolkId="kf1" kinfolkName="" onBack={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Back to kf1' })).toBeInTheDocument();
  });
});

describe('HouseholdData: reading the record', () => {
  it('renders every remaining section with the values that were read', async () => {
    mount();
    expect(await screen.findByText('Pantry, second shelf')).toBeInTheDocument();

    for (const title of ['Veterinary', 'Items and locations', 'Routines and preferences']) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it('no longer renders Emergency and safety or Service providers, dropped 2026-08-04', async () => {
    // Operator: "I dont need this Emergency & Safety or Service Provider
    // boxes." The fixture still carries `groomerName`, on purpose: the data
    // is not deleted, only unrendered (lib/householdDataSchema.ts). See the
    // next test for that half of the claim.
    mount();
    await screen.findByText('Pantry, second shelf');
    expect(screen.queryByText('Emergency and safety')).not.toBeInTheDocument();
    expect(screen.queryByText('Service providers')).not.toBeInTheDocument();
    expect(screen.queryByText('Paws and Claws Grooming')).not.toBeInTheDocument();
  });

  it('names the household in the heading', async () => {
    mount();
    // The heading's `detail` line, which is where the name lives since #752:
    // the sentence that used to carry it is a tooltip now, and a screen that
    // never says whose record you are reading is the defect this guards. The
    // class is part of the assertion because since #689 the Back button names
    // the household too, and a bare /Nora Whitfield/ matches both.
    const named = await screen.findByText('Nora Whitfield');
    expect(named).toBeVisible();
    expect(named).toHaveClass('den-heading-detail');
  });

  it('shows a blank field as "Not set" rather than hiding it, because the gaps are the point', async () => {
    mount();
    await screen.findByText('Pantry, second shelf');
    expect(screen.getByText('Household rules')).toBeInTheDocument();
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
  });

  it('counts what is on file per section, and never claims more', async () => {
    mount();
    // Items and locations: 1 of 7 filled by the fixture.
    expect(await screen.findByText(/1 of 7 on file/)).toBeInTheDocument();
  });

  it('shows the dossier reference only when there is prose to migrate', async () => {
    getDossierHouseholdNotes.mockResolvedValue('Gate sticks in the rain. Alarm is off during the day.');
    mount();
    expect(await screen.findByText(/Gate sticks in the rain/)).toBeInTheDocument();
  });

  it('renders a loading state before the read lands, and no values', () => {
    getHouseholdData.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByText(/Reading the household record/)).toBeInTheDocument();
    expect(screen.queryByText('Pantry, second shelf')).not.toBeInTheDocument();
  });
});

describe('HouseholdData: empty and error are not the same thing', () => {
  it('says nothing is on file yet when the household genuinely has no record', async () => {
    getHouseholdData.mockResolvedValue(null);
    mount();
    expect(await screen.findByText(/Nothing on file yet/)).toBeInTheDocument();
    // Still editable: the first save starts the record from any section.
    expect(screen.getByRole('button', { name: 'Edit items and locations' })).toBeInTheDocument();
  });

  it('fails loud on a read rejection, and NEVER renders the empty state over it', async () => {
    getHouseholdData.mockRejectedValue(new Error('Missing or insufficient permissions'));
    mount();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Couldn.t load household data/)).toBeInTheDocument();
    expect(within(alert).getByText(/Missing or insufficient permissions/)).toBeInTheDocument();
    // The false-empty this codebase is built to avoid.
    expect(screen.queryByText(/Nothing on file yet/)).not.toBeInTheDocument();
    expect(screen.queryByText('Not set')).not.toBeInTheDocument();
  });

  it('offers a retry on a failed read rather than stranding the screen', async () => {
    getHouseholdData.mockRejectedValue(new Error('network'));
    mount();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('HouseholdData: secrets stay hidden until asked for', () => {
  it('does not put the alarm code in the DOM before it is revealed', async () => {
    mount();
    await screen.findByText('Pantry, second shelf');

    expect(screen.queryByText(/code 4417/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show security system' })).toBeInTheDocument();
  });

  it('reveals it on request, and can hide it again', async () => {
    mount();
    await screen.findByText('Pantry, second shelf');

    await user.click(screen.getByRole('button', { name: 'Show security system' }));
    expect(screen.getByText(/code 4417/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide security system' }));
    expect(screen.queryByText(/code 4417/)).not.toBeInTheDocument();
  });

  it('no longer shows or masks important documents, since Emergency and safety has no panel here', async () => {
    // Before 2026-08-04 this was masked, not hidden: a "Show important
    // documents" reveal button. The whole section is gone now, so there is no
    // reveal button and no value in the DOM either, even though the fixture
    // still carries real data for the field (it is not deleted, see
    // lib/householdDataSchema.ts).
    getHouseholdData.mockResolvedValue(record({ importantDocumentsLocation: 'Fire safe under the stairs' }));
    mount();
    await screen.findByText('Pantry, second shelf');

    expect(screen.queryByText(/Fire safe under the stairs/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show important documents' })).not.toBeInTheDocument();
  });
});

describe('HouseholdData: editing a section', () => {
  // Was "openProviders", editing the (now removed) Service providers section.
  // Items and locations is the nearest surviving generic-text section: same
  // dialog, same save-only-this-section contract, no vet-picker involved.
  async function openItems() {
    mount();
    await screen.findByText('Pantry, second shelf');
    await user.click(screen.getByRole('button', { name: 'Edit items and locations' }));
    return screen.getByRole('dialog');
  }

  it('opens a modal that names the section and the household', async () => {
    const dialog = await openItems();
    expect(within(dialog).getByText('Items and locations · Nora Whitfield')).toBeInTheDocument();
  });

  it('seeds the form from the record rather than opening blank', async () => {
    const dialog = await openItems();
    expect(within(dialog).getByLabelText('Food')).toHaveValue('Pantry, second shelf');
  });

  // Phone-format rejection ('rejects a phone that cannot be dialed') no
  // longer has a screen-level home: every remaining generic-editable section
  // (Items and locations, Routines and preferences) is phone-free now that
  // Service providers (groomerPhone, trainerPhone) is gone, and the
  // veterinary phone fields are read-through, not typed, via the vet picker.
  // The rule itself (`isDialablePhone` / `validateHouseholdData`) is still
  // exercised directly in householdDataSchema.test.ts.

  it('rejects an em dash in Auntie voice, inline', async () => {
    const dialog = await openItems();

    const food = within(dialog).getByLabelText('Food');
    await user.clear(food);
    await user.type(food, 'Pantry—second shelf');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    expect(await within(dialog).findByText(/does not use dashes/i)).toBeInTheDocument();
    expect(saveHouseholdSection).not.toHaveBeenCalled();
  });

  it('saves only the edited section, updates the view, and raises a toast', async () => {
    const dialog = await openItems();
    saveHouseholdSection.mockImplementation(
      async (current: HouseholdRecord, patch: Partial<HouseholdRecord>) => ({ ...current, ...patch }),
    );

    const food = within(dialog).getByLabelText('Food');
    await user.clear(food);
    await user.type(food, 'Top pantry shelf');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Only this section's seven keys travelled, never every field on the record.
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    expect(patch['foodLocation']).toBe('Top pantry shelf');
    expect(patch).not.toHaveProperty('householdRules');
    // And never the retired vet keys, which nothing writes any more.
    expect(patch).not.toHaveProperty('primaryVetName');

    expect(await screen.findByText('Top pantry shelf')).toBeInTheDocument();
    expect(await screen.findByText(/Saved items and locations for Nora Whitfield/)).toBeInTheDocument();
  });

  it('surfaces a rejected save in a persistent banner and keeps the operator-s edits', async () => {
    const dialog = await openItems();
    saveHouseholdSection.mockRejectedValue(new Error('permission-denied'));

    const food = within(dialog).getByLabelText('Food');
    await user.clear(food);
    await user.type(food, 'Top pantry shelf');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    expect(await within(dialog).findByText(/permission-denied/)).toBeInTheDocument();
    // Still open, still holding what was typed. A failed save is not a lost edit.
    expect(within(dialog).getByLabelText('Food')).toHaveValue('Top pantry shelf');
    expect(screen.queryByText(/Saved items and locations/)).not.toBeInTheDocument();
  });

  it('starts the record from the empty state, so a first save is not a special case', async () => {
    getHouseholdData.mockResolvedValue(null);
    saveHouseholdSection.mockImplementation(
      async (current: HouseholdRecord, patch: Partial<HouseholdRecord>) => ({
        ...current,
        ...patch,
        _id: 'hd-new',
      }),
    );
    mount();
    await screen.findByText(/Nothing on file yet/);

    await user.click(screen.getByRole('button', { name: 'Edit items and locations' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Food'), 'Pantry, second shelf');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The banner claimed nothing was on file. Something is now, so it must go.
    await waitFor(() => expect(screen.queryByText(/Nothing on file yet/)).not.toBeInTheDocument());
    expect(screen.getByText('Pantry, second shelf')).toBeInTheDocument();
  });

  it('hides a typed secret behind a reveal in the editor too', async () => {
    mount();
    await screen.findByText('Pantry, second shelf');
    await user.click(screen.getByRole('button', { name: 'Edit routines and preferences' }));
    const dialog = screen.getByRole('dialog');

    const input = within(dialog).getByLabelText('Security system');
    expect(input).toHaveAttribute('type', 'password');

    await user.click(within(dialog).getByRole('button', { name: 'Show security system' }));
    expect(within(dialog).getByLabelText('Security system')).toHaveAttribute('type', 'text');
  });
});
/**
 * Punchlist A2. This screen used to author its own `primaryVet*` /
 * `emergencyVet*` free text, so the vet existed twice with nothing tying the
 * copies together, and the copy shown HERE, on the screen someone reads the
 * emergency number off under pressure, was the one that could silently go stale.
 * It now reads the catalog-linked record on the kinfolk doc.
 */
/**
 * Operator ruling 2026-08-01: `household_data` OWNS the vet, catalog-linked.
 * What is stored is a `vet_clinics` id, so name/phone/address/hours resolve
 * through the clinic and there is exactly one copy to correct.
 */
describe('HouseholdData: the vet is owned here, and catalog-linked', () => {
  it('resolves the vet through the clinic the record points at', async () => {
    getHouseholdData.mockResolvedValue(record({ primaryVetClinicId: 'clinic_riverside' }));
    mount();
    expect(await screen.findByText('Riverside Animal Hospital')).toBeInTheDocument();
    expect(screen.getByText('(512) 555 0100')).toBeInTheDocument();
  });
  it('reads HOURS from the clinic, not from the household', async () => {
    getHouseholdData.mockResolvedValue(
      record({ primaryVetClinicId: 'clinic_riverside', primaryVetHours: 'STALE' }),
    );
    mount();
    expect(await screen.findByText('Mon to Fri 8a to 6p')).toBeInTheDocument();
  });
  it('shows a correction to the clinic with no household write at all', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [{ ...CLINIC, phone: '(512) 555 0199' }],
    });
    getHouseholdData.mockResolvedValue(record({ primaryVetClinicId: 'clinic_riverside' }));
    mount();
    expect(await screen.findByText('(512) 555 0199')).toBeInTheDocument();
  });
  it('keeps the emergency vet a DISTINCT clinic from the primary', async () => {
    getHouseholdData.mockResolvedValue(
      record({ primaryVetClinicId: 'clinic_riverside', emergencyVetClinicId: 'clinic_er' }),
    );
    useCollection.mockReturnValue({
      status: 'ready',
      data: [CLINIC, { _id: 'clinic_er', name: 'Austin Pet ER', phone: '(512) 555 0300' }],
    });
    mount();
    expect(await screen.findByText('Riverside Animal Hospital')).toBeInTheDocument();
    expect(screen.getByText('Austin Pet ER')).toBeInTheDocument();
  });
  it('is edited HERE, since this record owns the vet', async () => {
    mount();
    await screen.findByText('Pantry, second shelf');
    expect(screen.getByRole('button', { name: 'Edit veterinary' })).toBeInTheDocument();
  });
  it('says so when the record is not linked to the catalog', async () => {
    // Without a clinic id there is nothing for a correction to match on, and
    // that is worth stating rather than leaving as an invisible difference.
    getHouseholdData.mockResolvedValue(
      record({ primaryVetClinicId: '', primaryVetName: 'Some Clinic', primaryVetPhone: '555' }),
    );
    mount();
    expect(await screen.findByText(/not linked to the catalog/i)).toBeInTheDocument();
  });
  it('does not cry unlinked when the vet IS linked', async () => {
    getHouseholdData.mockResolvedValue(record({ primaryVetClinicId: 'clinic_riverside' }));
    mount();
    await screen.findByText('Riverside Animal Hospital');
    expect(screen.queryByText(/not linked to the catalog/i)).not.toBeInTheDocument();
  });
  it('fails loud on a dangling clinic id rather than showing stale text', async () => {
    getHouseholdData.mockResolvedValue(
      record({ primaryVetClinicId: 'gone', primaryVetName: 'Stale Clinic' }),
    );
    mount();
    expect(await screen.findByText(/no longer exists/i)).toBeInTheDocument();
  });
  it('flags superseded free text once the record is LINKED', async () => {
    // Linked, so the clinic supplies the vet and the old strings are genuinely
    // unused. They are shown rather than dropped: deleting them silently would
    // destroy the evidence of a conflict.
    getHouseholdData.mockResolvedValue(
      record({ primaryVetClinicId: 'clinic_riverside', primaryVetName: 'Barton Creek Animal Hospital' }),
    );
    mount();
    expect(await screen.findByText(/Older vet notes are still on this record/)).toBeInTheDocument();
    expect(screen.getByText('Barton Creek Animal Hospital')).toBeInTheDocument();
  });
  it('does NOT call the free text superseded while it is still the vet on show', async () => {
    // Unlinked: that text IS the vet rendered above, so calling it "not used
    // anywhere" would be duplicative and untrue.
    getHouseholdData.mockResolvedValue(record({ primaryVetName: 'Barton Creek Animal Hospital' }));
    mount();
    await screen.findByText('Barton Creek Animal Hospital');
    expect(screen.queryByText(/Older vet notes/)).not.toBeInTheDocument();
  });
  it('fails loud when the clinic catalog cannot be read', async () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    mount();
    expect(await screen.findByText(/catalog didn.t load/i)).toBeInTheDocument();
  });
});

/**
 * The vet is CHOSEN, never typed, and choosing it never RE-AUTHORS the old
 * copy with new text.
 *
 * Issue #677: linking a clinic used to leave the seven free-text
 * `primaryVet*` / `emergencyVet*` keys sitting on the record forever, since
 * nothing in the admin ever touched them. From the operator's chair that reads
 * as "cannot update vet", the operator's exact words: the picker showed the new
 * clinic, the read view showed the new clinic, and the record still carried a
 * name nobody chose. A save now clears a slot's legacy keys the moment that
 * slot links a clinic (`lib/householdDataSchema.ts#legacyVetKeysForSlot`), and
 * an unlinked slot's legacy text is left alone, since that text is the vet
 * being shown for it.
 */
describe('HouseholdData: editing the vet', () => {
  /** The catalog rows the picker searches. `CLINIC` is the household's current vet. */
  const CATALOG = [
    CLINIC,
    { _id: 'clinic_er', name: 'Austin Pet ER', phone: '(512) 555 0300', address: '9 Night Ln', isEmergency: true },
    { _id: 'clinic_themill', name: 'The Mill Veterinary', phone: '(512) 555 0400', address: '2 Oak Rd' },
  ];

  async function openVet() {
    useCollection.mockReturnValue({ status: 'ready', data: CATALOG });
    getHouseholdData.mockResolvedValue(record({ primaryVetClinicId: 'clinic_riverside' }));
    saveHouseholdSection.mockImplementation(
      async (current: HouseholdRecord, patch: Partial<HouseholdRecord>) => ({ ...current, ...patch }),
    );
    mount();
    await screen.findByText('Pantry, second shelf');
    await user.click(screen.getByRole('button', { name: 'Edit veterinary' }));
    return screen.getByRole('dialog');
  }

  /**
   * THE ONE THAT MATTERS (issue #677). `record()`'s fixture already carries
   * legacy primary text ("Barton Creek Animal Hospital") alongside a linked
   * `primaryVetClinicId`, the exact "dd" shape from the walk: a clinic is
   * chosen, and the old text is still sitting on the record. Saving from here
   * must clear it, in the same write, rather than leaving it for a banner that
   * can only report it.
   */
  it('clears the linked primary slot\'s legacy keys, and leaves the unlinked emergency slot alone', async () => {
    const dialog = await openVet();
    await user.click(within(dialog).getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(saveHouseholdSection).toHaveBeenCalled());
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    // Primary is linked (clinic_riverside), so its four legacy keys clear.
    expect(patch['primaryVetName']).toBe('');
    expect(patch['primaryVetPhone']).toBe('');
    expect(patch['primaryVetHours']).toBe('');
    expect(patch['primaryVetAddress']).toBe('');
    // Emergency is unlinked in this fixture, so its legacy keys are not touched.
    for (const key of ['emergencyVetName', 'emergencyVetPhone', 'emergencyVetAddress']) {
      expect(patch).not.toHaveProperty(key);
    }
    expect(patch['primaryVetClinicId']).toBe('clinic_riverside');
    expect(patch['emergencyVetClinicId']).toBe('');
  });

  it('clears the emergency slot\'s legacy keys too, once it is linked', async () => {
    const dialog = await openVet();
    await user.type(within(dialog).getByLabelText('Emergency vet'), 'Pet ER');
    await user.click(await within(dialog).findByText('Austin Pet ER'));
    await user.click(within(dialog).getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(saveHouseholdSection).toHaveBeenCalled());
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    expect(patch['emergencyVetClinicId']).toBe('clinic_er');
    expect(patch['emergencyVetName']).toBe('');
    expect(patch['emergencyVetPhone']).toBe('');
    expect(patch['emergencyVetAddress']).toBe('');
  });

  it('picks the vet from the catalog by search rather than typing a document id', async () => {
    const dialog = await openVet();

    // No raw id anywhere: the operator searches, and the value is a catalog row.
    expect(within(dialog).queryByDisplayValue('clinic_riverside')).not.toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Primary vet'), 'Mill');
    await user.click(await within(dialog).findByText('The Mill Veterinary'));
    await user.click(within(dialog).getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(saveHouseholdSection).toHaveBeenCalled());
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    expect(patch['primaryVetClinicId']).toBe('clinic_themill');
  });

  it('shows the vet on file when it opens, so a save is not a blind overwrite', async () => {
    const dialog = await openVet();
    expect(within(dialog).getByText('Riverside Animal Hospital')).toBeInTheDocument();
  });

  it('raises the same toast and closes on a landed save', async () => {
    const dialog = await openVet();
    await user.click(within(dialog).getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(/Saved veterinary for Nora Whitfield/)).toBeInTheDocument();
  });

  it('keeps a rejected save on screen with the reason, never a silent failure', async () => {
    const dialog = await openVet();
    saveHouseholdSection.mockRejectedValue(new Error('permission-denied'));

    await user.click(within(dialog).getByRole('button', { name: /^Save/ }));
    expect(await within(dialog).findByText(/permission-denied/)).toBeInTheDocument();
    expect(screen.queryByText(/Saved veterinary/)).not.toBeInTheDocument();
  });

  it('refuses to save against a catalog that has not loaded, rather than clearing the link', async () => {
    // With no catalog there is nothing to resolve the stored id against, so the
    // pickers would open blank. Saving from there would blank a real vet.
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    getHouseholdData.mockResolvedValue(record({ primaryVetClinicId: 'clinic_riverside' }));
    mount();
    await screen.findByText('Pantry, second shelf');
    await user.click(screen.getByRole('button', { name: 'Edit veterinary' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /^Save/ })).toBeDisabled();
    expect(within(dialog).getByText(/catalog didn.t load/i)).toBeInTheDocument();
    expect(saveHouseholdSection).not.toHaveBeenCalled();
  });
});

/**
 * Issue #677, the second half: the leftovers banner used to tell the operator
 * to "resolve by hand" with no control anywhere in the admin that could ever
 * touch these fields. This is that control: a button on the banner, a confirm
 * step (this write cannot be undone from here), and the same `saveHouseholdSection`
 * write path as every other edit on this screen.
 */
describe('HouseholdData: clearing the old vet notes', () => {
  function leftoverRecord() {
    return record({
      primaryVetClinicId: 'clinic_riverside',
      primaryVetName: 'Barton Creek Animal Hospital',
      primaryVetPhone: '(512) 555 0134',
    });
  }

  it('shows a Clear old vet notes button beside the leftovers', async () => {
    getHouseholdData.mockResolvedValue(leftoverRecord());
    mount();
    expect(await screen.findByText(/Older vet notes are still on this record/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear old vet notes' })).toBeInTheDocument();
  });

  it('does not show the button when there is nothing left to clear', async () => {
    mount();
    await screen.findByText('Pantry, second shelf');
    expect(screen.queryByRole('button', { name: 'Clear old vet notes' })).not.toBeInTheDocument();
  });

  it('asks to confirm before writing anything', async () => {
    getHouseholdData.mockResolvedValue(leftoverRecord());
    mount();
    await screen.findByText(/Older vet notes are still on this record/);

    await user.click(screen.getByRole('button', { name: 'Clear old vet notes' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(saveHouseholdSection).not.toHaveBeenCalled();
  });

  it('cancels without writing anything', async () => {
    getHouseholdData.mockResolvedValue(leftoverRecord());
    mount();
    await screen.findByText(/Older vet notes are still on this record/);

    await user.click(screen.getByRole('button', { name: 'Clear old vet notes' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(saveHouseholdSection).not.toHaveBeenCalled();
  });

  it('clears only the leftover legacy fields on confirm, through the same write path, and the banner drops away', async () => {
    getHouseholdData.mockResolvedValue(leftoverRecord());
    saveHouseholdSection.mockImplementation(
      async (current: HouseholdRecord, patch: Partial<HouseholdRecord>) => ({ ...current, ...patch }),
    );
    mount();
    await screen.findByText(/Older vet notes are still on this record/);

    await user.click(screen.getByRole('button', { name: 'Clear old vet notes' }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(saveHouseholdSection).toHaveBeenCalled());
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    expect(patch['primaryVetName']).toBe('');
    expect(patch['primaryVetPhone']).toBe('');
    // Only what was actually shown as a leftover travels, never the clinic link.
    expect(patch).not.toHaveProperty('primaryVetClinicId');
    expect(patch).not.toHaveProperty('primaryVetHours');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(/Older vet notes are still on this record/)).not.toBeInTheDocument();
    expect(await screen.findByText(/Cleared the old vet notes for Nora Whitfield/)).toBeInTheDocument();
  });

  it('keeps the dialog open with the reason on a rejected clear, and the leftovers stay on screen', async () => {
    getHouseholdData.mockResolvedValue(leftoverRecord());
    saveHouseholdSection.mockRejectedValue(new Error('permission-denied'));
    mount();
    await screen.findByText(/Older vet notes are still on this record/);

    await user.click(screen.getByRole('button', { name: 'Clear old vet notes' }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(await screen.findByText(/permission-denied/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByText(/Older vet notes are still on this record/).length).toBeGreaterThan(0);
  });
});
