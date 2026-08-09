// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { blankHouseholdRecord, type HouseholdRecord } from '../api/householdData';
import {
  EDITABLE_HOUSEHOLD_SECTIONS,
  HOUSEHOLD_SECTIONS,
  type HouseholdSectionSpec,
} from '../lib/householdDataSchema';

const { saveHouseholdSection } = vi.hoisted(() => ({ saveHouseholdSection: vi.fn() }));
vi.mock('../api/householdData', async (orig) => ({
  ...(await orig<typeof import('../api/householdData')>()),
  saveHouseholdSection,
}));

import { HouseholdSectionDialog } from './HouseholdSectionDialog';

function sectionById(id: string): HouseholdSectionSpec {
  const found = HOUSEHOLD_SECTIONS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no household section "${id}"`);
  return found;
}

const VETERINARY = sectionById('veterinary');
const ITEMS = sectionById('items');

function record(over: Partial<HouseholdRecord> = {}): HouseholdRecord {
  return {
    ...blankHouseholdRecord('kf1'),
    _id: 'hd1',
    primaryVetClinicId: 'clinic_riverside',
    primaryVetName: 'Barton Creek Animal Hospital',
    primaryVetPhone: '(512) 555 0134',
    foodLocation: 'Pantry, second shelf',
    ...over,
  };
}

function mount(section: HouseholdSectionSpec) {
  const onSaved = vi.fn();
  render(
    <HouseholdSectionDialog
      section={section}
      kinfolkName="Nora Whitfield"
      record={record()}
      onClose={() => {}}
      onSaved={onSaved}
    />,
  );
  return { onSaved };
}

const user = userEvent.setup();

beforeEach(() => {
  saveHouseholdSection.mockReset();
  saveHouseholdSection.mockImplementation(
    async (current: HouseholdRecord, patch: Partial<HouseholdRecord>) => ({ ...current, ...patch }),
  );
});

/**
 * `EDITABLE_HOUSEHOLD_SECTIONS` has existed since the vet moved to the shared
 * catalog and has never been consulted by anything but a schema test, so the
 * generic text dialog would edit ANY section handed to it, including the one
 * whose two real values are `vet_clinics` document ids.
 *
 * The guard is here rather than only at the call site because a component that
 * trusts its caller is one refactor away from being wrong again, and what it
 * would be wrong about is the record a sitter reads a vet's number off.
 */
describe('HouseholdSectionDialog: the sections it refuses', () => {
  it('renders no input at all for a section it does not own', () => {
    mount(VETERINARY);

    // Pre-fix, all nine veterinary fields rendered as plain text boxes, two of
    // them holding a raw Firestore document id.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('clinic_riverside')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Barton Creek Animal Hospital')).not.toBeInTheDocument();
  });

  it('offers no save, so the retired free text cannot be written from here', async () => {
    mount(VETERINARY);
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
    await waitFor(() => expect(saveHouseholdSection).not.toHaveBeenCalled());
  });

  it('says why, rather than showing an empty dialog', () => {
    mount(VETERINARY);
    // Fail loud: an operator who got here deserves to know where the vet is
    // authored, not a blank modal.
    expect(screen.getByRole('alert')).toHaveTextContent(/shared vet bank|catalog/i);
  });

  it('names the guard it is enforcing, so the two cannot drift', () => {
    // If the veterinary section were ever added back to the editable list, the
    // refusals above would silently stop being tested. This is the tripwire.
    expect(EDITABLE_HOUSEHOLD_SECTIONS.some((s) => s.id === 'veterinary')).toBe(false);
    expect(EDITABLE_HOUSEHOLD_SECTIONS.some((s) => s.id === 'items')).toBe(true);
  });
});

describe('HouseholdSectionDialog: the sections it does own', () => {
  it('still edits and saves a generic text section', async () => {
    const { onSaved } = mount(ITEMS);

    const food = screen.getByLabelText('Food');
    expect(food).toHaveValue('Pantry, second shelf');
    await user.clear(food);
    await user.type(food, 'Top pantry shelf');
    await user.click(screen.getByRole('button', { name: /Save section/ }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = saveHouseholdSection.mock.calls[0]?.[1] as Record<string, string>;
    expect(patch['foodLocation']).toBe('Top pantry shelf');
    expect(patch).not.toHaveProperty('primaryVetName');
  });
});
