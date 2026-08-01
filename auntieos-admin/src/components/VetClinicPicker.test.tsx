// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VetClinic } from '../api/vetClinics';

const { submitVetClinic } = vi.hoisted(() => ({ submitVetClinic: vi.fn() }));
vi.mock('../api/vetClinicsWrite', async (orig) => ({
  ...(await orig<typeof import('../api/vetClinicsWrite')>()),
  submitVetClinic,
}));

import { VetClinicPicker, type VetClinicSelection } from './VetClinicPicker';

function clinic(over: Partial<VetClinic> & { _id: string; name: string }): VetClinic {
  return { phone: '', address: '', website: '', isEmergency: false, verified: true, ...over };
}

const CATALOG: VetClinic[] = [
  clinic({ _id: 'riverside', name: 'Riverside Animal Hospital', phone: '(512) 555-0100', address: '1 Mill St' }),
  clinic({ _id: 'themill', name: 'The Mill Vet', phone: '(512) 555-0200', address: '9 Oak Rd' }),
  clinic({ _id: 'er', name: 'Austin Pet ER', phone: '(512) 555-0300', address: '4 Night Ln', isEmergency: true }),
];

const EMPTY_SELECTION: VetClinicSelection = { clinicId: '', name: '', phone: '', address: '' };

function mount(props: Partial<React.ComponentProps<typeof VetClinicPicker>> = {}) {
  const onChange = vi.fn();
  render(
    <VetClinicPicker
      name="vetClinic"
      label="Vet clinic"
      clinics={CATALOG}
      value={EMPTY_SELECTION}
      onChange={onChange}
      {...props}
    />,
  );
  return { onChange };
}

function searchBox() {
  return screen.getByLabelText('Vet clinic');
}

beforeEach(() => {
  submitVetClinic.mockReset();
});

describe('VetClinicPicker: search', () => {
  it('names the catalog size in the placeholder, so the operator knows there is one', () => {
    mount();
    expect(searchBox()).toHaveAttribute('placeholder', 'Type to search 3 clinics');
  });

  it('says so plainly when the catalog is empty rather than promising a search', () => {
    mount({ clinics: [] });
    expect(searchBox()).toHaveAttribute('placeholder', 'No clinics in the catalog yet');
  });

  it('ranks a prefix match above a substring match', async () => {
    // Catalog order puts the SUBSTRING match first, so passing this cannot be an
    // accident of input order.
    mount({
      clinics: [
        clinic({ _id: 'sub', name: 'The Mill Vet' }),
        clinic({ _id: 'pre', name: 'Millbrook Veterinary' }),
      ],
    });
    await userEvent.type(searchBox(), 'mill');
    const names = screen.getAllByTestId('vetpick-option').map((el) => el.textContent);
    expect(names[0]).toContain('Millbrook Veterinary');
    expect(names[1]).toContain('The Mill Vet');
  });

  it('caps the list at 8 rows above the pinned create button', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      clinic({ _id: `c${i}`, name: `Vetworks ${i}` }),
    );
    mount({ clinics: many });
    await userEvent.type(searchBox(), 'vetworks');
    expect(screen.getAllByTestId('vetpick-option')).toHaveLength(8);
  });

  it('shows each match with its phone and address', async () => {
    mount();
    await userEvent.type(searchBox(), 'riverside');
    const option = screen.getByRole('button', { name: /Riverside Animal Hospital/ });
    expect(option).toHaveTextContent('(512) 555-0100');
    expect(option).toHaveTextContent('1 Mill St');
  });

  it('selects a clinic with its id AND the denormalized name, phone and address', async () => {
    const { onChange } = mount();
    await userEvent.type(searchBox(), 'riverside');
    await userEvent.click(screen.getByRole('button', { name: /Riverside Animal Hospital/ }));
    expect(onChange).toHaveBeenCalledWith({
      clinicId: 'riverside',
      name: 'Riverside Animal Hospital',
      phone: '(512) 555-0100',
      address: '1 Mill St',
    });
  });

  it('hides pending kinfolk submissions from the operator-facing list it is given', async () => {
    // The picker renders what it is handed; the SCREEN filters. This pins that
    // an unverified row passed in is still searchable, so the operator can
    // attach a clinic they are about to approve.
    mount({ clinics: [clinic({ _id: 'pending', name: 'Pending Vet', verified: false })] });
    await userEvent.type(searchBox(), 'pending');
    expect(screen.getByRole('button', { name: /Pending Vet/ })).toBeInTheDocument();
  });
});

describe('VetClinicPicker: no free-text passthrough', () => {
  /**
   * Operator ruling: the field's value is always a clinic from the database.
   * Typing is a SEARCH, not a value, so the search box text must never reach
   * onChange on its own.
   */
  it('does not report a typed name as a selection', async () => {
    const { onChange } = mount();
    await userEvent.type(searchBox(), 'Some Clinic That Is Not In The Bank');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not select anything on Enter with a typed name', async () => {
    const { onChange } = mount();
    await userEvent.type(searchBox(), 'Riverside Animal Hospital{Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the SELECTED clinic as a chip, not as text in the search box', () => {
    mount({
      value: { clinicId: 'riverside', name: 'Riverside Animal Hospital', phone: '(512) 555-0100', address: '1 Mill St' },
    });
    expect(screen.getByTestId('vetpick-selected')).toHaveTextContent('Riverside Animal Hospital');
    expect(searchBox()).toHaveValue('');
  });

  it('clears back to no clinic via the chip clear button', async () => {
    const { onChange } = mount({
      value: { clinicId: 'riverside', name: 'Riverside Animal Hospital', phone: '', address: '' },
    });
    await userEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith({ clinicId: '', name: '', phone: '', address: '' });
  });
});

describe('VetClinicPicker: legacy string-only households', () => {
  /**
   * Every household on file today holds a plain `vetClinicName` string with no
   * `vetClinicId`. Those records must open, render, and save without crashing,
   * and without the picker pretending the name is a catalog entry.
   */
  it('renders a legacy name with no id, and says it is not linked yet', () => {
    mount({ value: { clinicId: '', name: 'Old Corner Vet', phone: '(512) 555-9999', address: '' } });
    expect(screen.getByTestId('vetpick-selected')).toHaveTextContent('Old Corner Vet');
    expect(screen.getByText(/not linked to the shared catalog/i)).toBeInTheDocument();
  });

  it('does not warn about linkage for a clinic that DOES have an id', () => {
    mount({ value: { clinicId: 'riverside', name: 'Riverside Animal Hospital', phone: '', address: '' } });
    expect(screen.queryByText(/not linked to the shared catalog/i)).not.toBeInTheDocument();
  });

  it('lets a legacy name be replaced with a real catalog entry', async () => {
    const { onChange } = mount({ value: { clinicId: '', name: 'Old Corner Vet', phone: '', address: '' } });
    await userEvent.click(screen.getByRole('button', { name: /clear/i }));
    await userEvent.type(searchBox(), 'riverside');
    await userEvent.click(screen.getByRole('button', { name: /Riverside Animal Hospital/ }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ clinicId: 'riverside', name: 'Riverside Animal Hospital' }),
    );
  });
});

describe('VetClinicPicker: the pinned create button', () => {
  it('is pinned at the very BOTTOM of the dropdown, below every match', async () => {
    mount();
    await userEvent.type(searchBox(), 'mill');
    const rows = screen.getAllByRole('button', { name: /Mill|Riverside|as a new vet clinic/ });
    expect(rows[rows.length - 1]).toHaveTextContent('as a new vet clinic');
  });

  it('is visible with ZERO matches, which is exactly when it is needed', async () => {
    mount();
    await userEvent.type(searchBox(), 'zzzz');
    expect(screen.queryAllByTestId('vetpick-option')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Create "zzzz" as a new vet clinic/ })).toBeInTheDocument();
  });

  it('quotes the current query in its label', async () => {
    mount();
    await userEvent.type(searchBox(), 'Barton Springs');
    expect(
      screen.getByRole('button', { name: /Create "Barton Springs" as a new vet clinic/ }),
    ).toBeInTheDocument();
  });

  it('is not offered before anything is typed', () => {
    mount();
    expect(screen.queryByText(/as a new vet clinic/)).not.toBeInTheDocument();
  });
});

describe('VetClinicPicker: the inline create form', () => {
  async function openCreateForm(query = 'Barton Springs Animal Clinic') {
    const res = mount();
    await userEvent.type(searchBox(), query);
    await userEvent.click(screen.getByRole('button', { name: /as a new vet clinic/ }));
    return res;
  }

  it('prefills the name from the query', async () => {
    await openCreateForm();
    expect(screen.getByLabelText('Clinic name')).toHaveValue('Barton Springs Animal Clinic');
  });

  it('collects phone, address, website and an emergency toggle', async () => {
    await openCreateForm();
    expect(screen.getByLabelText('Clinic phone')).toBeInTheDocument();
    expect(screen.getByLabelText('Clinic address')).toBeInTheDocument();
    expect(screen.getByLabelText('Website')).toBeInTheDocument();
    expect(screen.getByLabelText(/24 hour \/ emergency clinic/i)).toBeInTheDocument();
  });

  it('saves through submitVetClinic and SELECTS the new clinic', async () => {
    submitVetClinic.mockResolvedValue({ status: 'created', clinicId: 'new-1', created: true, pending: false, candidates: [] });
    const { onChange } = await openCreateForm();

    await userEvent.type(screen.getByLabelText('Clinic phone'), '(512) 555-0400');
    await userEvent.type(screen.getByLabelText('Clinic address'), '2 Barton Rd');
    await userEvent.click(screen.getByRole('button', { name: /^save clinic$/i }));

    await waitFor(() =>
      expect(submitVetClinic).toHaveBeenCalledWith(
        {
          name: 'Barton Springs Animal Clinic',
          phone: '(512) 555-0400',
          address: '2 Barton Rd',
          website: '',
          isEmergency: false,
        },
        // Empty on a first attempt: the safe path is the default.
        [],
      ),
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        clinicId: 'new-1',
        name: 'Barton Springs Animal Clinic',
        phone: '(512) 555-0400',
        address: '2 Barton Rd',
      }),
    );
  });

  it('sends isEmergency when the toggle is on', async () => {
    submitVetClinic.mockResolvedValue({ status: 'created', clinicId: 'new-2', created: true, pending: false, candidates: [] });
    await openCreateForm('Night Owl Pet ER');
    await userEvent.click(screen.getByLabelText(/24 hour \/ emergency clinic/i));
    await userEvent.click(screen.getByRole('button', { name: /^save clinic$/i }));
    await waitFor(() =>
      expect(submitVetClinic).toHaveBeenCalledWith(
        expect.objectContaining({ isEmergency: true }),
        // Empty on a first attempt: the safe path is the default.
        [],
      ),
    );
  });

  /**
   * Operator ruling 2026-08-01: a near match must OFFER a choice, never take
   * one. This block previously asserted the opposite, that the picker silently
   * accepted whichever clinic the backend substituted. Two practices genuinely
   * can share a name in different cities, so that could point a household at a
   * different phone number on the record read in an emergency.
   */
  const RIVERSIDE_MATCH = {
    id: 'riverside',
    name: 'Riverside Animal Hospital',
    address: '418 Mill St',
    phone: '(512) 555-0100',
    isEmergency: false,
    verified: true,
    reason: 'name' as const,
  };
  const NEEDS_CHOICE = {
    status: 'needs_choice' as const,
    clinicId: '',
    created: false,
    pending: false,
    candidates: [RIVERSIDE_MATCH],
  };

  it('OFFERS the match instead of selecting it, and selects nothing yet', async () => {
    submitVetClinic.mockResolvedValue(NEEDS_CHOICE);
    const { onChange } = await openCreateForm('riverside animal hospital');
    await userEvent.click(screen.getByRole('button', { name: /^save clinic$/i }));

    expect(await screen.findByText(/already in the bank/i)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects the offered clinic when the operator picks it, with no second call', async () => {
    submitVetClinic.mockResolvedValue(NEEDS_CHOICE);
    const { onChange } = await openCreateForm('riverside animal hospital');
    await userEvent.click(screen.getByRole('button', { name: /^save clinic$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Riverside Animal Hospital/ }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ clinicId: 'riverside', name: 'Riverside Animal Hospital' }),
      ),
    );
    // Choosing an existing clinic is pure client-side: it already has the id.
    expect(submitVetClinic).toHaveBeenCalledTimes(1);
  });

  it('echoes the offered ids when the operator says it really is different', async () => {
    submitVetClinic.mockResolvedValueOnce(NEEDS_CHOICE).mockResolvedValueOnce({
      status: 'created',
      clinicId: 'new-3',
      created: true,
      pending: false,
      candidates: [],
    });

    await openCreateForm('riverside animal hospital');
    await userEvent.click(screen.getByRole('button', { name: /^save clinic$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /as a different clinic/i }));

    await waitFor(() => expect(submitVetClinic).toHaveBeenCalledTimes(2));
    // The echo is the evidence the operator saw the match; a boolean would not be.
    expect(submitVetClinic.mock.calls[1]?.[1]).toEqual(['riverside']);
  });

  it('fails loud when the create is rejected, and keeps the form filled in', async () => {
    submitVetClinic.mockRejectedValue(new Error('permission-denied'));
    const { onChange } = await openCreateForm();
    await userEvent.type(screen.getByLabelText('Clinic phone'), '(512) 555-0400');
    await userEvent.click(screen.getByRole('button', { name: /^save clinic$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'submitVetClinic failed: permission-denied',
    );
    expect(screen.getByLabelText('Clinic phone')).toHaveValue('(512) 555-0400');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('will not save a clinic with a blanked name', async () => {
    await openCreateForm();
    await userEvent.clear(screen.getByLabelText('Clinic name'));
    await userEvent.click(screen.getByRole('button', { name: /^save clinic$/i }));
    expect(await screen.findByText(/clinic name can't be blank/i)).toBeInTheDocument();
    expect(submitVetClinic).not.toHaveBeenCalled();
  });

  it('cancels back to the search without creating anything', async () => {
    const { onChange } = await openCreateForm();
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByLabelText('Clinic name')).not.toBeInTheDocument();
    expect(submitVetClinic).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('VetClinicPicker: emergency instance', () => {
  it('offers only emergency-flagged clinics when filtered', async () => {
    mount({ clinics: CATALOG.filter((c) => c.isEmergency === true), label: 'Emergency vet' });
    await userEvent.type(screen.getByLabelText('Emergency vet'), 'e');
    const names = screen.getAllByTestId('vetpick-option').map((el) => el.textContent);
    expect(names.join('|')).toContain('Austin Pet ER');
    expect(names.join('|')).not.toContain('Riverside');
  });

  it('defaults the create form emergency toggle ON for the emergency instance', async () => {
    mount({ clinics: [], label: 'Emergency vet', createAsEmergency: true });
    await userEvent.type(screen.getByLabelText('Emergency vet'), 'Night Owl');
    await userEvent.click(screen.getByRole('button', { name: /as a new vet clinic/ }));
    expect(screen.getByLabelText(/24 hour \/ emergency clinic/i)).toBeChecked();
  });
});

describe('VetClinicPicker: dropdown dismissal (same contract as TagAssignField)', () => {
  it('closes on Escape', async () => {
    mount();
    await userEvent.type(searchBox(), 'mill');
    expect(screen.getAllByTestId('vetpick-option').length).toBeGreaterThan(0);
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect(screen.queryAllByTestId('vetpick-option')).toHaveLength(0);
  });

  it('closes on an outside pointerdown', async () => {
    render(<button type="button">elsewhere</button>);
    mount();
    await userEvent.type(searchBox(), 'mill');
    expect(screen.getAllByTestId('vetpick-option').length).toBeGreaterThan(0);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryAllByTestId('vetpick-option')).toHaveLength(0);
  });

  it('a click on a suggestion still lands despite the blur close', async () => {
    const { onChange } = mount();
    await userEvent.type(searchBox(), 'riverside');
    // userEvent's click blurs the input first; the delayed close must not have
    // unmounted the option by then.
    await userEvent.click(screen.getByRole('button', { name: /Riverside Animal Hospital/ }));
    expect(onChange).toHaveBeenCalled();
  });
});
