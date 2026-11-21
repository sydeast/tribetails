// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { ToastProvider } from './Toast';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  access: { current: { status: 'admin' } as { status: string } | null },
}));
vi.mock('../api/addKinToUpcomingVisits', () => ({
  addKinToUpcomingVisits: (kinfolkId: string, kinId: string, apply: boolean) => mocks.add(kinfolkId, kinId, apply),
}));
vi.mock('../lib/access', () => ({ useAdminAccess: () => mocks.access.current }));

import { AddKinToUpcomingVisits, addKinToVisitsLabel, addedKinToVisitsLine } from './AddKinToUpcomingVisits';

function render(ui: ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

const answer = (upcoming: number, added = 0) => ({ kinId: 'pepper', kinName: 'Pepper', upcoming, added });

beforeEach(() => {
  mocks.add.mockReset();
  mocks.access.current = { status: 'admin' };
});

describe('the wording', () => {
  it('names the Kin and the count, and reads right for one visit', () => {
    expect(addKinToVisitsLabel('Pepper', 3)).toBe('Add Pepper to the 3 upcoming visits');
    expect(addKinToVisitsLabel('Pepper', 1)).toBe('Add Pepper to the upcoming visit');
    expect(addedKinToVisitsLine('Pepper', 3)).toBe('Added Pepper to 3 upcoming visits.');
    expect(addedKinToVisitsLine('Pepper', 1)).toBe('Added Pepper to 1 upcoming visit.');
  });
});

describe('AddKinToUpcomingVisits', () => {
  it('says it is checking while the count loads', async () => {
    mocks.add.mockReturnValue(new Promise(() => undefined));
    render(<AddKinToUpcomingVisits kinfolkId="kf1" kinId="pepper" kinName="Pepper" />);
    expect(screen.getByText('Checking upcoming visits…')).toBeTruthy();
  });

  it('asks first, then adds the Kin after the owner confirms, and says so', async () => {
    mocks.add.mockImplementation(async (_k: string, _id: string, apply: boolean) => (apply ? answer(3, 3) : answer(3)));
    render(<AddKinToUpcomingVisits kinfolkId="kf1" kinId="pepper" kinName="Pepper" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Add Pepper to the 3 upcoming visits' }));
    // Nothing is written until the owner confirms.
    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(mocks.add).toHaveBeenLastCalledWith('kf1', 'pepper', false);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/will be on the 3 upcoming visits already booked/)).toBeTruthy();

    mocks.add.mockImplementation(async (_k: string, _id: string, apply: boolean) => (apply ? answer(3, 3) : answer(0)));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Pepper' }));
    expect(mocks.add).toHaveBeenCalledWith('kf1', 'pepper', true);
    expect(await screen.findByText('Added Pepper to 3 upcoming visits.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('add-kin-to-visits')).toBeNull());
  });

  it('Cancel closes the confirm and writes nothing', async () => {
    mocks.add.mockResolvedValue(answer(2));
    render(<AddKinToUpcomingVisits kinfolkId="kf1" kinId="pepper" kinName="Pepper" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add Pepper to the 2 upcoming visits' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.add).not.toHaveBeenCalledWith('kf1', 'pepper', true);
  });

  it('keeps the confirm open with the reason when the add fails', async () => {
    mocks.add.mockImplementation(async (_k: string, _id: string, apply: boolean) => {
      if (apply) throw new Error('Only the owner can add a Kin to visits already booked.');
      return answer(2);
    });
    render(<AddKinToUpcomingVisits kinfolkId="kf1" kinId="pepper" kinName="Pepper" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add Pepper to the 2 upcoming visits' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Pepper' }));
    expect(await within(dialog).findByText('Only the owner can add a Kin to visits already booked.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('draws nothing when every upcoming visit already has the Kin', async () => {
    mocks.add.mockResolvedValue(answer(0));
    const { container } = render(<AddKinToUpcomingVisits kinfolkId="kf1" kinId="pepper" kinName="Pepper" />);
    await waitFor(() => expect(screen.queryByText('Checking upcoming visits…')).toBeNull());
    expect(container.querySelector('[data-testid="add-kin-to-visits"]')).toBeNull();
  });

  it('says the count could not be read, with Retry', async () => {
    mocks.add.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(answer(1));
    render(<AddKinToUpcomingVisits kinfolkId="kf1" kinId="pepper" kinName="Pepper" />);
    expect(await screen.findByText("Couldn't check upcoming visits")).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Add Pepper to the upcoming visit' })).toBeTruthy();
  });

  it('is never shown to an Auntie, and asks nothing for her', async () => {
    mocks.access.current = { status: 'caretaker' };
    const { container } = render(<AddKinToUpcomingVisits kinfolkId="kf1" kinId="pepper" kinName="Pepper" />);
    expect(container.textContent).toBe('');
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
