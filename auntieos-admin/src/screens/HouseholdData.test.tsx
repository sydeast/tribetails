// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { blankHouseholdRecord, type HouseholdRecord } from '../api/householdData';
import { mergeKinfolkProfile, type KinfolkProfile } from '../api/kinfolkProfile';

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
const { getKinfolkProfile, useCollection } = vi.hoisted(() => ({
  getKinfolkProfile: vi.fn(),
  useCollection: vi.fn(),
}));
vi.mock('../api/kinfolkProfile', async (orig) => ({
  ...(await orig<typeof import('../api/kinfolkProfile')>()),
  getKinfolkProfile,
}));
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
  getKinfolkProfile.mockReset();
  getKinfolkProfile.mockResolvedValue(profile());
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
/** The canonical vet: catalog-linked, on the kinfolk record, not on this one. */
function profile(over: Partial<KinfolkProfile> = {}): KinfolkProfile {
  return {
    ...mergeKinfolkProfile('kf1', null),
    vetClinicId: 'clinic_riverside',
    vetClinicName: 'Riverside Animal Hospital',
    vetClinicPhone: '(512) 555 0100',
    vetClinicAddress: '418 Mill St',
    emergencyVetClinicId: 'clinic_er',
    emergencyVetClinicName: 'Austin Pet ER',
    emergencyVetClinicPhone: '(512) 555 0300',
    emergencyVetClinicAddress: '4 Night Ln',
    ...over,
  };
}

function mount(over: Partial<{ kinfolkName: string }> = {}) {
  return render(
    <HouseholdData kinfolkId="kf1" kinfolkName={over.kinfolkName ?? 'Nora Whitfield'} onBack={() => {}} />,
  );
}

describe('HouseholdData: reading the record', () => {
  it('renders every section with the values that were read', async () => {
    mount();
    expect(await screen.findByText('Paws and Claws Grooming')).toBeInTheDocument();
    expect(screen.getByText('Pantry, second shelf')).toBeInTheDocument();

    for (const title of [
      'Veterinary',
      'Items and locations',
      'Routines and preferences',
      'Emergency and safety',
      'Service providers',
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it('names the household in the heading', async () => {
    mount();
    expect(await screen.findByText(/Nora Whitfield/)).toBeInTheDocument();
  });

  it('shows a blank field as "Not set" rather than hiding it, because the gaps are the point', async () => {
    mount();
    await screen.findByText('Paws and Claws Grooming');
    expect(screen.getByText('Evacuation plan')).toBeInTheDocument();
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
    expect(screen.queryByText('Paws and Claws Grooming')).not.toBeInTheDocument();
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
    await screen.findByText('Paws and Claws Grooming');

    expect(screen.queryByText(/code 4417/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show security system' })).toBeInTheDocument();
  });

  it('reveals it on request, and can hide it again', async () => {
    mount();
    await screen.findByText('Paws and Claws Grooming');

    await user.click(screen.getByRole('button', { name: 'Show security system' }));
    expect(screen.getByText(/code 4417/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide security system' }));
    expect(screen.queryByText(/code 4417/)).not.toBeInTheDocument();
  });

  it('masks the documents location too, since every backup on the roster can read this record', async () => {
    getHouseholdData.mockResolvedValue(record({ importantDocumentsLocation: 'Fire safe under the stairs' }));
    mount();
    await screen.findByText('Paws and Claws Grooming');

    expect(screen.queryByText(/Fire safe under the stairs/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show important documents' })).toBeInTheDocument();
  });
});

describe('HouseholdData: editing a section', () => {
  async function openProviders() {
    mount();
    await screen.findByText('Paws and Claws Grooming');
    await user.click(screen.getByRole('button', { name: 'Edit service providers' }));
    return screen.getByRole('dialog');
  }

  it('opens a modal that names the section and the household', async () => {
    const dialog = await openProviders();
    expect(within(dialog).getByText('Service providers · Nora Whitfield')).toBeInTheDocument();
  });

  it('seeds the form from the record rather than opening blank', async () => {
    const dialog = await openProviders();
    expect(within(dialog).getByLabelText('Groomer')).toHaveValue('Paws and Claws Grooming');
  });

  it('rejects a phone that cannot be dialed, inline beside the field, and does not save', async () => {
    const dialog = await openProviders();

    const phone = within(dialog).getByLabelText('Groomer phone');
    await user.clear(phone);
    await user.type(phone, 'ask at the desk');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    expect(await within(dialog).findByText(/dialed/i)).toBeInTheDocument();
    expect(phone).toHaveAttribute('aria-invalid', 'true');
    expect(saveHouseholdSection).not.toHaveBeenCalled();
  });

  it('rejects an em dash in Auntie voice, inline', async () => {
    const dialog = await openProviders();

    const name = within(dialog).getByLabelText('Groomer');
    await user.clear(name);
    await user.type(name, 'Paws and Claws—the new one');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    expect(await within(dialog).findByText(/does not use dashes/i)).toBeInTheDocument();
    expect(saveHouseholdSection).not.toHaveBeenCalled();
  });

  it('saves only the edited section, updates the view, and raises a toast', async () => {
    const dialog = await openProviders();
    saveHouseholdSection.mockImplementation(
      async (current: HouseholdRecord, patch: Partial<HouseholdRecord>) => ({ ...current, ...patch }),
    );

    const name = within(dialog).getByLabelText('Groomer');
    await user.clear(name);
    await user.type(name, 'Shaggy Chic');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Only this section's six keys travelled, never all thirty.
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    expect(patch['groomerName']).toBe('Shaggy Chic');
    expect(patch).not.toHaveProperty('foodLocation');
    // And never the retired vet keys, which nothing writes any more.
    expect(patch).not.toHaveProperty('primaryVetName');

    expect(await screen.findByText('Shaggy Chic')).toBeInTheDocument();
    expect(await screen.findByText(/Saved service providers for Nora Whitfield/)).toBeInTheDocument();
  });

  it('surfaces a rejected save in a persistent banner and keeps the operator-s edits', async () => {
    const dialog = await openProviders();
    saveHouseholdSection.mockRejectedValue(new Error('permission-denied'));

    const name = within(dialog).getByLabelText('Groomer');
    await user.clear(name);
    await user.type(name, 'Shaggy Chic');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    expect(await within(dialog).findByText(/permission-denied/)).toBeInTheDocument();
    // Still open, still holding what was typed. A failed save is not a lost edit.
    expect(within(dialog).getByLabelText('Groomer')).toHaveValue('Shaggy Chic');
    expect(screen.queryByText(/Saved service providers/)).not.toBeInTheDocument();
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
    await screen.findByText('Paws and Claws Grooming');
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
describe('HouseholdData: the vet is read through, not authored here', () => {
  it('shows the regular and emergency vet from the household profile', async () => {
    mount();
    expect(await screen.findByText('Riverside Animal Hospital')).toBeInTheDocument();
    expect(screen.getByText('(512) 555 0100')).toBeInTheDocument();
    expect(screen.getByText('Austin Pet ER')).toBeInTheDocument();
    expect(screen.getByText('(512) 555 0300')).toBeInTheDocument();
  });
  it('keeps the emergency vet as a DISTINCT clinic, never folded into the primary', async () => {
    mount();
    await screen.findByText('Riverside Animal Hospital');
    expect(screen.getByText('Emergency vet')).toBeInTheDocument();
    expect(screen.getByText('Emergency vet phone')).toBeInTheDocument();
    expect(screen.getByText('Emergency vet address')).toBeInTheDocument();
  });
  it('reads the hours off the CLINIC, since every household shares a practice s hours', async () => {
    mount();
    expect(await screen.findByText('Mon to Fri 8a to 6p')).toBeInTheDocument();
  });
  it('offers no editor for the vet here, so it cannot be authored twice', async () => {
    mount();
    await screen.findByText('Riverside Animal Hospital');
    expect(screen.queryByRole('button', { name: 'Edit veterinary' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit on the profile' })).toBeInTheDocument();
  });
  it('says so when a household s vet is not linked to the catalog', async () => {
    // No id means updateVetClinic s fan-out cannot reach this household, which
    // is worth saying out loud rather than leaving as an invisible difference.
    getKinfolkProfile.mockResolvedValue(
      profile({ vetClinicId: '', vetClinicName: 'Some Clinic', vetClinicPhone: '555' }),
    );
    mount();
    expect(await screen.findByText(/not linked to the catalog/i)).toBeInTheDocument();
  });
  it('does not cry unlinked when the vet IS linked', async () => {
    mount();
    await screen.findByText('Riverside Animal Hospital');
    expect(screen.queryByText(/not linked to the catalog/i)).not.toBeInTheDocument();
  });
  it('still SHOWS retired free text rather than dropping it silently', async () => {
    // The fixture carries the old primaryVetName. It is superseded, not deleted,
    // so it must remain visible and be named as superseded.
    mount();
    expect(await screen.findByText(/Older vet notes are still on this record/)).toBeInTheDocument();
    expect(screen.getByText('Barton Creek Animal Hospital')).toBeInTheDocument();
  });
  it('says nothing about leftovers when there are none', async () => {
    getHouseholdData.mockResolvedValue(
      record({ primaryVetName: '', primaryVetPhone: '', primaryVetHours: '' }),
    );
    mount();
    await screen.findByText('Riverside Animal Hospital');
    expect(screen.queryByText(/Older vet notes/)).not.toBeInTheDocument();
  });
  it('fails loud when the vet read fails, rather than showing a blank vet', async () => {
    getKinfolkProfile.mockRejectedValue(new Error('permission-denied'));
    mount();
    const alerts = await screen.findAllByRole('alert');
    expect(
      alerts.some((a) => /Couldn.t load the household.s vet/.test(a.textContent ?? '')),
    ).toBe(true);
  });
  it('shows Not set for a household with no vet at all', async () => {
    getKinfolkProfile.mockResolvedValue(mergeKinfolkProfile('kf1', null));
    mount();
    expect(await screen.findByText(/No vet on file for this household/)).toBeInTheDocument();
  });
});
