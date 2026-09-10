// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { getDossier } = vi.hoisted(() => ({ getDossier: vi.fn() }));
vi.mock('../api/recipientContext', async (orig) => ({
  ...(await orig<typeof import('../api/recipientContext')>()),
  getDossier,
}));

import { AuntieNotesPanel } from './AuntieNotesPanel';

function dossier(over: Record<string, string> = {}) {
  return {
    tldr: '',
    rawSummary: '',
    communicationStyle: '',
    householdNotes: '',
    relationshipWithAuntie: '',
    ...over,
  };
}

beforeEach(() => {
  getDossier.mockReset();
});

describe('AuntieNotesPanel', () => {
  it('is headed as admin only, because the dossier never leaves an admin surface', async () => {
    getDossier.mockResolvedValue(dossier({ tldr: 'Text when on the way.' }));
    render(<AuntieNotesPanel kinfolkId="k1" />);
    expect(await screen.findByText('Text when on the way.')).toBeInTheDocument();
    expect(screen.getByText('admin only')).toBeInTheDocument();
  });

  it('falls back to the raw summary when there is no tldr', async () => {
    getDossier.mockResolvedValue(dossier({ rawSummary: 'Long form summary.' }));
    render(<AuntieNotesPanel kinfolkId="k1" />);
    expect(await screen.findByText('Long form summary.')).toBeInTheDocument();
  });

  it('lists only the structured notes that are actually written', async () => {
    getDossier.mockResolvedValue(
      dossier({ householdNotes: 'Treats in the blue tin.', communicationStyle: '' }),
    );
    render(<AuntieNotesPanel kinfolkId="k1" />);
    expect(await screen.findByText('Treats in the blue tin.')).toBeInTheDocument();
    expect(screen.queryByText('Communication style')).toBeNull();
  });

  /**
   * #683, operator ruling: "Admin Notes should be pin to the bottom when
   * viewing the kinfolk IF notes exist". The minimal reading of "pin" is that
   * this panel does not render at all when there is nothing to pin, rather than
   * an empty band saying so.
   */
  it('renders nothing at all when the household has no dossier', async () => {
    getDossier.mockResolvedValue(null);
    const { container } = render(<AuntieNotesPanel kinfolkId="k1" />);
    await waitFor(() => expect(getDossier).toHaveBeenCalledWith('k1'));
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(screen.queryByText('Nothing written about this household yet.')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders nothing at all when every dossier field is blank, not "content"', async () => {
    getDossier.mockResolvedValue(dossier());
    const { container } = render(<AuntieNotesPanel kinfolkId="k1" />);
    await waitFor(() => expect(getDossier).toHaveBeenCalledWith('k1'));
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders nothing while the load is in flight, so the panel never flashes in then vanishes', () => {
    getDossier.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<AuntieNotesPanel kinfolkId="k1" />);
    expect(container.textContent).toBe('');
  });

  it('surfaces a failed read fail-loud rather than as an empty band', async () => {
    getDossier.mockRejectedValue(new Error('permission-denied'));
    render(<AuntieNotesPanel kinfolkId="k1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('permission-denied');
    expect(screen.queryByText('Nothing written about this household yet.')).toBeNull();
  });
});
