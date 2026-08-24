// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

  it('says nothing is written yet when the household has no dossier', async () => {
    getDossier.mockResolvedValue(null);
    render(<AuntieNotesPanel kinfolkId="k1" />);
    expect(await screen.findByText('Nothing written about this household yet.')).toBeInTheDocument();
  });

  it('treats an all-blank dossier as nothing written, not as content', async () => {
    getDossier.mockResolvedValue(dossier());
    render(<AuntieNotesPanel kinfolkId="k1" />);
    expect(await screen.findByText('Nothing written about this household yet.')).toBeInTheDocument();
  });

  it('surfaces a failed read fail-loud rather than as an empty band', async () => {
    getDossier.mockRejectedValue(new Error('permission-denied'));
    render(<AuntieNotesPanel kinfolkId="k1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('permission-denied');
    expect(screen.queryByText('Nothing written about this household yet.')).toBeNull();
  });
});
