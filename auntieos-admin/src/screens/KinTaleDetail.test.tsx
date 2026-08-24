// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  createShareLink,
} = vi.hoisted(() => ({
  getKinTaleComments: vi.fn(),
  addKinTaleComment: vi.fn(),
  getKinTaleReaction: vi.fn(),
  toggleKinTaleLove: vi.fn(),
  getMyKinTaleMedia: vi.fn(),
  createShareLink: vi.fn(),
}));
vi.mock('../api/kinTaleDetail', () => ({
  getKinTaleComments,
  addKinTaleComment,
  getKinTaleReaction,
  toggleKinTaleLove,
  getMyKinTaleMedia,
  createShareLink,
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

/** Installs a `navigator.clipboard.writeText` the copy affordance can call, and hands it back for assertions. */
function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

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
  createShareLink.mockReset();
  // jsdom ships no navigator.clipboard, and userEvent.setup() installs its own
  // getter-only stand-in, so this has to be defined, not assigned. Re-installed
  // per test so the "clipboard denied" case below can swap in a rejecting one.
  stubClipboard(vi.fn().mockResolvedValue(undefined));
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

/**
 * Issue #397 S4. The share-link callable has been deployed the whole time
 * (`functions/src/index.ts` exports `createShareLink`); only this screen's
 * wiring to it was missing.
 */
describe('KinTaleDetail: share link', () => {
  it('mints a link for the open report and shows the url the server returned', async () => {
    createShareLink.mockResolvedValue({ shareId: 's1', shareUrl: 'https://share.example/s1' });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /share link/i }));
    expect(createShareLink).toHaveBeenCalledWith('tale1', 'kf1', true);
    expect(await screen.findByLabelText('Share link')).toHaveValue('https://share.example/s1');
  });

  it('copies the url and says so', async () => {
    createShareLink.mockResolvedValue({ shareId: 's1', shareUrl: 'https://share.example/s1' });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /share link/i }));
    await user.click(await screen.findByRole('button', { name: /^copy link$/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://share.example/s1');
    expect(await screen.findByRole('button', { name: /^copied$/i })).toBeInTheDocument();
  });

  it('keeps the url on screen when the clipboard is denied: the operator can still select it', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    createShareLink.mockResolvedValue({ shareId: 's1', shareUrl: 'https://share.example/s1' });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /share link/i }));
    await user.click(await screen.findByRole('button', { name: /^copy link$/i }));
    expect(await screen.findByLabelText('Share link')).toHaveValue('https://share.example/s1');
    expect(screen.getByRole('button', { name: /^copy link$/i })).toBeInTheDocument();
  });

  it('refuses a draft before calling out, and says what to do about it', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ status: 'DRAFT', sentVia: '' })] } });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /share link/i }));
    expect(createShareLink).not.toHaveBeenCalled();
    expect(await screen.findByText(/send this kintale first/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Share link')).toBeNull();
  });

  it('refuses a report with no household to route the link to', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ kinfolkId: '' })] } });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /share link/i }));
    expect(createShareLink).not.toHaveBeenCalled();
    expect(await screen.findByText(/no kinfolk to route the link to/i)).toBeInTheDocument();
  });

  it('fails loud, naming the reason, when the callable rejects, and shows no url', async () => {
    createShareLink.mockRejectedValue(new Error('not-found'));
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /share link/i }));
    expect(await screen.findByText(/couldn't create a share link: not-found/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Share link')).toBeNull();
  });
});

/**
 * Issue #397 S5. STANDING RULING: dossiers and 411 notes are admin-only and a
 * kinfolk never sees either, so the preview renders the headline, the narrative
 * and the photos and nothing else, matching Android's `KinfolkPreview` and the
 * scrubbed payload `share/createShareLink.ts` writes.
 */
describe('KinTaleDetail: view as kinfolk', () => {
  it('renders no preview until the operator asks for one', async () => {
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await screen.findByText('A great day at the park');
    expect(screen.queryByRole('region', { name: 'Kinfolk view' })).toBeNull();
  });

  it('shows the headline and narrative a kinfolk would read, and toggles back off', async () => {
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /view as kinfolk/i }));
    const preview = screen.getByRole('region', { name: 'Kinfolk view' });
    expect(within(preview).getByText('A great day at the park')).toBeInTheDocument();
    expect(within(preview).getByText('Biscuit had a wonderful time at the park today.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /hide kinfolk view/i }));
    expect(screen.queryByRole('region', { name: 'Kinfolk view' })).toBeNull();
  });

  it('falls back to the cover line for an untitled report rather than an empty heading', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ title: '' })] } });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /view as kinfolk/i }));
    const preview = screen.getByRole('region', { name: 'Kinfolk view' });
    expect(within(preview).getByText('From Auntie Jo for The Whitfields')).toBeInTheDocument();
  });

  it('says plainly that nothing was written rather than inventing a narrative', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ bodyCopy: '' })] } });
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /view as kinfolk/i }));
    const preview = screen.getByRole('region', { name: 'Kinfolk view' });
    expect(within(preview).getByText('No narrative was written for this visit.')).toBeInTheDocument();
  });

  it('carries the photos through', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ mediaFileIds: ['m1'] })] } });
    getMyKinTaleMedia.mockResolvedValue([{ id: 'm1', url: 'https://cdn/img.jpg', contentType: 'image/jpeg' }]);
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /view as kinfolk/i }));
    const preview = screen.getByRole('region', { name: 'Kinfolk view' });
    await waitFor(() => expect(within(preview).getByAltText('KinTale attachment')).toBeInTheDocument());
  });

  it('leaks no admin-only material: no session id, no delivery channel, no admin control inside the preview', async () => {
    render(<KinTaleDetail kinTaleId="tale1" onEdit={vi.fn()} onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /view as kinfolk/i }));
    const preview = screen.getByRole('region', { name: 'Kinfolk view' });
    expect(within(preview).queryByText('sess1')).toBeNull();
    expect(within(preview).queryByText(/sent via/i)).toBeNull();
    expect(within(preview).queryByRole('button')).toBeNull();
    // The screen reads a report, its comments, its reaction and its photos.
    // There is no dossier or 411 read anywhere on it to leak.
    expect(within(preview).queryByText(/dossier/i)).toBeNull();
    expect(within(preview).queryByText(/411/)).toBeNull();
  });
});

/**
 * Issue #397 S6. `addKinTaleComment` has always accepted `parentCommentId`;
 * this screen finally sends one.
 */
describe('KinTaleDetail: replying to one comment', () => {
  const thread = [
    {
      id: 'c1',
      authorRole: 'kinfolk',
      authorUid: 'kf-uid',
      guestName: null,
      body: 'Thank you so much!',
      parentCommentId: null,
      createdAtMs: Date.parse('2026-07-16T19:32:00.000Z'),
    },
    {
      id: 'c2',
      authorRole: 'admin',
      authorUid: 'admin-uid',
      guestName: null,
      body: 'Our pleasure.',
      parentCommentId: 'c1',
      createdAtMs: Date.parse('2026-07-16T19:40:00.000Z'),
    },
  ];

  it('renders a reply under its parent, marked as a reply', async () => {
    getKinTaleComments.mockResolvedValue(thread);
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await screen.findByText('Thank you so much!');
    // The nesting is carried by the row's own state attribute, not by a CSS
    // indent jsdom cannot see.
    const rows = document.querySelectorAll('.kintale-detail__comment-row');
    expect([...rows].map((r) => r.getAttribute('data-reply'))).toEqual(['false', 'true']);
    expect(rows[1]?.textContent).toContain('Our pleasure.');
  });

  it('still renders a reply whose parent is gone, rather than dropping the comment', async () => {
    getKinTaleComments.mockResolvedValue([{ ...thread[1], parentCommentId: 'deleted' }]);
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText('Our pleasure.')).toBeInTheDocument();
    expect(document.querySelector('.kintale-detail__comment-row')?.getAttribute('data-reply')).toBe('false');
  });

  it('naming a reply target renames the compose box and the post action, and says who is being answered', async () => {
    getKinTaleComments.mockResolvedValue([thread[0]]);
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^reply$/i }));
    expect(await screen.findByText('Replying to Kinfolk.')).toBeInTheDocument();
    expect(screen.getByLabelText(/your reply/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /post reply/i })).toBeInTheDocument();
    // The targeted row and the compose box both carry the target as state, so
    // which comment is being answered survives a re-render.
    expect(document.querySelector('.kintale-detail__comment-row')).toHaveAttribute('data-reply-target', 'true');
    expect(document.querySelector('.kintale-detail__add-comment')).toHaveAttribute('data-replying-to', 'c1');
  });

  it('sends parentCommentId, then returns the box to top-level composing', async () => {
    getKinTaleComments.mockResolvedValue([thread[0]]);
    addKinTaleComment.mockResolvedValue('c9');
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^reply$/i }));
    await user.type(screen.getByLabelText(/your reply/i), 'Any time.');
    await user.click(screen.getByRole('button', { name: /post reply/i }));

    await waitFor(() =>
      expect(addKinTaleComment).toHaveBeenCalledWith({
        taleId: 'tale1',
        body: 'Any time.',
        parentCommentId: 'c1',
      }),
    );
    expect(await screen.findByText(/reply posted/i)).toBeInTheDocument();
    expect(await screen.findByLabelText(/add a comment/i)).toBeInTheDocument();
    expect(screen.queryByText('Replying to Kinfolk.')).toBeNull();
  });

  it('cancelling a reply returns to a top-level comment without posting anything', async () => {
    getKinTaleComments.mockResolvedValue([thread[0]]);
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /^reply$/i }));
    await user.click(screen.getByRole('button', { name: /cancel reply/i }));
    expect(screen.getByLabelText(/add a comment/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /post comment/i })).toBeInTheDocument();
    expect(addKinTaleComment).not.toHaveBeenCalled();
  });

  it('posts at the root when no reply target is named', async () => {
    getKinTaleComments.mockResolvedValue([thread[0]]);
    addKinTaleComment.mockResolvedValue('c9');
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    await user.type(await screen.findByLabelText(/add a comment/i), 'Glad to hear it!');
    await user.click(screen.getByRole('button', { name: /post comment/i }));
    await waitFor(() =>
      expect(addKinTaleComment).toHaveBeenCalledWith({ taleId: 'tale1', body: 'Glad to hear it!' }),
    );
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

/**
 * Item 7b. The kicker here read "THE DEN · KINTALES" and so did the list's, so
 * it could not tell an operator which of the two they had open.
 */
describe('KinTaleDetail: breadcrumbs', () => {
  it('names this report as the current page under a KinTales step', async () => {
    render(<KinTaleDetail kinTaleId="tale1" onClose={vi.fn()} />);
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('KinTale detail')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText(/The Den/i)).not.toBeInTheDocument();
  });
  /**
   * `onClose`, not a link to /kintales: closing also drops `?kinTaleId=` from
   * the URL, and a plain route link would leave it naming a report the operator
   * has just walked away from, so a reload would reopen it.
   */
  it('walks back to the feed the same way Close does', async () => {
    const onClose = vi.fn();
    render(<KinTaleDetail kinTaleId="tale1" onClose={onClose} />);
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await user.click(within(nav).getByRole('button', { name: 'KinTales' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
