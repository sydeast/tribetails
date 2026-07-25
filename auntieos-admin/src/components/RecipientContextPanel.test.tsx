// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Async } from '../lib/async';
import type { Kin } from '../api/directory';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { getDossier, getKin411, recapRecentComms } = vi.hoisted(() => ({
  getDossier: vi.fn(),
  getKin411: vi.fn(),
  recapRecentComms: vi.fn(),
}));
vi.mock('../api/recipientContext', async (orig) => ({
  ...(await orig<typeof import('../api/recipientContext')>()),
  getDossier,
  getKin411,
  recapRecentComms,
}));

const { getFeatureFlags } = vi.hoisted(() => ({ getFeatureFlags: vi.fn() }));
vi.mock('../api/featureFlags', () => ({ getFeatureFlags }));

import { RecipientContextPanel } from './RecipientContextPanel';

// NOTE: mocks reset in setup(), called at the top of EACH test body rather than
// from a shared beforeEach, the deviation api/invoicesWrite.test.ts documents.

function kin(over: Partial<Kin> = {}): Kin {
  return { _id: 'kin1', kinfolkId: 'kf1', name: 'Nova', species: 'Dog', status: 'active', ...over } as Kin;
}

interface SetupOpts {
  kinRows?: Async<Kin[]>;
  comms?: Record<string, unknown>[];
  flagOn?: boolean;
}

function setup(opts: SetupOpts = {}) {
  useCollection.mockReset();
  getDossier.mockReset();
  getKin411.mockReset();
  recapRecentComms.mockReset();
  getFeatureFlags.mockReset();

  const kinRows: Async<Kin[]> = opts.kinRows ?? { status: 'ready', data: [kin()] };
  // First call is the kin list; the next four are the comms channels.
  useCollection.mockImplementation((spec: { path: string }) =>
    spec.path === 'kin'
      ? kinRows
      : { status: 'ready', data: (opts.comms ?? []).filter((c) => c['_path'] === spec.path) },
  );
  getDossier.mockResolvedValue(null);
  getKin411.mockResolvedValue(null);
  getFeatureFlags.mockResolvedValue({ 'auntieos.communicate.commsRecap': opts.flagOn ?? false });
  recapRecentComms.mockResolvedValue({ recap: '', lastAt: '', sourceCount: 0 });
  return userEvent.setup();
}

describe('with no recipient chosen', () => {
  it('says what picking one would show, rather than rendering an empty shell', () => {
    setup();
    render(<RecipientContextPanel kinfolkId="" />);
    expect(screen.getByText(/pick a recipient to see the dossier and kin/i)).toBeInTheDocument();
  });

  it('asks for no dossier and no recap when there is nobody to ask about', () => {
    setup();
    render(<RecipientContextPanel kinfolkId="" />);
    expect(getDossier).not.toHaveBeenCalled();
    expect(recapRecentComms).not.toHaveBeenCalled();
  });
});

describe('the dossier', () => {
  it('shows the reconciler’s summary line', async () => {
    setup();
    getDossier.mockResolvedValue({
      tldr: 'Prefers a text the night before.',
      rawSummary: 'much longer',
      communicationStyle: '',
      householdNotes: '',
      relationshipWithAuntie: '',
    });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText('Prefers a text the night before.')).toBeInTheDocument();
  });

  it('hides the "Not yet documented." placeholder rather than rendering it as context', async () => {
    setup();
    getDossier.mockResolvedValue({
      tldr: '',
      rawSummary: '',
      communicationStyle: 'Not yet documented.',
      householdNotes: '',
      relationshipWithAuntie: '',
    });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    await waitFor(() => expect(getDossier).toHaveBeenCalled());
    expect(screen.queryByText('Not yet documented.')).toBeNull();
  });

  it('says plainly when there is no dossier and no kin on file', async () => {
    setup({ kinRows: { status: 'ready', data: [] } });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText(/no saved dossier or kin on file yet/i)).toBeInTheDocument();
  });

  it('surfaces a dossier read failure instead of showing an empty dossier', async () => {
    setup();
    getDossier.mockImplementation(() => Promise.reject(new Error('permission-denied')));
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText(/permission-denied/)).toBeInTheDocument();
  });
});

describe('the kin cards', () => {
  it('lists each pet with its species and breed line', async () => {
    setup({ kinRows: { status: 'ready', data: [kin({ name: 'Nova', species: 'Dog', breed: 'Border Collie' })] } });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText('Nova')).toBeInTheDocument();
    expect(screen.getByText('Dog · Border Collie')).toBeInTheDocument();
  });

  it('shows only this household’s pets', async () => {
    setup({
      kinRows: {
        status: 'ready',
        data: [kin({ _id: 'k1', name: 'Nova', kinfolkId: 'kf1' }), kin({ _id: 'k2', name: 'Otis', kinfolkId: 'other' })],
      },
    });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText('Nova')).toBeInTheDocument();
    expect(screen.queryByText('Otis')).toBeNull();
  });

  it('never lists an archived pet', async () => {
    setup({
      kinRows: {
        status: 'ready',
        data: [kin({ _id: 'k1', name: 'Nova' }), kin({ _id: 'k2', name: 'Ghost', status: 'archived' })],
      },
    });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText('Nova')).toBeInTheDocument();
    expect(screen.queryByText('Ghost')).toBeNull();
  });

  it('fetches a pet’s 411 only when its card is opened, not for the whole list up front', async () => {
    const user = setup();
    render(<RecipientContextPanel kinfolkId="kf1" />);
    await screen.findByText('Nova');
    expect(getKin411).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /nova/i }));
    await waitFor(() => expect(getKin411).toHaveBeenCalledWith('kin1'));
  });

  it('shows the 411 summary once opened', async () => {
    const user = setup();
    getKin411.mockResolvedValue({
      tldr: 'Barks at skateboards, otherwise a gem.',
      rawSummary: '',
      breed: '',
      personality: '',
      quirksAndPreferences: '',
      medicalNotes: '',
      dietaryDetails: '',
    });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    await screen.findByText('Nova');
    await user.click(screen.getByRole('button', { name: /nova/i }));
    expect(await screen.findByText('Barks at skateboards, otherwise a gem.')).toBeInTheDocument();
  });

  it('says so in the card when a 411 read fails, without taking down the panel', async () => {
    const user = setup();
    getKin411.mockImplementation(() => Promise.reject(new Error('offline')));
    render(<RecipientContextPanel kinfolkId="kf1" />);
    await screen.findByText('Nova');
    await user.click(screen.getByRole('button', { name: /nova/i }));
    expect(await screen.findByText(/couldn.t load the 411: offline/i)).toBeInTheDocument();
    // The rest of the panel is still standing.
    expect(screen.getByText('Nova')).toBeInTheDocument();
  });

  it('says a pet has no 411 yet rather than leaving the opened card blank', async () => {
    const user = setup();
    getKin411.mockResolvedValue(null);
    render(<RecipientContextPanel kinfolkId="kf1" />);
    await screen.findByText('Nova');
    await user.click(screen.getByRole('button', { name: /nova/i }));
    expect(await screen.findByText(/no 411 on file for nova yet/i)).toBeInTheDocument();
  });
});

describe('the last-communication box', () => {
  const sms = { _path: 'sms_messages', _id: 's1', timestamp: '2026-07-09T10:00:00Z', body: 'Running ten late.' };

  it('shows the newest message across the channels when the recap flag is off', async () => {
    setup({ comms: [sms], flagOn: false });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText(/Running ten late\./)).toBeInTheDocument();
  });

  it('does not call the recap when the flag is off, so the flag actually gates the spend', async () => {
    setup({ comms: [sms], flagOn: false });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    await screen.findByText(/Running ten late\./);
    expect(recapRecentComms).not.toHaveBeenCalled();
  });

  it('shows no fallback disclosure when the flag is off, because nothing was promised', async () => {
    setup({ comms: [sms], flagOn: false });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    await screen.findByText(/Running ten late\./);
    expect(screen.queryByText(/AI recap unavailable/i)).toBeNull();
  });

  it('shows the AI recap when the flag is on and one came back', async () => {
    setup({ comms: [sms], flagOn: true });
    recapRecentComms.mockResolvedValue({ recap: 'They are asking about the long weekend.', lastAt: '', sourceCount: 3 });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText('They are asking about the long weekend.')).toBeInTheDocument();
    expect(screen.getByText(/where things last left off/i)).toBeInTheDocument();
  });

  it('DISCLOSES the fallback when the flag is on but the recap came back blank', async () => {
    setup({ comms: [sms], flagOn: true });
    recapRecentComms.mockResolvedValue({ recap: '   ', lastAt: '', sourceCount: 0 });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText(/Running ten late\./)).toBeInTheDocument();
    expect(screen.getByText(/showing the raw latest message \(no AI recap came back\)/i)).toBeInTheDocument();
  });

  it('names a recap failure and still shows the raw message', async () => {
    setup({ comms: [sms], flagOn: true });
    recapRecentComms.mockImplementation(() => Promise.reject(new Error('Admin only')));
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText(/AI recap unavailable \(Admin only\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Running ten late\./)).toBeInTheDocument();
  });

  it('says there are no messages rather than rendering a blank box', async () => {
    setup({ comms: [] });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText(/no messages on file yet/i)).toBeInTheDocument();
  });

  it('picks the newest across different channels, not merely the first collection', async () => {
    setup({
      comms: [
        sms,
        { _path: 'emails', _id: 'e1', timestamp: '2026-07-11T10:00:00Z', subject: 'Holiday plans' },
      ],
    });
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText(/Holiday plans/)).toBeInTheDocument();
    expect(screen.queryByText(/Running ten late\./)).toBeNull();
  });
});

describe('the panel’s own framing', () => {
  it('marks itself admin-only, since this is internal context and not client-facing copy', async () => {
    setup();
    render(<RecipientContextPanel kinfolkId="kf1" />);
    expect(await screen.findByText(/admin only/i)).toBeInTheDocument();
  });
});
