// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmergencyContactsCard } from './EmergencyContactsCard';

/**
 * The portal's Emergency Contacts card (#829). It reads and writes only through
 * `listEmergencyContacts` / `saveEmergencyContacts`; the old profile customFields
 * store is never touched from here.
 */

const mocks = vi.hoisted(() => ({ listEmergencyContacts: vi.fn(), saveEmergencyContacts: vi.fn() }));
vi.mock('../api/tribeApi', async () => {
  const actual = await vi.importActual<typeof import('../api/tribeApi')>('../api/tribeApi');
  return {
    ...actual,
    listEmergencyContacts: (...a: unknown[]) => mocks.listEmergencyContacts(...a),
    saveEmergencyContacts: (...a: unknown[]) => mocks.saveEmergencyContacts(...a),
  };
});

function mount(props: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <EmergencyContactsCard kinfolkId="kin-fam-1" {...props} />
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

const RAE = { name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister', recordedAt: null, updatedAt: null };
const LOCKED = 'Only someone with Home access can change the Emergency Contact.';
const WHO_GETS_CALLED = 'Called only when no kinfolk can be reached. The first one is called first.';

beforeEach(() => {
  mocks.listEmergencyContacts.mockReset();
  mocks.saveEmergencyContacts.mockReset().mockResolvedValue({ contacts: [RAE] });
});

describe('EmergencyContactsCard', () => {
  it('prompts a household with none, and saves the first contact through the callable', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [], canEdit: true, legacy: false });
    mount();
    expect(await screen.findByText('A household needs at least one Emergency Contact')).toBeInTheDocument();
    expect(mocks.listEmergencyContacts).toHaveBeenCalledWith('kin-fam-1');
    await userEvent.type(screen.getByLabelText('Name', { selector: '#ec-0-name' }), 'Rae Mercer');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#ec-0-phone' }), '805 555 0199');
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    await waitFor(() =>
      expect(mocks.saveEmergencyContacts).toHaveBeenCalledWith({
        kinfolkId: 'kin-fam-1',
        contacts: [{ name: 'Rae Mercer', phone: '805 555 0199', relationship: null }],
      }),
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('adds a second contact, moves it first, and clears a relationship', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: true, legacy: false });
    mount();
    await screen.findByDisplayValue('Rae Mercer');
    await userEvent.click(screen.getByRole('button', { name: 'Add a second Emergency Contact' }));
    await userEvent.type(screen.getByLabelText('Name', { selector: '#ec-1-name' }), 'Lee Park');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#ec-1-phone' }), '8055550177');
    await userEvent.click(screen.getByRole('button', { name: 'Call Lee Park first' }));
    await userEvent.clear(screen.getByLabelText('Relationship (optional)', { selector: '#ec-1-relationship' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    await waitFor(() => expect(mocks.saveEmergencyContacts).toHaveBeenCalledTimes(1));
    expect(mocks.saveEmergencyContacts.mock.calls[0]?.[0].contacts).toEqual([
      { name: 'Lee Park', phone: '8055550177', relationship: null },
      { name: 'Rae Mercer', phone: '+18055550199', relationship: null },
    ]);
  });

  it('removes the second contact, and never offers a third', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({
      contacts: [RAE, { name: 'Lee Park', phone: '+18055550177', relationship: null, recordedAt: null, updatedAt: null }],
      canEdit: true,
      legacy: false,
    });
    mount();
    await screen.findByDisplayValue('Lee Park');
    expect(screen.queryByRole('button', { name: 'Add a second Emergency Contact' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Emergency Contact 2' }));
    expect(screen.queryByDisplayValue('Lee Park')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    await waitFor(() => expect(mocks.saveEmergencyContacts).toHaveBeenCalledTimes(1));
    expect(mocks.saveEmergencyContacts.mock.calls[0]?.[0].contacts).toEqual([
      { name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister' },
    ]);
  });

  it('refuses to send an empty list, a missing phone, or the same phone twice', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [], canEdit: true, legacy: false });
    mount();
    await screen.findByLabelText('Name', { selector: '#ec-0-name' });
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A household needs at least one Emergency Contact');
    await userEvent.type(screen.getByLabelText('Name', { selector: '#ec-0-name' }), 'Rae Mercer');
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    expect(await screen.findByText('Each Emergency Contact needs a phone number.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#ec-0-phone' }), '(805) 555-0199');
    await userEvent.click(screen.getByRole('button', { name: 'Add a second Emergency Contact' }));
    await userEvent.type(screen.getByLabelText('Name', { selector: '#ec-1-name' }), 'Lee Park');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#ec-1-phone' }), '+1 805 555 0199');
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    expect(await screen.findByText('The two Emergency Contacts need different phone numbers.')).toBeInTheDocument();
    expect(mocks.saveEmergencyContacts).not.toHaveBeenCalled();
  });

  it('shows the server refusal verbatim and keeps what was typed', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: true, legacy: false });
    mocks.saveEmergencyContacts.mockRejectedValue(new Error('An Emergency Contact has to be someone outside the household.'));
    mount();
    const name = await screen.findByDisplayValue('Rae Mercer');
    await userEvent.clear(name);
    await userEvent.type(name, 'Dana Mercer');
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    expect(await screen.findByText('An Emergency Contact has to be someone outside the household.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name', { selector: '#ec-0-name' })).toHaveValue('Dana Mercer');
    expect(screen.getByRole('button', { name: 'Save Emergency Contacts' })).not.toBeDisabled();
  });

  it('shows a busy Save and locks the inputs while the save is in flight', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: true, legacy: false });
    let settle: (v: unknown) => void = () => undefined;
    mocks.saveEmergencyContacts.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    mount();
    await screen.findByDisplayValue('Rae Mercer');
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    const busy = await screen.findByRole('button', { name: /Saving/ });
    expect(busy).toBeDisabled();
    expect(screen.getByLabelText('Name', { selector: '#ec-0-name' })).toBeDisabled();
    settle({ contacts: [RAE] });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('without Home access: shows the contacts, says why they are locked, no inputs, no save', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: false, legacy: false });
    mount();
    expect(await screen.findByText('Rae Mercer')).toBeInTheDocument();
    expect(screen.getByText('+18055550199')).toBeInTheDocument();
    expect(screen.getByTestId('ec-locked')).toHaveTextContent(LOCKED);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Emergency Contacts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a second Emergency Contact' })).toBeNull();
  });

  it('without Home access and none on file: still prompts, and says who can add one', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [], canEdit: false, legacy: false });
    mount();
    expect(await screen.findByText('A household needs at least one Emergency Contact')).toBeInTheDocument();
    expect(screen.getByTestId('ec-locked')).toHaveTextContent(LOCKED);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('with Home access there is no lock line', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: true, legacy: false });
    mount();
    await screen.findByDisplayValue('Rae Mercer');
    expect(screen.queryByTestId('ec-locked')).toBeNull();
  });

  it('the info tip carries the same sentence as admin, and opens on a tap', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: false, legacy: false });
    mount();
    await screen.findByText('Rae Mercer');
    const tip = screen.getByRole('button', { name: 'Who gets called' });
    expect(tip).toHaveAttribute('title', WHO_GETS_CALLED);
    expect(tip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(WHO_GETS_CALLED)).toBeNull();
    await userEvent.click(tip);
    expect(tip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('tooltip')).toHaveTextContent(WHO_GETS_CALLED);
    await userEvent.click(tip);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a tap anywhere outside closes the tip (iOS Safari never blurs a tapped button), a tap on the tip does not', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: false, legacy: false });
    mount();
    await screen.findByText('Rae Mercer');
    const tip = screen.getByRole('button', { name: 'Who gets called' });
    await userEvent.click(tip);
    fireEvent.pointerDown(screen.getByRole('tooltip'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(WHO_GETS_CALLED);
    fireEvent.pointerDown(tip);
    expect(tip).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(tip).toHaveAttribute('aria-expanded', 'false');
  });

  it('marks unsaved edits, reports them to the page, and an edit after a save clears "Saved."', async () => {
    const onDirtyChange = vi.fn();
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: true, legacy: false });
    mount({ onDirtyChange });
    const name = await screen.findByDisplayValue('Rae Mercer');
    expect(screen.queryByTestId('ec-unsaved')).toBeNull();
    await userEvent.type(name, 'x');
    expect(screen.getByTestId('ec-unsaved')).toHaveTextContent('Unsaved changes');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.queryByTestId('ec-unsaved')).toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await userEvent.type(screen.getByLabelText('Name', { selector: '#ec-0-name' }), 'y');
    expect(screen.queryByText('Saved.')).toBeNull();
    expect(screen.getByTestId('ec-unsaved')).toBeInTheDocument();
  });

  it('adding or removing a slot is an unsaved change too', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: true, legacy: false });
    mount();
    await screen.findByDisplayValue('Rae Mercer');
    await userEvent.click(screen.getByRole('button', { name: 'Add a second Emergency Contact' }));
    expect(screen.getByTestId('ec-unsaved')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Emergency Contact 2' }));
    expect(screen.queryByTestId('ec-unsaved')).toBeNull();
  });

  it('a save writes the reply into the cache instead of refetching, and shows what the server stored', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [], canEdit: true, legacy: false });
    const stored = { ...RAE, phone: '+18055550100', relationship: null };
    mocks.saveEmergencyContacts.mockResolvedValue({ contacts: [stored] });
    const { qc } = mount();
    await userEvent.type(await screen.findByLabelText('Name', { selector: '#ec-0-name' }), 'Rae Mercer');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#ec-0-phone' }), '805 555 0100');
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.getByLabelText('Phone', { selector: '#ec-0-phone' })).toHaveValue('+18055550100');
    expect(qc.getQueryData(['emergencyContacts', 'kin-fam-1'])).toEqual({ contacts: [stored], canEdit: true, legacy: false });
    expect(mocks.listEmergencyContacts).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('A household needs at least one Emergency Contact')).toBeNull();
    expect(screen.queryByTestId('ec-unsaved')).toBeNull();
  });

  it('a background refetch never overwrites unsaved typing', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: true, legacy: false });
    const { qc } = mount();
    const name = await screen.findByDisplayValue('Rae Mercer');
    await userEvent.clear(name);
    await userEvent.type(name, 'Rae M');
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [{ ...RAE, name: 'Renamed Elsewhere' }], canEdit: true, legacy: false });
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['emergencyContacts', 'kin-fam-1'] });
    });
    expect(mocks.listEmergencyContacts).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Name', { selector: '#ec-0-name' })).toHaveValue('Rae M');
    expect(screen.getByTestId('ec-unsaved')).toBeInTheDocument();
  });

  it('a background refetch with no unsaved edits does show the newer copy', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: true, legacy: false });
    const { qc } = mount();
    await screen.findByDisplayValue('Rae Mercer');
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [{ ...RAE, name: 'Renamed Elsewhere' }], canEdit: true, legacy: false });
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['emergencyContacts', 'kin-fam-1'] });
    });
    expect(await screen.findByDisplayValue('Renamed Elsewhere')).toBeInTheDocument();
    expect(screen.queryByTestId('ec-unsaved')).toBeNull();
  });

  it('a load failure says so instead of drawing an empty household', async () => {
    mocks.listEmergencyContacts.mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText(/Couldn.t load your Emergency Contacts/)).toBeInTheDocument();
    expect(screen.queryByText('A household needs at least one Emergency Contact')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
