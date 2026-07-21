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

import { HouseholdData } from './HouseholdData';

function record(over: Partial<HouseholdRecord> = {}): HouseholdRecord {
  return {
    ...blankHouseholdRecord('kf1'),
    _id: 'hd1',
    primaryVetName: 'Barton Creek Animal Hospital',
    primaryVetPhone: '(512) 555 0134',
    foodLocation: 'Pantry, second shelf',
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
});

function mount(over: Partial<{ kinfolkName: string }> = {}) {
  return render(
    <HouseholdData kinfolkId="kf1" kinfolkName={over.kinfolkName ?? 'Nora Whitfield'} onBack={() => {}} />,
  );
}

describe('HouseholdData: reading the record', () => {
  it('renders every section with the values that were read', async () => {
    mount();
    expect(await screen.findByText('Barton Creek Animal Hospital')).toBeInTheDocument();
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
    await screen.findByText('Barton Creek Animal Hospital');
    expect(screen.getByText('Evacuation plan')).toBeInTheDocument();
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
  });

  it('counts what is on file per section, and never claims more', async () => {
    mount();
    // Veterinary: 2 of 7 filled by the fixture.
    expect(await screen.findByText(/2 of 7 on file/)).toBeInTheDocument();
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
    expect(screen.queryByText('Barton Creek Animal Hospital')).not.toBeInTheDocument();
  });
});

describe('HouseholdData: empty and error are not the same thing', () => {
  it('says nothing is on file yet when the household genuinely has no record', async () => {
    getHouseholdData.mockResolvedValue(null);
    mount();
    expect(await screen.findByText(/Nothing on file yet/)).toBeInTheDocument();
    // Still editable: the first save starts the record from any section.
    expect(screen.getByRole('button', { name: 'Edit veterinary' })).toBeInTheDocument();
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
    await screen.findByText('Barton Creek Animal Hospital');

    expect(screen.queryByText(/code 4417/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show security system' })).toBeInTheDocument();
  });

  it('reveals it on request, and can hide it again', async () => {
    mount();
    await screen.findByText('Barton Creek Animal Hospital');

    await user.click(screen.getByRole('button', { name: 'Show security system' }));
    expect(screen.getByText(/code 4417/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide security system' }));
    expect(screen.queryByText(/code 4417/)).not.toBeInTheDocument();
  });

  it('masks the documents location too, since every backup on the roster can read this record', async () => {
    getHouseholdData.mockResolvedValue(record({ importantDocumentsLocation: 'Fire safe under the stairs' }));
    mount();
    await screen.findByText('Barton Creek Animal Hospital');

    expect(screen.queryByText(/Fire safe under the stairs/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show important documents' })).toBeInTheDocument();
  });
});

describe('HouseholdData: editing a section', () => {
  async function openVeterinary() {
    mount();
    await screen.findByText('Barton Creek Animal Hospital');
    await user.click(screen.getByRole('button', { name: 'Edit veterinary' }));
    return screen.getByRole('dialog');
  }

  it('opens a modal that names the section and the household', async () => {
    const dialog = await openVeterinary();
    expect(within(dialog).getByText('Veterinary · Nora Whitfield')).toBeInTheDocument();
  });

  it('seeds the form from the record rather than opening blank', async () => {
    const dialog = await openVeterinary();
    expect(within(dialog).getByLabelText('Primary vet')).toHaveValue('Barton Creek Animal Hospital');
  });

  it('rejects a phone that cannot be dialed, inline beside the field, and does not save', async () => {
    const dialog = await openVeterinary();

    const phone = within(dialog).getByLabelText('Primary vet phone');
    await user.clear(phone);
    await user.type(phone, 'ask at the desk');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    expect(await within(dialog).findByText(/dialed/i)).toBeInTheDocument();
    expect(phone).toHaveAttribute('aria-invalid', 'true');
    expect(saveHouseholdSection).not.toHaveBeenCalled();
  });

  it('rejects an em dash in Auntie voice, inline', async () => {
    const dialog = await openVeterinary();

    const name = within(dialog).getByLabelText('Primary vet');
    await user.clear(name);
    await user.type(name, 'Barton Creek—the new one');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    expect(await within(dialog).findByText(/does not use dashes/i)).toBeInTheDocument();
    expect(saveHouseholdSection).not.toHaveBeenCalled();
  });

  it('saves only the edited section, updates the view, and raises a toast', async () => {
    const dialog = await openVeterinary();
    saveHouseholdSection.mockImplementation(
      async (current: HouseholdRecord, patch: Partial<HouseholdRecord>) => ({ ...current, ...patch }),
    );

    const name = within(dialog).getByLabelText('Primary vet');
    await user.clear(name);
    await user.type(name, 'Lakeway Vet Clinic');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Only this section's seven keys travelled, never all thirty.
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    expect(patch['primaryVetName']).toBe('Lakeway Vet Clinic');
    expect(patch).not.toHaveProperty('foodLocation');

    expect(await screen.findByText('Lakeway Vet Clinic')).toBeInTheDocument();
    expect(await screen.findByText(/Saved veterinary for Nora Whitfield/)).toBeInTheDocument();
  });

  it('surfaces a rejected save in a persistent banner and keeps the operator-s edits', async () => {
    const dialog = await openVeterinary();
    saveHouseholdSection.mockRejectedValue(new Error('permission-denied'));

    const name = within(dialog).getByLabelText('Primary vet');
    await user.clear(name);
    await user.type(name, 'Lakeway Vet Clinic');
    await user.click(within(dialog).getByRole('button', { name: /Save section/ }));

    expect(await within(dialog).findByText(/permission-denied/)).toBeInTheDocument();
    // Still open, still holding what was typed. A failed save is not a lost edit.
    expect(within(dialog).getByLabelText('Primary vet')).toHaveValue('Lakeway Vet Clinic');
    expect(screen.queryByText(/Saved veterinary/)).not.toBeInTheDocument();
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
    await screen.findByText('Barton Creek Animal Hospital');
    await user.click(screen.getByRole('button', { name: 'Edit routines and preferences' }));
    const dialog = screen.getByRole('dialog');

    const input = within(dialog).getByLabelText('Security system');
    expect(input).toHaveAttribute('type', 'password');

    await user.click(within(dialog).getByRole('button', { name: 'Show security system' }));
    expect(within(dialog).getByLabelText('Security system')).toHaveAttribute('type', 'text');
  });
});
