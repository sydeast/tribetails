// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../components/Toast';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type KinTaleEntry } from '../api/kinTales';
import { type SessionEntry } from '../api/sessions';
import { type KinTaleDraft } from '../api/kinTalesWrite';

/**
 * The composer raises a toast on save and on generate, and useToast throws
 * outside its provider on purpose (a swallowed confirmation is indistinguishable
 * from a save that never happened). Rendering the real provider here keeps these
 * tests exercising the tree the app actually mounts.
 */
function render(ui: React.ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}
const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

const { saveKinTaleDraft, sendKinTale } = vi.hoisted(() => ({
  saveKinTaleDraft: vi.fn(),
  sendKinTale: vi.fn(),
}));
const { generateDraft } = vi.hoisted(() => ({ generateDraft: vi.fn() }));
vi.mock('../api/communicateGenerate', async (orig) => ({
  ...(await orig<typeof import('../api/communicateGenerate')>()),
  generateDraft,
}));
vi.mock('../api/kinTalesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/kinTalesWrite')>()),
  saveKinTaleDraft,
  sendKinTale,
}));

/**
 * The composer's one-shot reads. Mocked at the API seam rather than at
 * `firebase/firestore`, so the real decode/defaulting in each module stays
 * under test everywhere else and only the network hop is replaced here.
 */
const { getKin } = vi.hoisted(() => ({ getKin: vi.fn() }));
vi.mock('../api/kinView', async (orig) => ({
  ...(await orig<typeof import('../api/kinView')>()),
  getKin,
}));
const { getKinfolkProfile } = vi.hoisted(() => ({ getKinfolkProfile: vi.fn() }));
vi.mock('../api/kinfolkProfile', async (orig) => ({
  ...(await orig<typeof import('../api/kinfolkProfile')>()),
  getKinfolkProfile,
}));
const { getMediaFilesByIds } = vi.hoisted(() => ({ getMediaFilesByIds: vi.fn() }));
vi.mock('../api/gallery', async (orig) => ({
  ...(await orig<typeof import('../api/gallery')>()),
  getMediaFilesByIds,
}));
/**
 * The upload orchestrator behind `MediaUploadDialog`. Mocking it and NOT the
 * dialog keeps the dialog's own validation, staging and the `entityType` /
 * `entityId` it passes under test, which is the half of the photo path this
 * screen is actually responsible for getting right.
 */
const { uploadMediaFile } = vi.hoisted(() => ({ uploadMediaFile: vi.fn() }));
vi.mock('../api/mediaUpload', async (orig) => ({
  ...(await orig<typeof import('../api/mediaUpload')>()),
  uploadMediaFile,
}));

import { decodeKinTaleTemplate } from '../api/kinTaleTemplates';
import { DEFAULT_KINTALE_TEMPLATE } from '../lib/kinTale/model';
import {
  KinTaleCompose,
  isKinTaleEligibleSession,
  kinTaleSendLabel,
  scaffoldKinTaleDraft,
  draftFromKinTaleEntry,
  pickableSessions,
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
    titleGeneratedByAi: false,
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
  /** Raw `kintale_templates` docs; the screen decodes them itself. */
  templates?: Async<Record<string, unknown>[]>;
}) {
  const reportsState: Async<KinTaleEntry[]> = opts.reports ?? { status: 'ready', data: [] };
  const sessionsState: Async<SessionEntry[]> = opts.sessions ?? { status: 'ready', data: [] };
  const templatesState: Async<Record<string, unknown>[]> = opts.templates ?? { status: 'ready', data: [] };
  // Dispatch by PATH, never by call order: the screen holds three listeners and
  // the order it opens them in is not a contract any test should depend on.
  useCollection.mockImplementation((spec: { path: string }) => {
    if (spec.path === 'kin_care_reports') return reportsState;
    if (spec.path === 'kintale_templates') return templatesState;
    return sessionsState;
  });
}

beforeEach(() => {
  useCollection.mockReset();
  saveKinTaleDraft.mockReset();
  sendKinTale.mockReset();
  // A pet with no medication notes and no species quirks: every conditional
  // item in the built-in template is withheld from it unless a test says
  // otherwise, so a suite that never mentions the checklist sees a stable one.
  getKin.mockReset().mockImplementation((id: string) =>
    Promise.resolve({ ...BLANK_KIN, _id: id, name: id === 'pet1' ? 'Biscuit' : id }),
  );
  getKinfolkProfile.mockReset().mockResolvedValue(null);
  getMediaFilesByIds.mockReset().mockResolvedValue([]);
  uploadMediaFile.mockReset();
  mockStreams({});
});
/** Enough of a `KinDetail` for the condition engine; every attribute blank. */
const BLANK_KIN = {
  _id: 'pet1',
  name: 'Biscuit',
  species: 'Dog',
  breed: '',
  colorMarkings: '',
  medicationHealthNotes: '',
  vaccinations: '',
  vetInfo: '',
  feedingBrand: '',
  trainingCommands: '',
  routine: '',
  checklist: '',
  officeNotes: '',
  reactive: false,
  spayedNeutered: false,
} as unknown as import('../api/kinView').KinDetail;

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
  it('scaffolds a blank new draft off a session, stamping the template it resolved', () => {
    const draft = scaffoldKinTaleDraft(session(), decodeKinTaleTemplate({ _id: 'tpl_walk', name: 'Walks' }));
    expect(draft).toEqual<KinTaleDraft>({
      sessionId: 'sess1',
      kinfolkId: 'kf1',
      kinfolkName: 'The Whitfields',
      kinIds: ['pet1'],
      serviceType: 'Dog Walk',
      visitDate: '2026-07-16T14:00:00.000Z',
      arrivedAt: '2026-07-16T14:05:00.000Z',
      title: '',
      titleGeneratedByAi: false,
      bodyCopy: '',
      mediaFileIds: [],
      templateId: 'tpl_walk',
      fieldResponses: {},
    });
  });
  /**
   * The built-in default's sentinel id must never reach Firestore: the portal
   * reads a BLANK `templateId` as "use the built-in", and would fail to resolve
   * a template document called `__builtin_default__`.
   */
  it('writes a blank templateId for the built-in default, never the sentinel id', () => {
    expect(scaffoldKinTaleDraft(session(), DEFAULT_KINTALE_TEMPLATE).templateId).toBe('');
  });
  it('never lets a template prefill the headline or the body', () => {
    const opinionated = decodeKinTaleTemplate({
      _id: 'tpl',
      name: 'Walks',
      defaultEmailMessage: 'Your pet had a lovely time.',
    });
    const draft = scaffoldKinTaleDraft(session(), opinionated);
    expect(draft.title).toBe('');
    expect(draft.bodyCopy).toBe('');
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

/**
 * The household profile's "New KinTale" (#552).
 *
 * `kinfolkId` was declared on the props and spread into `SessionPicker`, which
 * never took it, so the narrowing this prop exists for did nothing and no test
 * noticed. `pickableSessions` is the filter itself; the rendered cases pin that
 * the screen actually calls it.
 */
describe('pickableSessions (pure): the household narrowing', () => {
  it('keeps only the named household when one is given', () => {
    const picked = pickableSessions(
      [
        session({ _id: 'a', kinfolkId: 'kf1' }),
        session({ _id: 'b', kinfolkId: 'kf2' }),
        session({ _id: 'c', kinfolkId: 'kf1' }),
      ],
      'kf1',
    );
    expect(picked.map((s) => s._id)).toEqual(['a', 'c']);
  });

  it('still drops a session of the right household that has not happened yet', () => {
    const picked = pickableSessions(
      [
        session({ _id: 'a', kinfolkId: 'kf1', status: 'SCHEDULED' }),
        session({ _id: 'b', kinfolkId: 'kf1', status: 'COMPLETED' }),
      ],
      'kf1',
    );
    expect(picked.map((s) => s._id)).toEqual(['b']);
  });

  it('a session with no kinfolkId at all belongs to no household, so a scoped picker never offers it', () => {
    const orphan = session({ _id: 'a' });
    delete (orphan as { kinfolkId?: string }).kinfolkId;
    expect(pickableSessions([orphan], 'kf1')).toEqual([]);
    // Unscoped it is still a real departed visit, and still offered.
    expect(pickableSessions([orphan]).map((s) => s._id)).toEqual(['a']);
  });

  it('an absent or blank household means every household, which is what the KinTales list passes', () => {
    const data = [session({ _id: 'a', kinfolkId: 'kf1' }), session({ _id: 'b', kinfolkId: 'kf2' })];
    expect(pickableSessions(data).map((s) => s._id)).toEqual(['a', 'b']);
    expect(pickableSessions(data, '').map((s) => s._id)).toEqual(['a', 'b']);
  });
});

describe('KinTaleCompose: session picker scoped to one household', () => {
  it('offers only this household s visits when opened from a profile', async () => {
    mockStreams({
      sessions: {
        status: 'ready',
        data: [
          session({ _id: 'a', kinfolkId: 'kf1', kinfolkName: 'The Whitfields' }),
          session({ _id: 'b', kinfolkId: 'kf2', kinfolkName: 'The Alvarez Household' }),
        ],
      },
    });
    render(<KinTaleCompose kinfolkId="kf1" onClose={vi.fn()} />);
    expect(await screen.findByText('The Whitfields')).toBeInTheDocument();
    expect(screen.queryByText('The Alvarez Household')).toBeNull();
  });

  it('says the household has no visits rather than showing another household s', async () => {
    mockStreams({
      sessions: {
        status: 'ready',
        data: [session({ _id: 'b', kinfolkId: 'kf2', kinfolkName: 'The Alvarez Household' })],
      },
    });
    render(<KinTaleCompose kinfolkId="kf1" onClose={vi.fn()} />);
    expect(
      await screen.findByText(/no departed or completed visits for this household yet/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('The Alvarez Household')).toBeNull();
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

describe('KinTaleCompose: the composer mock', () => {
  it('heads the screen with the trail, the page name, the visit line and the Draft pill', async () => {
    mockStreams({ sessions: { status: 'ready', data: [session({})] } });
    render(<KinTaleCompose sessionId="sess1" onClose={vi.fn()} />);
    await screen.findByLabelText(/headline/i);
    const hero = document.querySelector('.den-heading') as HTMLElement;
    const nav = within(hero).getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('New tale')).toHaveAttribute('aria-current', 'page');
    expect(within(hero).getByRole('heading', { level: 1 })).toHaveTextContent(/^New tale$/);
    // The mock's cover eyebrow, "Visit · <when> · <service>", as the detail line.
    expect(hero.querySelector('.den-heading-detail')).toHaveTextContent(/^Visit · 07-16 \d\d:\d\d · Dog Walk$/);
    expect(within(hero).getByText('Draft')).toHaveClass('den-statuspill');
    expect(within(hero).getByText('Draft')).toHaveAttribute('data-tone', 'orange');
    // A nested screen carries the trail, never the list's kicker.
    expect(hero.querySelector('.den-heading-kicker')).toBeNull();
  });

  it('names an existing report Edit tale', async () => {
    mockStreams({ reports: { status: 'ready', data: [report({ title: 'A great day at the park' })] } });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Edit tale' })).toBeInTheDocument();
  });

  it('lays the editor out in the mock order beside the Goes to rail', async () => {
    mockStreams({ sessions: { status: 'ready', data: [session({})] } });
    render(<KinTaleCompose sessionId="sess1" onClose={vi.fn()} />);
    await screen.findByLabelText(/headline/i);
    const editor = document.querySelector('.kintale-compose__col:not(.kintale-compose__rail)') as HTMLElement;
    const titles = Array.from(editor.querySelectorAll(':scope > .den-panel > .den-panel-header .den-panel-title')).map(
      (el) => el.textContent,
    );
    // No route on this visit, so the mock's four blocks read as three.
    expect(titles).toEqual(['The tale', 'Photos', 'Moments']);
    const rail = screen.getByRole('complementary', { name: 'Goes to' });
    expect(within(rail).getByRole('heading', { name: 'Goes to' })).toBeInTheDocument();
    expect(within(rail).getByText('Kin').nextElementSibling).toHaveTextContent('1 kin on this visit');
  });

  it('draws the photo strip as the mock: a dashed add tile, and the count as the mono note', async () => {
    mockStreams({
      reports: { status: 'ready', data: [report({ templateId: 'tpl_walk', mediaFileIds: ['m1', 'm2'] })] },
      templates: { status: 'ready', data: [templateDoc()] },
    });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    await screen.findByLabelText(/headline/i);
    expect(screen.getByText('2 attached')).toHaveClass('den-panel-meta');
    expect(screen.getByRole('button', { name: 'Add a photo' })).toHaveClass('kintale-compose__photo-add');
    expect(screen.queryByText('Nothing attached yet.')).toBeNull();
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
    expect(screen.getByText(/nothing here yet\. add a headline, some notes, a photo, or tick a moment\./i)).toBeInTheDocument();
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

describe('Ask Auntie: the generated title must never clobber the operator', () => {
  const GENERATED = {
    generated_copy: 'Nova met me at the door.',
    generated_title: 'Nova Meets the Door',
    communication_type: 'visit_report',
    kinfolk_name: 'Dana',
    kinfolk_id: 'kf1',
    draft_id: 'd1',
    model: 'claude-sonnet-4-5',
    draftWriteFailed: false,
    warnings: [],
  };
  beforeEach(() => {
    generateDraft.mockReset();
    generateDraft.mockResolvedValue(GENERATED);
  });
  it('fills a BLANK headline and labels it as written by Auntie', async () => {
    const user = userEvent.setup();
    mockStreams({ reports: { status: 'ready', data: [report({ title: '' })] } });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /ask auntie/i }));
    expect(await screen.findByDisplayValue('Nova Meets the Door')).toBeInTheDocument();
    expect(screen.getByText(/auntie wrote this headline/i)).toBeInTheDocument();
  });
  // THE rule. A headline the operator typed is theirs.
  it('leaves a headline the operator already typed completely alone', async () => {
    const user = userEvent.setup();
    mockStreams({ reports: { status: 'ready', data: [report({ title: 'My own headline' })] } });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /ask auntie/i }));
    // Body replaced, headline untouched.
    expect(await screen.findByDisplayValue('Nova met me at the door.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('My own headline')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Nova Meets the Door')).not.toBeInTheDocument();
    expect(screen.queryByText(/auntie wrote this headline/i)).not.toBeInTheDocument();
  });
  it('drops the Auntie label as soon as the operator types over it', async () => {
    const user = userEvent.setup();
    mockStreams({ reports: { status: 'ready', data: [report({ title: '' })] } });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /ask auntie/i }));
    expect(await screen.findByText(/auntie wrote this headline/i)).toBeInTheDocument();
    await user.type(screen.getByDisplayValue('Nova Meets the Door'), '!');
    expect(screen.queryByText(/auntie wrote this headline/i)).not.toBeInTheDocument();
  });
  // The copy is in hand; the draft ROW failing to persist is a separate fact and
  // it belongs on a persistent surface, never a toast that dismisses itself.
  it('keeps a failed draft write on a persistent banner, not a toast', async () => {
    generateDraft.mockResolvedValue({ ...GENERATED, draftWriteFailed: true });
    const user = userEvent.setup();
    mockStreams({ reports: { status: 'ready', data: [report({ title: '' })] } });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /ask auntie/i }));
    expect(await screen.findByText(/did not save/i)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('surfaces a generate failure on a banner and keeps the draft as it was', async () => {
    generateDraft.mockRejectedValue(new Error('generate_rate_limit_exceeded'));
    const user = userEvent.setup();
    mockStreams({ reports: { status: 'ready', data: [report({ title: 'Mine' })] } });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /ask auntie/i }));
    expect(await screen.findByText('generate_rate_limit_exceeded')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Mine')).toBeInTheDocument();
  });
});
// ── issue #397 item L20: template, checklist, photo, GPS ────────────────────
/** A `kintale_templates` doc as Firestore hands it back, with `_id` attached. */
function templateDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'tpl_walk',
    name: 'Dog Walk recap',
    isActive: true,
    serviceTypeKeys: ['Dog Walk'],
    checklistItems: [
      { key: 'fed', text: 'Fed', scope: 'PER_PET', order: 0 },
      { key: 'gate_locked', text: 'Gate locked', scope: 'PER_VISIT', order: 1 },
      {
        key: 'meds_given',
        text: 'Medications given',
        scope: 'PER_PET',
        order: 2,
        conditions: [{ source: 'KIN_ATTRIBUTE', op: 'EXISTS', attributeKey: 'medicationHealthNotes' }],
      },
    ],
    ...over,
  };
}
/** Open the composer on a real session with the given templates on stream. */
function renderComposer(opts: {
  templates?: Record<string, unknown>[];
  session?: SessionEntry;
} = {}) {
  mockStreams({
    sessions: { status: 'ready', data: [opts.session ?? session()] },
    templates: { status: 'ready', data: opts.templates ?? [templateDoc()] },
  });
  return render(<KinTaleCompose sessionId="sess1" onClose={vi.fn()} />);
}
describe('L20 · template selection', () => {
  it('names the template the session service type resolves to', async () => {
    renderComposer();
    expect(await screen.findByText('Dog Walk recap')).toBeInTheDocument();
  });
  it('says so, in the operator’s own words, when it fell back to the built-in', async () => {
    renderComposer({ templates: [templateDoc({ serviceTypeKeys: ['Overnight'] })] });
    expect(await screen.findByText('Standard Visit')).toBeInTheDocument();
    expect(screen.getByText(/nothing in the template bank matches/i)).toBeInTheDocument();
  });
  /**
   * The REFUSAL that matters most: an unresolved template must never be
   * scaffolded as the built-in. `templateId` is written once and never
   * re-derived, so scaffolding early would pin the draft to the wrong checklist
   * permanently.
   */
  it('refuses to scaffold at all while the template list is still loading', async () => {
    mockStreams({
      sessions: { status: 'ready', data: [session()] },
      templates: { status: 'loading' },
    });
    render(<KinTaleCompose sessionId="sess1" onClose={vi.fn()} />);
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByLabelText(/headline/i)).toBeNull();
  });
  /**
   * The same refusal on the EDIT path, which hydrates off the reports stream
   * alone and so could otherwise render a form for the moment before the
   * template arrives. A tick landed then would be keyed against the built-in's
   * items instead of the draft's real template.
   */
  it('refuses to render a reopened draft until its template can be resolved', async () => {
    mockStreams({
      reports: { status: 'ready', data: [report({ templateId: 'tpl_walk', title: 'Night check' })] },
      templates: { status: 'loading' },
    });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('carries the resolved template id into the saved document', async () => {
    saveKinTaleDraft.mockResolvedValue('r1');
    renderComposer();
    await user.type(await screen.findByLabelText(/headline/i), 'A good walk');
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(saveKinTaleDraft).toHaveBeenCalled());
    expect(saveKinTaleDraft.mock.calls[0]?.[0]).toMatchObject({ templateId: 'tpl_walk' });
  });
  /**
   * Reopening resolves by the STORED id, not by service type. Here the stored
   * template is not the one this service type would pick, and the stored one
   * must win, or every saved tick would be re-keyed out of existence.
   */
  it('reopens an existing draft against the template it was saved with', async () => {
    mockStreams({
      reports: {
        status: 'ready',
        data: [report({ templateId: 'tpl_overnight', title: 'Night check' })],
      },
      templates: {
        status: 'ready',
        data: [
          templateDoc(),
          templateDoc({ _id: 'tpl_overnight', name: 'Overnight recap', serviceTypeKeys: ['Overnight'] }),
        ],
      },
    });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText('Overnight recap')).toBeInTheDocument();
    expect(screen.queryByText('Dog Walk recap')).toBeNull();
  });
});
describe('L20 · per-item checklist', () => {
  it('offers the template’s per-pet items under the kin, and per-visit items under the visit', async () => {
    renderComposer();
    expect(await screen.findByRole('checkbox', { name: /^fed$/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /gate locked/i })).toBeInTheDocument();
    expect(screen.getByText('Biscuit')).toBeInTheDocument();
    expect(screen.getByText('The visit')).toBeInTheDocument();
  });
  /** The refusal: a condition that does not hold withholds the item entirely. */
  it('withholds a medication item from a kin with no medication notes', async () => {
    renderComposer();
    expect(await screen.findByRole('checkbox', { name: /^fed$/i })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /medications given/i })).toBeNull();
  });
  it('offers that same item once the kin actually has medication notes', async () => {
    getKin.mockResolvedValue({ ...BLANK_KIN, medicationHealthNotes: 'Half a tablet at noon' });
    renderComposer();
    expect(await screen.findByRole('checkbox', { name: /medications given/i })).toBeInTheDocument();
  });
  it('renders no Moments panel at all when the template has the checklist off', async () => {
    renderComposer({ templates: [templateDoc({ checklistEnabled: false })] });
    expect(await screen.findByLabelText(/headline/i)).toBeInTheDocument();
    expect(screen.queryByText('Moments')).toBeNull();
  });
  it('writes a ticked item in the shape the portal reads, keyed kinId|fieldKey', async () => {
    saveKinTaleDraft.mockResolvedValue('r1');
    renderComposer();
    await user.click(await screen.findByRole('checkbox', { name: /^fed$/i }));
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(saveKinTaleDraft).toHaveBeenCalled());
    expect(saveKinTaleDraft.mock.calls[0]?.[0].fieldResponses).toEqual({
      'pet1|fed': {
        fieldKey: 'fed',
        kinId: 'pet1',
        sectionKey: '',
        boolValue: true,
        intValue: null,
        stringValue: '',
        mediaIds: [],
      },
    });
  });
  it('keys a per-visit item by the bare fieldKey, with no kin id', async () => {
    saveKinTaleDraft.mockResolvedValue('r1');
    renderComposer();
    await user.click(await screen.findByRole('checkbox', { name: /gate locked/i }));
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(saveKinTaleDraft).toHaveBeenCalled());
    expect(Object.keys(saveKinTaleDraft.mock.calls[0]?.[0].fieldResponses)).toEqual(['gate_locked']);
  });
  /**
   * The M18-compatibility pin at the screen level. Unticking must leave a
   * `false` behind, because the operator ruling's fix distinguishes
   * "deliberately left undone" from "never applied", and a deleted entry throws
   * that distinction away before the portal can use it.
   */
  it('records an untick as false rather than dropping the answer', async () => {
    saveKinTaleDraft.mockResolvedValue('r1');
    renderComposer();
    const fed = await screen.findByRole('checkbox', { name: /^fed$/i });
    await user.click(fed);
    await user.click(fed);
    expect(fed).not.toBeChecked();
    await user.type(screen.getByLabelText(/headline/i), 'A good walk');
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(saveKinTaleDraft).toHaveBeenCalled());
    expect(saveKinTaleDraft.mock.calls[0]?.[0].fieldResponses['pet1|fed']).toMatchObject({ boolValue: false });
  });
  it('rehydrates the ticks a saved draft already carries', async () => {
    mockStreams({
      reports: {
        status: 'ready',
        data: [
          report({
            templateId: 'tpl_walk',
            fieldResponses: {
              'pet1|fed': { fieldKey: 'fed', kinId: 'pet1', boolValue: true },
            },
          }),
        ],
      },
      templates: { status: 'ready', data: [templateDoc()] },
    });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByRole('checkbox', { name: /^fed$/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /gate locked/i })).not.toBeChecked();
  });
  /** Ticking a moment is content on its own: a checklist-only tale can be sent. */
  it('enables Send off a tick alone, with no headline and no notes', async () => {
    renderComposer();
    const send = await screen.findByRole('button', { name: /send to the whitfields/i });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /^fed$/i }));
    expect(screen.getByRole('button', { name: /send to the whitfields/i })).toBeEnabled();
  });
});
describe('L20 · photos', () => {
  it('attaches an uploaded photo to the tale and sends its id', async () => {
    uploadMediaFile.mockResolvedValue('media9');
    saveKinTaleDraft.mockResolvedValue('r1');
    renderComposer();
    await user.click(await screen.findByRole('button', { name: /add a photo/i }));
    const file = new File(['bytes'], 'biscuit.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(/photo or video/i), file);
    await user.click(screen.getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(uploadMediaFile).toHaveBeenCalled());
    // The visit's own Cloudinary folder, matching Android and the desktop.
    expect(uploadMediaFile.mock.calls[0]?.[0]).toMatchObject({
      entityType: 'VISIT_LOG',
      entityId: 'sess1',
    });
    await user.click(await screen.findByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(saveKinTaleDraft).toHaveBeenCalled());
    expect(saveKinTaleDraft.mock.calls[0]?.[0].mediaFileIds).toEqual(['media9']);
  });
  /** The refusal: a failed upload attaches nothing and says why. */
  it('attaches nothing and surfaces the error when the upload fails', async () => {
    uploadMediaFile.mockRejectedValue(new Error('Upload signing refused this sign-in'));
    renderComposer();
    await user.click(await screen.findByRole('button', { name: /add a photo/i }));
    const file = new File(['bytes'], 'biscuit.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(/photo or video/i), file);
    await user.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(await screen.findByText(/upload signing refused this sign-in/i)).toBeInTheDocument();
    expect(screen.getByText('Nothing attached yet.')).toBeInTheDocument();
  });
  it('shows an already-attached photo, and detaching it drops only the reference', async () => {
    getMediaFilesByIds.mockResolvedValue([
      { _id: 'm1', storageUrl: 'https://example.test/m1.jpg', description: 'Biscuit at the park', isProfilePhoto: false, durationSeconds: 0 },
    ]);
    saveKinTaleDraft.mockResolvedValue('r1');
    mockStreams({
      reports: { status: 'ready', data: [report({ templateId: 'tpl_walk', mediaFileIds: ['m1'] })] },
      templates: { status: 'ready', data: [templateDoc()] },
    });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText('Biscuit at the park')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /remove from tale/i }));
    await user.click(screen.getByRole('button', { name: /save draft/i }));
    await waitFor(() => expect(saveKinTaleDraft).toHaveBeenCalled());
    expect(saveKinTaleDraft.mock.calls[0]?.[0].mediaFileIds).toEqual([]);
  });
  it('offers no photo block when the template has the showcase off', async () => {
    renderComposer({ templates: [templateDoc({ photoShowcaseEnabled: false })] });
    expect(await screen.findByLabelText(/headline/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add a photo/i })).toBeNull();
  });
});
describe('L20 · GPS block', () => {
  const ROUTE = {
    distanceMeters: 1234,
    durationSeconds: 900,
    route: [
      { lat: 34.42, lng: -119.7, t: 1_755_000_000_000 },
      { lat: 34.43, lng: -119.69, t: 1_755_000_900_000 },
    ],
  };
  it('draws the visit’s captured route with its distance and duration', async () => {
    renderComposer({ session: session({ gpsSummary: ROUTE }) });
    expect(await screen.findByText('Visit route')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /route of 1\.2 km over 15m 0s/i })).toBeInTheDocument();
    expect(screen.getByText('1.2 km')).toBeInTheDocument();
  });
  /** The refusal: most visits have no GPS, and an empty map is worse than none. */
  it('renders nothing at all for a visit with no GPS', async () => {
    renderComposer();
    expect(await screen.findByLabelText(/headline/i)).toBeInTheDocument();
    expect(screen.queryByText('Visit route')).toBeNull();
  });
  it('renders nothing for a single ping, which is a location and not a route', async () => {
    renderComposer({ session: session({ gpsSummary: { route: [{ lat: 34.42, lng: -119.7 }] } }) });
    expect(await screen.findByLabelText(/headline/i)).toBeInTheDocument();
    expect(screen.queryByText('Visit route')).toBeNull();
  });
  it('finds the parent visit’s route when reopening a saved draft too', async () => {
    mockStreams({
      reports: { status: 'ready', data: [report({ templateId: 'tpl_walk' })] },
      sessions: { status: 'ready', data: [session({ gpsSummary: ROUTE })] },
      templates: { status: 'ready', data: [templateDoc()] },
    });
    render(<KinTaleCompose kinTaleId="tale1" onClose={vi.fn()} />);
    expect(await screen.findByText('Visit route')).toBeInTheDocument();
  });
});
