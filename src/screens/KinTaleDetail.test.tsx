// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type KinTaleEntry } from '../api/kinTales';
import { type Kin } from '../api/directory';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const {
  getKinTaleComments,
  addKinTaleComment,
  getKinTaleReaction,
  toggleKinTaleLove,
  getMyKinTaleMedia,
} = vi.hoisted(() => ({
  getKinTaleComments: vi.fn(),
  addKinTaleComment: vi.fn(),
  getKinTaleReaction: vi.fn(),
  toggleKinTaleLove: vi.fn(),
  getMyKinTaleMedia: vi.fn(),
}));
vi.mock('../api/kinTaleDetail', () => ({
  getKinTaleComments,
  addKinTaleComment,
  getKinTaleReaction,
  toggleKinTaleLove,
  getMyKinTaleMedia,
}));

import { KinTaleDetail } from './KinTaleDetail';

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
    title: 'A great day at the park',
    bodyCopy: 'Biscuit had a wonderful time at the park today.',
    mediaFileIds: [],
    status: 'SENT',
    sentAt: '2026-07-16T16:00:00.000Z',
    sentVia: 'email',
    createdAt: '2026-07-16T13:00:00.000Z',
    ...over,
  };
}

function kinRow(over: Partial<Kin> = {}): Kin {
  return {
    _id: 'pet1',
    kinfolkId: 'kf1',
    name: 'Biscuit',
    species: 'Dog',
    breed: 'Beagle',
    age: '4',
    sex: 'M',
    status: 'active',
    profilePictureUrl: '',
    updatedAt: null,
    ...over,
  };
}

const user = userEvent.setup();

function mockStreams(opts: { reports?: Async<KinTaleEntry[]>; kin?: Async<Kin[]> }) {
  const reportsState: Async<KinTaleEntry[]> = opts.reports ?? { status: 'ready', data: [report()] };
  const kinState: Async<Kin[]> = opts.kin ?? { status: 'ready', data: [kinRow()] };
  useCollection.mockImplementation((spec: { path: string }) =>
    spec.path === 'kin_care_reports' ? reportsState : kinState,
  );
}

beforeEach(() => {
  useCollection.mockReset();
  getKinTaleComments.mockReset().mockResolvedValue([]);
  addKinTaleComment.mockReset();
  getKinTaleReaction.mockReset().mockResolvedValue({ loved: false, loveCount: 0 });
  toggleKinTaleLove.mockReset();
  getMyKinTaleMedia.mockReset();
  mockStreams({});
});

describe('KinTaleDetail: report resolution', () => {
  it('shows an honest not-found message for an unknown kinTaleId, never a silent blank', async () => {
    mockStreams({ reports: { status: 'ready', data: [] } });
    render(<KinTaleDetail kinTaleId="ghost" onClose={vi.fn()} />);
    expect(await screen.findByText(/no kintale found/i)).toBeInTheDocument();
  });

  it('surfaces a report-stream error, never a false empty', async () => {
    mockStreams({ reports: { status: 'error', message: 'permission-denied' } });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
  });

  it('renders the household, title, body, and status chip once the report resolves', async () => {
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText('A great day at the park')).toBeInTheDocument();
    // Household name renders in BOTH "The tale" and "Who this covers", so
    // this asserts presence, not uniqueness.
    expect(screen.getAllByText('The Whitfields').length).toBeGreaterThan(0);
    expect(screen.getByText('Biscuit had a wonderful time at the park today.')).toBeInTheDocument();
    expect(screen.getByText('SENT')).toBeInTheDocument();
    expect(screen.getByText(/by auntie jo/i)).toBeInTheDocument();
    expect(screen.getByText(/sent via email/i)).toBeInTheDocument();
  });

  it('shows an honest "(empty body)" placeholder for a blank recap, never a fabricated summary', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ bodyCopy: '' })] } });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText('(empty body)')).toBeInTheDocument();
  });
});

describe('KinTaleDetail: who this covers (kin resolution)', () => {
  it('resolves a real kinId to its name + species off the already-streamed KIN_QUERY', async () => {
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText('Biscuit (Dog)')).toBeInTheDocument();
  });

  it('shows the raw kinId, never a fabricated name, when it does not resolve against the kin stream', async () => {
    mockStreams({ kin: { status: 'ready', data: [] } });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText('pet1')).toBeInTheDocument();
  });

  it('shows a proven-empty hint when the recap carries no kinIds at all', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ kinIds: [] })] } });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText(/no kin recorded on this recap/i)).toBeInTheDocument();
  });
});

describe('KinTaleDetail: photos', () => {
  it('renders no Photos panel and calls no media callable when mediaFileIds is empty', async () => {
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await screen.findByText('A great day at the park');
    expect(screen.queryByText('Photos')).toBeNull();
    expect(getMyKinTaleMedia).not.toHaveBeenCalled();
  });

  it('resolves media with BOTH taleId and kinfolkId (required, see api/kinTaleDetail.ts) once mediaFileIds is non-empty', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ mediaFileIds: ['m1'] })] } });
    getMyKinTaleMedia.mockResolvedValue([{ id: 'm1', url: 'https://cdn/img.jpg', contentType: 'image/jpeg' }]);
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await waitFor(() => expect(getMyKinTaleMedia).toHaveBeenCalledWith('tale1', 'kf1'));
    expect(await screen.findByAltText('KinTale attachment')).toBeInTheDocument();
  });

  it('surfaces a media load failure, never a false empty', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ mediaFileIds: ['m1'] })] } });
    getMyKinTaleMedia.mockRejectedValue(new Error('failed-precondition'));
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText(/failed-precondition/i)).toBeInTheDocument();
  });
});

describe('KinTaleDetail: reaction (love/react)', () => {
  it('loads the reaction and shows the honest summary + label', async () => {
    getKinTaleReaction.mockResolvedValue({ loved: false, loveCount: 2 });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /^love this$/i })).toBeInTheDocument();
    expect(screen.getByText('2 people loved this.')).toBeInTheDocument();
  });

  it('toggling calls toggleKinTaleLove and replaces state with the authoritative response', async () => {
    getKinTaleReaction.mockResolvedValue({ loved: false, loveCount: 0 });
    toggleKinTaleLove.mockResolvedValue({ loved: true, loveCount: 1 });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^love this$/i }));
    expect(toggleKinTaleLove).toHaveBeenCalledWith('tale1');
    expect(await screen.findByRole('button', { name: /^loved$/i })).toBeInTheDocument();
    expect(screen.getByText('You loved this.')).toBeInTheDocument();
  });

  it('fails loud, naming the reason, when toggleKinTaleLove rejects, and never guesses the new state', async () => {
    getKinTaleReaction.mockResolvedValue({ loved: false, loveCount: 0 });
    toggleKinTaleLove.mockRejectedValue(new Error('unavailable'));
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^love this$/i }));
    expect(await screen.findByText(/couldn't update your reaction: unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^love this$/i })).toBeInTheDocument();
  });
});

describe('KinTaleDetail: comment thread', () => {
  it('loads comments on mount and renders author label + local time + body', async () => {
    getKinTaleComments.mockResolvedValue([
      {
        id: 'c1',
        authorRole: 'kinfolk',
        authorUid: 'kf-uid',
        guestName: null,
        body: 'Thank you so much!',
        parentCommentId: null,
        createdAtMs: Date.parse('2026-07-16T19:32:00.000Z'),
      },
    ]);
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    expect(getKinTaleComments).toHaveBeenCalledWith('tale1');
    expect(await screen.findByText('Thank you so much!')).toBeInTheDocument();
    expect(screen.getByText('Kinfolk')).toBeInTheDocument();
  });

  it('shows a proven-empty hint when there are no comments yet', async () => {
    getKinTaleComments.mockResolvedValue([]);
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText(/no comments yet/i)).toBeInTheDocument();
  });

  it('surfaces a comment-load failure, never a false empty', async () => {
    getKinTaleComments.mockRejectedValue(new Error('permission-denied'));
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    // AsyncRegion's title uses a curly apostrophe (&rsquo;), matching the
    // Directory.test.tsx/Gallery.test.tsx `couldn.t load` convention.
    expect(await screen.findByText(/couldn.t load comments/i)).toBeInTheDocument();
  });

  it('disables Post comment until there is real (non-whitespace) content', async () => {
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    const postButton = await screen.findByRole('button', { name: /post comment/i });
    expect(postButton).toBeDisabled();
    const textarea = screen.getByLabelText(/add a comment/i);
    await user.type(textarea, '   ');
    expect(postButton).toBeDisabled();
    await user.type(textarea, 'Real content');
    expect(postButton).toBeEnabled();
  });

  it('posts via addKinTaleComment, then reloads the thread for the authoritative row', async () => {
    addKinTaleComment.mockResolvedValue('c2');
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await waitFor(() => expect(getKinTaleComments).toHaveBeenCalledTimes(1));
    const textarea = await screen.findByLabelText(/add a comment/i);
    await user.type(textarea, 'Glad to hear it!');
    await user.click(screen.getByRole('button', { name: /post comment/i }));

    await waitFor(() =>
      expect(addKinTaleComment).toHaveBeenCalledWith({ taleId: 'tale1', body: 'Glad to hear it!' }),
    );
    expect(await screen.findByText(/comment posted/i)).toBeInTheDocument();
    await waitFor(() => expect(getKinTaleComments).toHaveBeenCalledTimes(2));
    // The textarea clears once the post succeeds.
    expect((screen.getByLabelText(/add a comment/i) as HTMLTextAreaElement).value).toBe('');
  });

  it('fails loud, naming the reason, when addKinTaleComment rejects, and does not clear the draft', async () => {
    addKinTaleComment.mockRejectedValue(new Error('body cannot be whitespace-only'));
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    const textarea = await screen.findByLabelText(/add a comment/i);
    await user.type(textarea, 'Hello there');
    await user.click(screen.getByRole('button', { name: /post comment/i }));
    expect(await screen.findByText(/couldn't post comment: body cannot be whitespace-only/i)).toBeInTheDocument();
    expect((screen.getByLabelText(/add a comment/i) as HTMLTextAreaElement).value).toBe('Hello there');
  });
});

describe('KinTaleDetail: Edit / Close wiring', () => {
  it('renders no Edit control when onEdit is omitted (no live no-op, Buttons.tsx ControlShell convention)', async () => {
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await screen.findByText('A great day at the park');
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
  });

  it('calls onEdit with the report id when Edit is wired and clicked', async () => {
    const onEdit = vi.fn();
    render(<KinTaleDetail kinTaleId="tale1" onEdit={onEdit} onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledWith('tale1');
  });

  it('calls onClose when Close is clicked', async () => {
    const onClose = vi.fn();
    render(<KinTaleDetail kinTaleId="tale1" onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
