// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type KinTaleEntry } from '../api/kinTales';
import { type SessionEntry } from '../api/sessions';
import { type KinTaleDraft } from '../api/kinTalesWrite';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { saveKinTaleDraft, sendKinTale } = vi.hoisted(() => ({
  saveKinTaleDraft: vi.fn(),
  sendKinTale: vi.fn(),
}));
vi.mock('../api/kinTalesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/kinTalesWrite')>()),
  saveKinTaleDraft,
  sendKinTale,
}));

import {
  KinTaleCompose,
  isKinTaleEligibleSession,
  kinTaleSendLabel,
  scaffoldKinTaleDraft,
  draftFromKinTaleEntry,
} from './KinTaleCompose';

function report(over: Partial<KinTaleEntry> = {}): KinTaleEntry {
  return {
    _id: 'tale1',
    sessionId: 'sess1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    authorDisplayName: 'Auntie Jo',
    kinIds: ['pet1'],
    serviceType: 'Dog Walk',
    visitDate: '2026-07-16T14:00:00.000Z',
    arrivedAt: '2026-07-16T14:05:00.000Z',
    title: '',
    bodyCopy: 'Biscuit had a wonderful time at the park today.',
    mediaFileIds: [],
    status: 'DRAFT',
    sentAt: '',
    sentVia: '',
    createdAt: '2026-07-16T13:00:00.000Z',
    ...over,
  };
}

function session(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    _id: 'sess1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    kinIds: ['pet1'],
    serviceType: 'Dog Walk',
    startTime: '2026-07-16T14:00:00.000Z',
    arrivedAt: '2026-07-16T14:05:00.000Z',
    endTime: '2026-07-16T15:00:00.000Z',
    status: 'DEPARTED',
    completedAt: '',
    notes: '',
    ...over,
  };
}

const user = userEvent.setup();

function mockStreams(opts: {
  reports?: Async<KinTaleEntry[]>;
  sessions?: Async<SessionEntry[]>;
}) {
  const reportsState: Async<KinTaleEntry[]> = opts.reports ?? { status: 'ready', data: [] };
  const sessionsState: Async<SessionEntry[]> = opts.sessions ?? { status: 'ready', data: [] };
  useCollection.mockImplementation((spec: { path: string }) =>
    spec.path === 'kin_care_reports' ? reportsState : sessionsState,
  );
}

beforeEach(() => {
  useCollection.mockReset();
  saveKinTaleDraft.mockReset();
  sendKinTale.mockReset();
  mockStreams({});
});

describe('isKinTaleEligibleSession (pure)', () => {
  it('is true only for departed/completed, never the other four states', () => {
    expect(isKinTaleEligibleSession('DEPARTED')).toBe(true);
    expect(isKinTaleEligibleSession('COMPLETED')).toBe(true);
    expect(isKinTaleEligibleSession('SCHEDULED')).toBe(false);
    expect(isKinTaleEligibleSession('ON_MY_WAY')).toBe(false);
    expect(isKinTaleEligibleSession('ARRIVED')).toBe(false);
    expect(isKinTaleEligibleSession('CANCELLED')).toBe(false);
  });
});

describe('kinTaleSendLabel (pure)', () => {
  it('names the real recipient', () => {
    expect(kinTaleSendLabel('The Whitfields')).toBe('Send to The Whitfields');
  });

  it('falls back to neutral copy when blank, never a fabricated household', () => {
    expect(kinTaleSendLabel('  ')).toBe('Send KinTale');
  });
});

describe('scaffoldKinTaleDraft / draftFromKinTaleEntry (pure)', () => {
  it('scaffolds a blank new draft off a session', () => {
    const draft = scaffoldKinTaleDraft(session());
    expect(draft).toEqual<KinTaleDraft>({
      sessionId: 'sess1',
      kinfolkId: 'kf1',
      kinfolkName: 'The Whitfields',
      kinIds: ['pet1'],
      serviceType: 'Dog Walk',
      visitDate: '2026-07-16T14:00:00.000Z',
      arrivedAt: '2026-07-16T14:05:00.000Z',
      title: '',
      bodyCopy: '',
      mediaFileIds: [],
    });
  });

  it('rehydrates an editable draft off an existing report, carrying its _id', () => {
    const draft = draftFromKinTaleEntry(report({ title: 'A great day', mediaFileIds: ['m1'] }));
    expect(draft._id).toBe('tale1');
    expect(draft.title).toBe('A great day');
    expect(draft.mediaFileIds).toEqual(['m1']);
  });
});

describe('KinTaleCompose: session picker (no kinTaleId/sessionId given)', () => {
  it('lists only DEPARTED/COMPLETED sessions, never one still in flight', async () => {
    mockStreams({
      sessions: {
        status: 'ready',
        data: [
          session({ _id: 'a', kinfolkName: 'Household A', status: 'DEPARTED' }),
          session({ _id: 'b', kinfolkName: 'Household B', status: 'SCHEDULED' }),
          session({ _id: 'c', kinfolkName: 'Household C', status: 'COMPLETED' }),
        ],
      },
    });
    render(<KinTaleCompose onClose={vi.fn()} />);
    expect(await screen.findByText('Household A')).toBeInTheDocument();
    expect(screen.getByText('Household C')).toBeInTheDocument();
    expect(screen.queryByText('Household B')).toBeNull();
  });

  it('shows the proven-empty hint when nothing is eligible yet', async () => {
    mockStreams({ sessions: { status: 'ready', data: [session({ status: 'SCHEDULED' })] } });
    render(<KinTaleCompose onClose={vi.fn()} />);
    expect(await screen.findByText(/no departed or completed sessions yet/i)).toBeInTheDocument();
  });

  it('picking a session moves straight into the compose form', async () => {
    mockStreams({ sessions: { status: 'ready', data: [session({ kinfolkName: 'The Alvarez Household' })] } });
    render(<KinTaleCompose onClose={vi.fn()} />);
    await user.click(await screen.findByText('The Alvarez Household'));
    expect(await screen.findByLabelText(/headline/i)).toBeInTheDocument();
  });
});

describe('KinTaleCompose: NEW from a given sessionId', () => {
  it('scaffolds the form from the session (household, service shown read-only)', async () => {
    mockStreams({ sessions: { status: 'ready', data: [session({})] } });
    render(<KinTaleCompose sessionId="sess1" onClose={vi.fn()} />);
    expect(await screen.findByLabelText(/headline/i)).toBeInTheDocument();
    expect(screen.getByText('The Whitfields')).toBeInTheDocument();
    expect(screen.getByText('Dog Walk')).toBeInTheDocument();
  });

  it('shows an honest not-found message for an unknown sessionId, never a silent blank', async () => {
    mockStreams({ sessions: { status: 'ready', data: [] } });
    render(<KinTaleCompose sessionId="ghost" onClose={vi.fn()} />);
    expect(await screen.findByText(/no kin care session found/i)).toBeInTheDocument();
  });
});

describe('KinTaleCompose: EDIT an existing report', () => {
  it('loads the existing title/body into the form', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ title: 'A great day at the park' })] } });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByDisplayValue('A great day at the park')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Biscuit had a wonderful time at the park today.')).toBeInTheDocument();
  });

  it('shows an honest not-found message for an unknown kinTaleId', async () => {
    mockStreams({ reports: { status: 'ready', data: [] } });
    render(<KinTaleCompose kinTaleId="ghost" onClose={vi.fn()} />);
    expect(await screen.findByText(/no kintale found/i)).toBeInTheDocument();
  });

  it('surfaces a listener error, never a false empty', async () => {
    mockStreams({ reports: { status: 'error', message: 'permission-denied' } });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
  });
});

describe('KinTaleCompose: Save Draft', () => {
  it('saves via saveKinTaleDraft and shows a success banner', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ title: 'Hi' })] } });
    saveKinTaleDraft.mockResolvedValue('tale1');
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    await screen.findByDisplayValue('Hi');
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(saveKinTaleDraft).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/draft saved/i)).toBeInTheDocument();
  });

  it('reflects an edit before saving (controlled headline input)', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ title: '' })] } });
    saveKinTaleDraft.mockResolvedValue('tale1');
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    const input = await screen.findByLabelText(/headline/i);
    await user.type(input, 'New headline');
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(saveKinTaleDraft).toHaveBeenCalledWith(expect.objectContaining({ title: 'New headline' })));
  });

  it('fails loud, naming the reason, when saveKinTaleDraft rejects', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ title: 'Hi' })] } });
    saveKinTaleDraft.mockRejectedValue(new Error('offline'));
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    await screen.findByDisplayValue('Hi');
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    expect(await screen.findByText(/couldn't save draft: offline/i)).toBeInTheDocument();
  });
});

describe('KinTaleCompose: Send, gated behind a confirm dialog', () => {
  it('disables Send until there is real content', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ title: '', bodyCopy: '', mediaFileIds: [] })] } });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    await screen.findByLabelText(/headline/i);
    expect(screen.getByRole('button', { name: /send to the whitfields/i })).toBeDisabled();
    expect(screen.getByText(/add a headline, some notes, or a photo to enable send/i)).toBeInTheDocument();
  });

  it('clicking Send opens a confirm dialog rather than sending immediately', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ title: 'Hi' })] } });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /send to the whitfields/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(sendKinTale).not.toHaveBeenCalled();
  });

  it('confirming Send saves then sends, then closes the compose screen', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ title: 'Hi' })] } });
    saveKinTaleDraft.mockResolvedValue('tale1');
    sendKinTale.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<KinTaleCompose kinTaleId="tale1" onClose={onClose} />);
    await user.click(await screen.findByRole('button', { name: /send to the whitfields/i }));
    await user.click(screen.getByRole('button', { name: /^send kintale$/i }));

    await waitFor(() => expect(saveKinTaleDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sendKinTale).toHaveBeenCalledWith({ reportId: 'tale1', sessionId: 'sess1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('cancelling the confirm dialog never calls sendKinTale', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ title: 'Hi' })] } });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /send to the whitfields/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sendKinTale).not.toHaveBeenCalled();
  });

  it('fails loud, naming the reason, when sendKinTale rejects, and does not close the screen', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ title: 'Hi' })] } });
    saveKinTaleDraft.mockResolvedValue('tale1');
    sendKinTale.mockRejectedValue(new Error('unavailable'));
    const onClose = vi.fn();
    render(<KinTaleCompose kinTaleId="tale1" onClose={onClose} />);
    await user.click(await screen.findByRole('button', { name: /send to the whitfields/i }));
    await user.click(screen.getByRole('button', { name: /^send kintale$/i }));
    expect(await screen.findByText(/couldn't send: unavailable/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('KinTaleCompose: Close', () => {
  it('calls onClose when Close is clicked', async () => {
    const onClose = vi.fn();
    mockStreams({ sessions: { status: 'ready', data: [] } });
    render(<KinTaleCompose onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
