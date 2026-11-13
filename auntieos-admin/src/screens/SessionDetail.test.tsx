// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type SessionEntry } from '../api/sessions';
/**
 * The screen now hosts writes (#397 L19), so four seams are mocked. Each is
 * mocked at the module this screen actually imports, so a spec drives the same
 * call the browser would make.
 */
const { patchVisitLifecycle, updateKinCareSession } = vi.hoisted(() => ({
  patchVisitLifecycle: vi.fn(),
  updateKinCareSession: vi.fn(),
}));
vi.mock('../api/sessionsWrite', () => ({ patchVisitLifecycle, updateKinCareSession }));
// #1580: the internal-notes panel reads and writes through these two callables.
const { listVisitInternalNotes, addInternalBookingNote } = vi.hoisted(() => ({
  listVisitInternalNotes: vi.fn(),
  addInternalBookingNote: vi.fn(),
}));
vi.mock('../api/bookingsWrite', () => ({ listVisitInternalNotes, addInternalBookingNote }));
// `useDocById` joined the list with #760: the Route panel's purple house marker
// reads `kinfolk/{id}.serviceLocation` through `lib/householdLocation.ts`, which
// subscribes to that document. Mocked at `lib/firestore` rather than at
// `lib/householdLocation`, so the real `readHouseholdPoint` still runs and a
// spec drives the raw document shape Firestore would actually hand back.
const { useCollection, useDocById } = vi.hoisted(() => ({
  useCollection: vi.fn(),
  useDocById: vi.fn(),
}));
vi.mock('../lib/firestore', () => ({ useCollection, useDocById }));
const { getBusinessSettings } = vi.hoisted(() => ({ getBusinessSettings: vi.fn() }));
vi.mock('../api/settings', () => ({ getBusinessSettings }));
// #1840: the server's answer the clock confirm reads. "Will be told" by default.
const { previewVisitNotification } = vi.hoisted(() => ({ previewVisitNotification: vi.fn() }));
vi.mock('../api/visitNoticePreview', () => ({ previewVisitNotification }));
// #1744: services are named from the KinCare catalog. "Long walk" runs 45
// minutes, so a stored `visit_45` reads as "Long walk".
vi.mock('../lib/useBookingCatalog', () => ({
  useBookingCatalog: () => ({ serviceRates: { 'Long walk': '45' }, serviceDurations: { 'Long walk': '45' }, timeBlocks: [] }),
}));
const { useBreadcrumbs } = vi.hoisted(() => ({ useBreadcrumbs: vi.fn() }));
vi.mock('../lib/breadcrumbs', async (importOriginal) => {
  // The NORMALIZERS stay real: `routePointsFromGpsSummary` is what turns the
  // stored summary into a drawable route, and stubbing it would let the GPS
  // cases pass over a shape the app never produces. Only the live listener is
  // replaced, because jsdom has no Firestore.
  const actual = await importOriginal<typeof import('../lib/breadcrumbs')>();
  return { ...actual, useBreadcrumbs };
});
// The browser tracker (#772), mocked whole for the same reason as the live
// listener: jsdom has no `navigator.geolocation`, and the sheet's cases are
// about what each tracker phase reads as, not about the watch.
const { useVisitTracking } = vi.hoisted(() => ({ useVisitTracking: vi.fn() }));
vi.mock('../lib/visitTracking', () => ({
  useVisitTracking,
  beginVisitTracking: vi.fn(),
  endVisitTracking: vi.fn(),
  stopVisitTracking: vi.fn(),
}));
import { SessionDetail } from './SessionDetail';
beforeEach(() => {
  useVisitTracking.mockReturnValue({ phase: 'idle' });
  patchVisitLifecycle.mockReset();
  updateKinCareSession.mockReset();
  listVisitInternalNotes.mockReset();
  listVisitInternalNotes.mockResolvedValue({ notes: [], canMarkAdminOnly: false, hasBookingRecord: true });
  addInternalBookingNote.mockReset();
  useCollection.mockReset();
  useCollection.mockReturnValue({ status: 'ready', data: [] });
  useDocById.mockReset();
  // The household on file has no stored coordinate by default, which is the
  // common case and the one that must draw no house marker at all.
  useDocById.mockReturnValue({ status: 'ready', data: null });
  getBusinessSettings.mockReset();
  getBusinessSettings.mockResolvedValue({ serviceRates: {}, serviceDurations: {} });
  useBreadcrumbs.mockReset();
  useBreadcrumbs.mockReturnValue({ points: [], error: null, ready: true });
  previewVisitNotification.mockReset();
  previewVisitNotification.mockResolvedValue({ willNotify: true, reason: null });
});

function entry(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    _id: 'sess1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    kinIds: ['p1', 'p2'],
    kinNames: ['Biscuit', 'Gravy'],
    serviceType: 'Dog Walk',
    startTime: '2026-07-16T14:00:00.000Z',
    arrivedAt: '',
    endTime: '2026-07-16T15:00:00.000Z',
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  };
}

/** The lifecycle node carrying this label, so a spec can read its mood. */
function stepNode(name: string): HTMLElement {
  const label = screen.getByText(name, { selector: '.sdetail__step-name' });
  const li = label.closest('li');
  if (li === null) throw new Error(`${name} is not inside a lifecycle step`);
  return li;
}

/** The panel and heading titles in document order, for the order assertions. */
function panelTitles(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('h1, h2, h3, h4')].map((h) => h.textContent);
}

describe('SessionDetail', () => {
  it('#2007: names the visit in the browser tab by its Kin, never its id', () => {
    document.title = '';
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(document.title).toBe('Biscuit & Gravy · AuntieOS');
    expect(document.title).not.toContain('sess1');
  });
  it('#1744: the title names the KinCare, never the stored key', () => {
    render(<SessionDetail entry={entry({ serviceType: 'visit_45' })} onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Biscuit & Gravy · Long walk' })).toBeInTheDocument();
  });
  it('renders the session fields from the passed entry, and its internal notes from the one list', async () => {
    listVisitInternalNotes.mockResolvedValue({
      notes: [{ id: 'session:sess1', body: 'Bring the long leash.', authorRole: 'unknown', authorName: null, createdAtMs: null, visibility: 'shared', source: 'visitRecord' }],
      canMarkAdminOnly: true,
      hasBookingRecord: false,
    });
    render(<SessionDetail entry={entry({ notes: 'Bring the long leash.' })} onBack={vi.fn()} />);
    // The mock's hero names the visit by its Kin and its service, not by the
    // household: "Biscuit & Gravy · 30-min walk". The household moves to the
    // detail line under it.
    expect(screen.getByRole('heading', { name: 'Biscuit & Gravy · Dog Walk' })).toBeInTheDocument();
    expect(screen.getByText('SCHEDULED')).toBeInTheDocument();
    expect(screen.getByText('Kin covered')).toBeInTheDocument();
    expect(await screen.findByText('Bring the long leash.')).toBeInTheDocument();
  });

  /**
   * #755: the screen is `auntieos-kincare-detail-2026-05-27.html`'s, panel for
   * panel. Hero band, then Visit lifecycle, Route, the two note boxes, Details.
   * The five panels the screen used to stack (Status, Visit clock, Timing, Kin,
   * Notes) are gone as panels and present as content.
   */
  it('lays the panels out in the mock’s order and nothing else', () => {
    const { container } = render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(panelTitles(container)).toEqual([
      'Biscuit & Gravy · Dog Walk',
      'Visit lifecycle',
      'Route',
      'Kinfolk-facing note',
      'Internal notes',
      'Details',
    ]);
  });

  it('hangs the status pill off the hero band and puts the day, window and household under the title', () => {
    render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    const hero = screen.getByRole('banner');
    expect(within(hero).getByText('ARRIVED')).toHaveClass('den-statuspill');
    // The detail line: day · window · household. The address joins it only
    // when the household record carries one (below).
    const detail = within(hero).getByText(/The Whitfields/);
    expect(detail).toHaveClass('den-heading-detail');
    expect(detail).toHaveTextContent(/·\s*The Whitfields$/);
  });

  it('adds the door to the hero line from the household record, and never invents one', () => {
    useDocById.mockImplementation((path: string) =>
      path === 'kinfolk'
        ? { status: 'ready', data: { serviceAddress: '82 Creekside Ln' } }
        : { status: 'ready', data: null },
    );
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(useDocById).toHaveBeenCalledWith('kinfolk', 'kf1');
    expect(screen.getByText(/The Whitfields · 82 Creekside Ln$/)).toBeInTheDocument();
  });

  it('strikes the pill through on a cancelled visit, the way every mock draws it', () => {
    render(<SessionDetail entry={entry({ status: 'CANCELLED' })} onBack={vi.fn()} />);
    expect(screen.getByText('CANCELLED')).toHaveClass('den-statuspill--struck');
  });

  it('falls back to the household when the record names no Kin and no service', () => {
    render(<SessionDetail entry={entry({ kinNames: [], serviceType: '' })} onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'The Whitfields' })).toBeInTheDocument();
  });

  // R1: a KinCare session covers every Kin in the home, so the Details row
  // NAMES them rather than reporting a bare count an operator cannot check
  // against a home.
  it('names the Kin this session covers', () => {
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(screen.getByText('Biscuit, Gravy')).toBeInTheDocument();
  });

  it('discloses Kin that are covered but carry no name, instead of under-reporting', () => {
    render(<SessionDetail entry={entry({ kinNames: ['Biscuit'] })} onBack={vi.fn()} />);
    expect(screen.getByText('Biscuit · 1 without a name on file')).toBeInTheDocument();
  });

  it('falls back to a count when a pre-R1 doc has ids but no names', () => {
    render(<SessionDetail entry={entry({ kinNames: [] })} onBack={vi.fn()} />);
    expect(screen.getByText('2 (names not on file)')).toBeInTheDocument();
  });

  // R1 regression: the Kin facts used to be HIDDEN whenever kinIds was empty,
  // and empty was exactly how a whole-household booking was stored. The row
  // now always renders and says what it does and does not know.
  it('still shows the Kin row when the record carries no Kin at all', () => {
    render(<SessionDetail entry={entry({ kinIds: [], kinNames: [] })} onBack={vi.fn()} />);
    expect(screen.getByText('Kin covered')).toBeInTheDocument();
    expect(screen.getByText(/Every Kin in the home/i)).toBeInTheDocument();
  });

  it('keeps the lifecycle and both note boxes on a record with nothing in them', async () => {
    render(
      <SessionDetail
        entry={entry({ startTime: '', endTime: '', arrivedAt: '', completedAt: '', kinIds: [], kinNames: [], notes: '' })}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Dog Walk' })).toBeInTheDocument();
    // Every node still draws; the ones still to come read "--".
    expect(screen.getAllByText('--')).toHaveLength(4);
    // The note boxes DELIBERATELY do not hide when empty: the admin one
    // carries the composer, and a panel that vanished when there was nothing
    // to read would take the only way to write one with it. Each says it is
    // empty instead.
    expect(screen.getByText('Internal notes')).toBeInTheDocument();
    expect(await screen.findByText(/no internal notes yet/i)).toBeInTheDocument();
    expect(screen.getByText('Kinfolk-facing note')).toBeInTheDocument();
    expect(screen.getByText(/no note from the household/i)).toBeInTheDocument();
  });

  it('shows the household’s own note read-only, marked as what they see', () => {
    render(
      <SessionDetail entry={entry({ kinfolkNotes: 'Side gate, harness on the hook.' })} onBack={vi.fn()} />,
    );
    expect(screen.getByText('Side gate, harness on the hook.')).toHaveClass('sdetail__nbox');
    expect(screen.getByText('visible to The Whitfields')).toHaveClass('den-panel-meta');
    expect(screen.getByText('staff only')).toHaveClass('den-panel-meta');
  });

  it('prices the visit from the rate card by exact service name, and says nothing when there is no match', async () => {
    getBusinessSettings.mockResolvedValue({
      serviceRates: { 'Dog Walk': '28', 'Drop-in': '20' },
      serviceDurations: {},
    });
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(await screen.findByText('$28')).toBeInTheDocument();
    expect(screen.getByText('Rate')).toBeInTheDocument();
  });

  it('lists the invoice and the sent KinTales only once there are any', () => {
    const { rerender } = render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(screen.queryByText('Invoice')).toBeNull();
    expect(screen.queryByText('KinTales sent')).toBeNull();
    rerender(<SessionDetail entry={entry({ invoiceId: 'inv1', reportIds: ['r1', 'r2'] })} onBack={vi.fn()} />);
    expect(screen.getByText('Invoice')).toBeInTheDocument();
    expect(screen.getByText('Linked')).toBeInTheDocument();
    expect(screen.getByText('KinTales sent')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  /**
   * Item 7b. The kicker used to read "THE DEN · AUNTIE TIME" here and on the
   * list, which told an operator three levels down exactly what it told them at
   * the top. The trail says where they are and offers the way back.
   */
  it('says where this session sits, and walks back to the list', async () => {
    const onBack = vi.fn();
    render(<SessionDetail entry={entry()} onBack={onBack} />);

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    // The last step is the Kin, as the mock's "Schedule / Wed May 27 / Biscuit
    // & Gravy" trail ends. The household is context, on the hero line.
    expect(within(nav).getByText('Biscuit & Gravy')).toHaveAttribute('aria-current', 'page');
    // "Auntie Time" is what the rail calls /sessions; naming it anything else
    // would point at a screen the operator cannot find.
    await userEvent.click(within(nav).getByRole('button', { name: 'Auntie Time' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  /**
   * THE THREE NO-ROW ANSWERS (#753). The detail is a route now, so a refresh on
   * `/sessions/<id>` mounts this screen with nothing resolved yet and a failed
   * read mounts it with nothing at all. One "no longer available" line for all
   * three would accuse a slow network of deleting a visit.
   */
  it('says the session is not on file when the read settled on nothing', () => {
    render(<SessionDetail entry={null} onBack={vi.fn()} />);
    expect(screen.getByText(/no KinCare session is on file under this id/i)).toBeInTheDocument();
  });
  it('says it is still looking while the by-id read is in flight, not that the session is gone', () => {
    render(<SessionDetail entry={null} read={{ status: 'loading' }} onBack={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Looking this KinCare session up…');
    expect(screen.queryByText(/not on file/i)).toBeNull();
  });
  it('surfaces a failed by-id read with its message and a retry, never as a missing session', async () => {
    const retry = vi.fn();
    render(
      <SessionDetail
        entry={null}
        read={{ status: 'error', message: 'backend unreachable', retry }}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('backend unreachable');
    expect(screen.queryByText(/not on file/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('AO-12 guard: an unrecognized status reads UNKNOWN, never a fabricated SCHEDULED', () => {
    render(<SessionDetail entry={entry({ status: 'some_new_code' })} onBack={vi.fn()} />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('SCHEDULED')).toBeNull();
  });

  it('offers no Back button: the crumb is the way back, as the mock’s hero has no button', () => {
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /back to auntie time/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Auntie Time' })).toBeInTheDocument();
  });
});

/**
 * The mock's "Visit lifecycle": five nodes, each lit from its OWN stamp. The
 * defect this guards: "Clocked out" used to read `completedAt`, so every visit
 * completed from the Bookings screen looked as though someone had clocked out
 * of it. Departing and completing are different events.
 */
describe('SessionDetail: the lifecycle stepper', () => {
  it('lights Scheduled as the current node on a fresh visit and the rest as still to come', () => {
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(stepNode('Scheduled')).toHaveAttribute('data-mood', 'now');
    for (const name of ['On my way', 'Arrived', 'Departed', 'Completed']) {
      expect(stepNode(name)).toHaveAttribute('data-mood', 'todo');
    }
    expect(screen.getAllByText('--')).toHaveLength(4);
  });

  it('marks each stamped step done, the current one now, and stamps them with the local clock', () => {
    render(
      <SessionDetail
        entry={entry({
          status: 'ARRIVED',
          onMyWayAt: '2026-07-16T13:48:00Z',
          arrivedAt: '2026-07-16T14:02:00Z',
        })}
        onBack={vi.fn()}
      />,
    );
    expect(stepNode('Scheduled')).toHaveAttribute('data-mood', 'done');
    expect(stepNode('On my way')).toHaveAttribute('data-mood', 'done');
    expect(stepNode('Arrived')).toHaveAttribute('data-mood', 'now');
    expect(stepNode('Departed')).toHaveAttribute('data-mood', 'todo');
    expect(stepNode('Completed')).toHaveAttribute('data-mood', 'todo');
    // A stamp is the AO-18 local moment, never a raw ISO string.
    expect(within(stepNode('Arrived')).getByText(/\d\d:\d\d/)).not.toHaveTextContent('T14:02');
    // The bar runs to the Arrived node: two of four gaps.
    expect(document.querySelector('.sdetail__lifebar')).toHaveStyle({ width: '40%' });
  });

  it('shows departedAt as the departure and completedAt as the completion', () => {
    render(
      <SessionDetail
        entry={entry({
          status: 'COMPLETED',
          arrivedAt: '2026-07-16T14:02:00Z',
          departedAt: '2026-07-16T14:45:00Z',
          completedAt: '2026-07-16T18:00:00Z',
        })}
        onBack={vi.fn()}
      />,
    );
    expect(stepNode('Arrived')).toHaveAttribute('data-mood', 'done');
    expect(stepNode('Departed')).toHaveAttribute('data-mood', 'done');
    expect(stepNode('Completed')).toHaveAttribute('data-mood', 'now');
  });

  it('leaves Departed unlit on a visit completed from the office without a clock-out', () => {
    render(
      <SessionDetail
        entry={entry({ status: 'COMPLETED', departedAt: '', completedAt: '2026-07-16T18:00:00Z' })}
        onBack={vi.fn()}
      />,
    );
    // Not "done": nobody clocked out. Reading done from "every step before the
    // current one" is exactly the old defect wearing a new shape.
    expect(stepNode('Departed')).toHaveAttribute('data-mood', 'todo');
    expect(stepNode('Arrived')).toHaveAttribute('data-mood', 'todo');
    expect(stepNode('Completed')).toHaveAttribute('data-mood', 'now');
  });

  it('lights no current node on a cancelled visit: the pill names it, the stepper shows what was stamped', () => {
    render(
      <SessionDetail
        entry={entry({ status: 'CANCELLED', onMyWayAt: '2026-07-16T13:48:00Z' })}
        onBack={vi.fn()}
      />,
    );
    expect(document.querySelector('.sdetail__step[data-mood="now"]')).toBeNull();
    expect(stepNode('On my way')).toHaveAttribute('data-mood', 'done');
    expect(stepNode('Arrived')).toHaveAttribute('data-mood', 'todo');
  });

  it('keeps the unknown-status hint inside the lifecycle panel', () => {
    render(<SessionDetail entry={entry({ status: 'some_new_code' })} onBack={vi.fn()} />);
    expect(screen.getByText(/isn’t recognized, so it is shown as UNKNOWN/)).toBeInTheDocument();
  });
});
/**
 * #397 L19: the write surface. Before this, the web admin could not edit a Kin
 * Care session, clock in or out, or see GPS. `SessionDetail.tsx` rendered
 * clocked-in/out as read-only `Fact`s and `Sessions.tsx` said the write flows
 * were "still NOT built here".
 */
/**
 * What a direct in-visit write resolves with. `notified` is a shorthand for the
 * `notification` promise the real write returns: it settles AFTER the write, so
 * the screen says the status change first and amends the sentence when the push
 * lands. That ordering has its own spec in `lib/useVisitLifecycle.test.ts`;
 * here it just has to settle.
 */
const clockOk = ({
  notified = true,
  notifySkipped = null,
  ...over
}: Record<string, unknown> & { notified?: boolean; notifySkipped?: string | null } = {}) => ({
  sessionId: 'sess1',
  action: 'ARRIVED',
  from: 'ON_MY_WAY',
  status: 'ARRIVED',
  changed: true,
  notification: Promise.resolve({ notified, notifySkipped }),
  ...over,
});
/** Press a clock button and confirm the dialog it opens. */
async function clock(name: RegExp, confirm: RegExp) {
  await userEvent.click(screen.getByRole('button', { name }));
  await userEvent.click(screen.getByRole('button', { name: confirm }));
}
describe('SessionDetail: the visit clock', () => {
  it('offers On the way and Clock in on a SCHEDULED visit, and nothing terminal', () => {
    render(<SessionDetail entry={entry({ status: 'SCHEDULED' })} onBack={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^on the way$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^clock in$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^clock out$/i })).toBeNull();
    // Completing is the office's decision and Bookings already owns it, through
    // the audited `transitionBookingStatus`. A second surface for the same
    // ruling is a second place for it to drift, not a missing control.
    expect(screen.queryByRole('button', { name: /complete/i })).toBeNull();
  });
  // Straight to Firestore now, not through the callable: the tap used to wait
  // out a measured 7.9 s Cloud Run cold start. The row itself is handed to the
  // write, which is what lets it decide legality and routing without a read.
  it('clocks in with a direct write, on the whole row, with a whole-second instant', async () => {
    patchVisitLifecycle.mockResolvedValue(clockOk());
    render(<SessionDetail entry={entry({ status: 'ON_MY_WAY' })} onBack={vi.fn()} />);
    await clock(/^clock in$/i, /yes, clock in/i);
    expect(patchVisitLifecycle).toHaveBeenCalledTimes(1);
    const [session, action, opts] = patchVisitLifecycle.mock.calls[0]!;
    expect(session._id).toBe('sess1');
    expect(session.status).toBe('ON_MY_WAY');
    expect(action).toBe('ARRIVED');
    expect(opts.nowIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(await screen.findByText(/ON_MY_WAY → ARRIVED/)).toBeInTheDocument();
  });
  it('says whether the household was actually told, rather than implying it', async () => {
    patchVisitLifecycle.mockResolvedValue(
      clockOk({ notified: false, notifySkipped: 'session_has_no_routing_ids' }),
    );
    render(<SessionDetail entry={entry({ status: 'ON_MY_WAY' })} onBack={vi.fn()} />);
    await clock(/^clock in$/i, /yes, clock in/i);
    expect(
      await screen.findByText(/the whitfields was not notified, because this visit is not linked to a booking/i),
    ).toBeInTheDocument();
  });
  it('clocks out from ARRIVED and offers the undo beside it', async () => {
    patchVisitLifecycle.mockResolvedValue(clockOk({ action: 'DEPARTED', from: 'ARRIVED', status: 'DEPARTED' }));
    render(<SessionDetail entry={entry({ status: 'ARRIVED', arrivedAt: '2026-07-16T14:02:00Z' })} onBack={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^undo arrival$/i })).toBeInTheDocument();
    await clock(/^clock out$/i, /yes, clock out/i);
    expect(patchVisitLifecycle.mock.calls[0]![1]).toBe('DEPARTED');
  });
  // The refusal the server owns. The button is not offered here (the courtesy
  // half), and this pins the courtesy so a state cannot quietly start
  // showing a control that always fails.
  it('does NOT offer a clock-out on a visit nobody clocked into', () => {
    render(<SessionDetail entry={entry({ status: 'SCHEDULED' })} onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^clock out$/i })).toBeNull();
  });
  it('surfaces the refusal verbatim, and does not claim a write', async () => {
    patchVisitLifecycle.mockRejectedValue(
      new Error('Cannot clock out of this visit while it is SCHEDULED. Allowed from: ARRIVED.'),
    );
    render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    await clock(/^clock out$/i, /yes, clock out/i);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Cannot clock out of this visit while it is SCHEDULED/);
    expect(screen.queryByText(/→/)).toBeNull();
  });
  // A double clock-in resolves with changed:false having written nothing. The
  // screen must not report it as a fresh clock-in, or an operator will believe
  // the arrival time moved.
  it('reports a no-op as a no-op, naming the time as unchanged', async () => {
    patchVisitLifecycle.mockResolvedValue(
      clockOk({ from: 'ARRIVED', status: 'ARRIVED', changed: false, notified: false }),
    );
    render(<SessionDetail entry={entry({ status: 'SCHEDULED' })} onBack={vi.fn()} />);
    await clock(/^clock in$/i, /yes, clock in/i);
    expect(await screen.findByText(/Already ARRIVED.*unchanged/i)).toBeInTheDocument();
  });
  it('offers no clock at all on a completed visit, and says why', () => {
    render(<SessionDetail entry={entry({ status: 'COMPLETED', completedAt: '2026-07-16T15:00:00Z' })} onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^clock in$/i })).toBeNull();
    expect(screen.getByText(/its clock is closed/i)).toBeInTheDocument();
  });
  it('undoes an arrival without pretending anyone is told', async () => {
    patchVisitLifecycle.mockResolvedValue(
      clockOk({ action: 'UNDO_ARRIVAL', from: 'ARRIVED', status: 'SCHEDULED', notified: false }),
    );
    render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^undo arrival$/i }));
    expect(screen.getByText(/nobody is notified/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /yes, undo the arrival/i }));
    expect(patchVisitLifecycle.mock.calls[0]![1]).toBe('UNDO_ARRIVAL');
  });
});
describe('SessionDetail: editing the visit', () => {
  it('saves only the fields the operator actually changed', async () => {
    updateKinCareSession.mockResolvedValue({ ok: true, sessionId: 'sess1', updated: ['serviceDurationMinutes'] });
    render(<SessionDetail entry={entry({ serviceDurationMinutes: 30 })} onBack={vi.fn()} />);
    const save = screen.getByRole('button', { name: /save details/i });
    // Nothing has changed yet, so there is nothing to save.
    expect(save).toBeDisabled();
    const minutes = screen.getByLabelText(/visit length/i);
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '45');
    await userEvent.click(screen.getByRole('button', { name: /save details/i }));
    expect(updateKinCareSession).toHaveBeenCalledWith('sess1', { serviceDurationMinutes: 45 });
    expect(await screen.findByText(/saved: visit length\./i)).toBeInTheDocument();
  });
  it('refuses an out-of-range visit length before it reaches the server', async () => {
    render(<SessionDetail entry={entry({ serviceDurationMinutes: 30 })} onBack={vi.fn()} />);
    const minutes = screen.getByLabelText(/visit length/i);
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '2000');
    await userEvent.click(screen.getByRole('button', { name: /save details/i }));
    expect(updateKinCareSession).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(/whole number of minutes, 0 to 1440/i);
  });
  it('surfaces a server refusal fail-loud instead of reporting a save', async () => {
    updateKinCareSession.mockRejectedValue(new Error("Session 'sess1' not found."));
    render(<SessionDetail entry={entry({ serviceDurationMinutes: 30 })} onBack={vi.fn()} />);
    const minutes = screen.getByLabelText(/visit length/i);
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '45');
    await userEvent.click(screen.getByRole('button', { name: /save details/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not found/i);
    expect(screen.queryByText(/^Saved:/)).toBeNull();
  });
  it('keeps a service the rate card no longer carries, rather than silently re-pricing the visit', async () => {
    getBusinessSettings.mockResolvedValue({
      serviceRates: { 'Drop-In 20m': '25' },
      serviceDurations: {},
    });
    render(<SessionDetail entry={entry({ serviceType: 'Retired Service' })} onBack={vi.fn()} />);
    const select = await screen.findByLabelText(/service type/i);
    expect(select).toHaveValue('Retired Service');
    expect(screen.getByRole('option', { name: /Retired Service \(not on the rate card\)/ })).toBeInTheDocument();
  });
  it('falls back to a free-text service box, and says why, when the rate card cannot be read', async () => {
    getBusinessSettings.mockRejectedValue(new Error('permission denied'));
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(await screen.findByText(/rate card couldn’t be read/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/service type/i)).toHaveValue('Dog Walk');
  });
  it('edits the Kin roster, and states that unticking everything means the whole household', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        { _id: 'p1', kinfolkId: 'kf1', name: 'Biscuit' },
        { _id: 'p2', kinfolkId: 'kf1', name: 'Gravy' },
      ],
    });
    updateKinCareSession.mockResolvedValue({ ok: true, sessionId: 'sess1', updated: ['kinIds', 'kinNames'] });
    render(<SessionDetail entry={entry({ kinIds: ['p1', 'p2'] })} onBack={vi.fn()} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Gravy' }));
    await userEvent.click(screen.getByRole('button', { name: /save details/i }));
    expect(updateKinCareSession).toHaveBeenCalledWith('sess1', { kinIds: ['p1'] });
  });
  // Unticking everything is R1's "whole household", not "no Kin" (a booking for
  // zero animals is not a thing the business sells), and the screen has to say
  // so where the operator can act on it.
  it('says that unticking every Kin means the whole household, not none', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        { _id: 'p1', kinfolkId: 'kf1', name: 'Biscuit' },
        { _id: 'p2', kinfolkId: 'kf1', name: 'Gravy' },
      ],
    });
    render(<SessionDetail entry={entry({ kinIds: ['p1', 'p2'] })} onBack={vi.fn()} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Gravy' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Biscuit' }));
    expect(screen.getByText(/nothing ticked means the whole household/i)).toBeInTheDocument();
  });
});
describe('SessionDetail: internal notes (#1580)', () => {
  it('adds a note to the visit\'s one internal list, by session, and re-reads it', async () => {
    addInternalBookingNote.mockResolvedValue({ noteId: 'n9', visibility: 'shared', storedOn: 'thread' });
    render(<SessionDetail entry={entry({ notes: 'Gate sticks.' })} onBack={vi.fn()} />);
    await screen.findByText(/no internal notes yet/i);
    await userEvent.type(screen.getByLabelText(/add an internal note/i), 'Key was under the mat.');
    await userEvent.click(screen.getByRole('button', { name: /add note/i }));
    expect(addInternalBookingNote).toHaveBeenCalledWith({ sessionId: 'sess1' }, 'Key was under the mat.', 'shared');
    // It no longer writes the session's own notes text, the second store Bookings never read.
    expect(updateKinCareSession).not.toHaveBeenCalled();
    expect(await screen.findByText('Note added for staff.')).toBeInTheDocument();
    expect(listVisitInternalNotes).toHaveBeenCalledTimes(2);
  });
  it('offers the owner the admin-only mark and sends it', async () => {
    listVisitInternalNotes.mockResolvedValue({ notes: [], canMarkAdminOnly: true, hasBookingRecord: true });
    addInternalBookingNote.mockResolvedValue({ noteId: 'n9', visibility: 'adminOnly', storedOn: 'thread' });
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /admin only/i }));
    await userEvent.type(screen.getByLabelText(/add an internal note/i), 'Rate goes up in January.');
    await userEvent.click(screen.getByRole('button', { name: /add note/i }));
    expect(addInternalBookingNote).toHaveBeenCalledWith({ sessionId: 'sess1' }, 'Rate goes up in January.', 'adminOnly');
  });
  it('does not offer an Auntie the mark', async () => {
    listVisitInternalNotes.mockResolvedValue({ notes: [], canMarkAdminOnly: false, hasBookingRecord: true });
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    await screen.findByText(/no internal notes yet/i);
    expect(screen.queryByRole('checkbox', { name: /admin only/i })).toBeNull();
  });
  it('cannot send a blank note', async () => {
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    await screen.findByText(/no internal notes yet/i);
    expect(screen.getByRole('button', { name: /add note/i })).toBeDisabled();
  });
  it('reports a failed note rather than clearing the box as though it landed', async () => {
    addInternalBookingNote.mockRejectedValue(new Error('permission denied'));
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    await screen.findByText(/no internal notes yet/i);
    await userEvent.type(screen.getByLabelText(/add an internal note/i), 'Something happened.');
    await userEvent.click(screen.getByRole('button', { name: /add note/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/permission denied/i);
    expect(screen.getByLabelText(/add an internal note/i)).toHaveValue('Something happened.');
  });
});
describe('SessionDetail: GPS', () => {
  const crumb = (lat: number, lng: number, t: number) => ({ lat, lng, t });
  it('draws the live route while the Auntie is clocked in', () => {
    useBreadcrumbs.mockReturnValue({
      points: [crumb(30.2, -97.7, 1), crumb(30.21, -97.71, 2), crumb(30.22, -97.72, 3)],
      error: null,
      ready: true,
    });
    const { container } = render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Live visit route' })).toBeInTheDocument();
    expect(container.querySelector('path')).not.toBeNull();
    expect(screen.getByText('Pings')).toBeInTheDocument();
  });
  it('is not live once the visit is DEPARTED: a replay must not claim movement', () => {
    useBreadcrumbs.mockReturnValue({ points: [crumb(30.2, -97.7, 1), crumb(30.3, -97.8, 2)], error: null, ready: true });
    const { container } = render(<SessionDetail entry={entry({ status: 'DEPARTED' })} onBack={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Visit route' })).toBeInTheDocument();
    expect(container.querySelector('path')).not.toBeNull();
  });
  // `purgeOldVisitRoutes` deletes breadcrumbs past the retention window, so a
  // completed visit's only route is the saved summary. A panel that read
  // breadcrumbs alone would be blank on exactly the visits an operator reviews.
  it('falls back to the saved summary on a completed visit, and says it is the down-sampled copy', () => {
    const { container } = render(
      <SessionDetail
        entry={entry({
          status: 'COMPLETED',
          completedAt: '2026-07-16T18:00:00Z',
          gpsSummary: {
            distanceMeters: 1931,
            durationSeconds: 1800,
            route: [
              { lat: 30.2, lng: -97.7, t: 1 },
              { lat: 30.3, lng: -97.8, t: 2 },
            ],
          },
        })}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByRole('img', { name: 'Visit route' })).toBeInTheDocument();
    expect(container.querySelector('path')).not.toBeNull();
    expect(screen.getByText(/down-sampled copy/i)).toBeInTheDocument();
  });
  it('tells "waiting for the first ping" apart from "no route was recorded"', () => {
    const { unmount } = render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    expect(screen.getByText(/waiting for the first gps ping/i)).toBeInTheDocument();
    unmount();
    render(<SessionDetail entry={entry({ status: 'DEPARTED' })} onBack={vi.fn()} />);
    expect(screen.getByText('No GPS breadcrumbs were recorded for this KinCare.')).toBeInTheDocument();
  });
  // #772: the sheet must not leave a denied browser "waiting for the first
  // ping" from a field app that is not running. The tracker's status decides
  // the sentence, and the live line under the clock says the same thing.
  it('says tracking is off for this visit when this browser was denied location', () => {
    useVisitTracking.mockReturnValue({
      phase: 'off',
      reason: 'denied',
      message: 'location was denied in this browser.',
    });
    render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    expect(
      screen.getByText(
        'No route is being recorded from this browser. Tracking is off for this visit: location was denied in this browser.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the first gps ping/i)).toBeNull();
    expect(
      screen.getByText('Tracking off for this visit: location was denied in this browser.'),
    ).toBeInTheDocument();
  });
  it('shows the live line under the clock and waits on this browser while it is tracking', () => {
    useVisitTracking.mockReturnValue({ phase: 'on', fixes: 0 });
    render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    expect(screen.getByText('Tracking on from this browser')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the first GPS ping from this browser.')).toBeInTheDocument();
  });
  it('shows no tracker line on a visit that is not ARRIVED, whatever the store says', () => {
    useVisitTracking.mockReturnValue({ phase: 'on', fixes: 3 });
    render(<SessionDetail entry={entry({ status: 'DEPARTED' })} onBack={vi.fn()} />);
    expect(screen.queryByTestId('visit-tracking')).toBeNull();
  });
  // #754: a finished visit with no breadcrumbs AND no gpsSummary was never
  // tracked (never clocked in from Android with location on). The old copy
  // ("older breadcrumbs are cleared... leaving the saved summary") implied a
  // summary existed even when one never did, which is what the walked visit
  // showed.
  it('names a finished visit with no breadcrumbs and no summary as never tracked', () => {
    render(<SessionDetail entry={entry({ status: 'COMPLETED', completedAt: '2026-07-16T18:00:00Z' })} onBack={vi.fn()} />);
    expect(
      screen.getByText('No GPS breadcrumbs were recorded for this KinCare because it was never tracked.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/retention window/i)).toBeNull();
    expect(screen.queryByRole('img', { name: /visit route/i })).toBeNull();
  });
  // #754: a gpsSummary can exist (distance/duration were saved) with no usable
  // route points, e.g. an empty or missing `route` array. That is a different
  // true fact from "never tracked" and must not draw a polyline either.
  it('names a saved summary with no route points as summary only, not never tracked', () => {
    render(
      <SessionDetail
        entry={entry({
          status: 'COMPLETED',
          completedAt: '2026-07-16T18:00:00Z',
          gpsSummary: { distanceMeters: 400, durationSeconds: 300, route: [] },
        })}
        onBack={vi.fn()}
      />,
    );
    expect(
      screen.getByText('A GPS summary was saved for this KinCare, but it has no route points to draw.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/never tracked/i)).toBeNull();
    expect(screen.queryByRole('img', { name: /visit route/i })).toBeNull();
  });
  // #754 regression guard: a SCHEDULED or ON_MY_WAY visit has no arrivedAt, no
  // breadcrumbs, and no gpsSummary either, the same shape as a truly
  // never-tracked finished visit. Without this carve-out "never tracked" would
  // render on a booking that has not happened yet.
  it('says tracking has not started on a scheduled visit, not never tracked', () => {
    const { unmount } = render(<SessionDetail entry={entry({ status: 'SCHEDULED' })} onBack={vi.fn()} />);
    expect(
      screen.getByText('Tracking starts once an Auntie clocks in for this KinCare.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/never tracked/i)).toBeNull();
    unmount();
    render(<SessionDetail entry={entry({ status: 'ON_MY_WAY' })} onBack={vi.fn()} />);
    expect(
      screen.getByText('Tracking starts once an Auntie clocks in for this KinCare.'),
    ).toBeInTheDocument();
  });
  // A dead subscription and an unmoved Auntie render identically if the caller
  // only receives an array. This is the case that keeps them apart.
  it('reports a failed GPS read as a failure, not as an empty route', () => {
    useBreadcrumbs.mockReturnValue({ points: [], error: 'Missing or insufficient permissions.', ready: true });
    render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Missing or insufficient permissions/);
    expect(screen.queryByText(/waiting for the first gps ping/i)).toBeNull();
  });
  /**
   * THE LOCATION-POLICY CASE. `allowClientLocationSharing` is the operator's
   * "Let kinfolk see visit locations" switch, and it governs HOUSEHOLD surfaces
   * only. `functions/src/lib/locationSharing.ts` enforces it in `getMyVisits`
   * and `getMyKinTales` and in the kinfolk branch of the breadcrumbs rule, whose
   * own comment reads "An auntie's own read is untouched." This panel is the
   * auntie's own read, so the switch must not reach it: an operator who has
   * chosen not to publish routes to households has not chosen to hide them from
   * herself.
   */
  it('draws the route whatever the kinfolk-sharing switch says', () => {
    getBusinessSettings.mockResolvedValue({
      serviceRates: {},
      serviceDurations: {},
      allowClientLocationSharing: false,
    });
    useBreadcrumbs.mockReturnValue({ points: [crumb(30.2, -97.7, 1), crumb(30.3, -97.8, 2)], error: null, ready: true });
    render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Live visit route' })).toBeInTheDocument();
  });
});

/**
 * #760. The operator's reference is the previous system's visit report, and
 * what it puts under the arrival and departure times is a map with a strip of
 * facts over it. These cases pin the strip and its placement; the map itself,
 * its four markers and its fallback are `components/RouteMap.test.tsx`, which
 * mocks mapbox-gl. No token is configured under vitest, so what renders here is
 * the SVG fallback, and the strip has to be on it just the same: the times and
 * the distance are facts about the visit, not decoration on a basemap.
 */
describe('SessionDetail: the route header strip', () => {
  const crumb = (lat: number, lng: number, t: number) => ({ lat, lng, t });
  // LOCAL instants, no trailing Z: the strip prints the operator's wall clock
  // (lib/time.ts's AO-18 rule), so a UTC literal would assert a different hour
  // on a runner in a different zone.
  const ARRIVED = '2026-07-16T12:05:00';
  const DEPARTED = '2026-07-16T13:09:00';

  it('states the visit length, both clock times and the distance', () => {
    useBreadcrumbs.mockReturnValue({ points: [], error: null, ready: true });
    render(
      <SessionDetail
        entry={entry({
          status: 'COMPLETED',
          arrivedAt: ARRIVED,
          departedAt: DEPARTED,
          gpsSummary: {
            distanceMeters: 200,
            durationSeconds: 3852,
            route: [
              { lat: 30.2, lng: -97.7, t: 1 },
              { lat: 30.3, lng: -97.8, t: 2 },
            ],
          },
        })}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText('Completed in 1:04')).toBeInTheDocument();
    expect(screen.getByText('Arrived at 12:05pm - Departed at 1:09pm - 0.1 miles')).toBeInTheDocument();
  });
  /**
   * DEPARTED IS NOT COMPLETED, and the strip must not say it is. The reference
   * report labels this clause "Completed at", over what this system stores as
   * `departedAt`. This screen already carries the ruling that the two are
   * different events and that `transitionBookingStatus` can stamp completion
   * without a departure ever being stamped, so a strip using the report's word
   * would put a second, invented completion time on a screen that prints the
   * real one a panel above.
   */
  it('names the departure as a departure, never as a completion', () => {
    useBreadcrumbs.mockReturnValue({ points: [], error: null, ready: true });
    render(
      <SessionDetail
        entry={entry({
          status: 'COMPLETED',
          arrivedAt: ARRIVED,
          departedAt: DEPARTED,
          completedAt: '2026-07-16T15:00:00',
          gpsSummary: {
            distanceMeters: 200,
            durationSeconds: 3852,
            route: [
              { lat: 30.2, lng: -97.7, t: 1 },
              { lat: 30.3, lng: -97.8, t: 2 },
            ],
          },
        })}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/Departed at 1:09pm/)).toBeInTheDocument();
    expect(screen.queryByText(/Completed at 1:09pm/)).toBeNull();
  });
  /**
   * A visit still being walked has no departure stamp. The strip drops that
   * clause rather than printing a blank one, and still reports the distance so
   * far, which is the number the office is watching.
   *
   * AND IT MUST NOT SAY "COMPLETED IN". These are real epoch-millisecond
   * breadcrumbs seven minutes apart, so the map hands the strip a live, growing
   * duration; a length printed from it would report a completion the Auntie has
   * not reached. Toy `t: 1, t: 2` timestamps would pass this by accident.
   */
  it('leaves out the clauses a live visit does not have yet, the length included', () => {
    useBreadcrumbs.mockReturnValue({
      points: [crumb(30.2, -97.7, 1_700_000_000_000), crumb(30.21, -97.71, 1_700_000_420_000)],
      error: null,
      ready: true,
    });
    render(<SessionDetail entry={entry({ status: 'ARRIVED', arrivedAt: ARRIVED })} onBack={vi.fn()} />);
    expect(screen.getByText(/^Arrived at 12:05pm - /)).toBeInTheDocument();
    expect(screen.queryByText(/Departed at/)).toBeNull();
    expect(screen.queryByText(/Completed in/)).toBeNull();
  });
  // Placement, which is the whole of the operator's sentence: the map is
  // "usually listed under the arrival departure times". Those times are the
  // Visit lifecycle stepper's stamps since #755, and the Route panel follows
  // it, so this asserts the order rather than trusting it.
  it('sits after the panel that carries the arrival and departure times', () => {
    useBreadcrumbs.mockReturnValue({
      points: [crumb(30.2, -97.7, 1), crumb(30.3, -97.8, 2)],
      error: null,
      ready: true,
    });
    const { container } = render(
      <SessionDetail
        entry={entry({ status: 'DEPARTED', arrivedAt: ARRIVED, departedAt: DEPARTED })}
        onBack={vi.fn()}
      />,
    );
    const lifecycle = screen.getByText('Visit lifecycle');
    const strip = screen.getByText(/Arrived at 12:05pm/);
    expect(lifecycle.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And nothing else sits between the two panels.
    const panels = panelTitles(container);
    expect(panels.indexOf('Route')).toBe(panels.indexOf('Visit lifecycle') + 1);
  });
});

/**
 * #1581: Auntie Time > visit > Details read "Visit length 0" for a 20:00 to
 * 20:30 visit, and "Kin covered: 1 (names not on file)" directly above the
 * named, ticked Kin.
 */
describe('SessionDetail visit facts (#1581)', () => {
  it('a stored length of 0 shows the visit window instead', () => {
    render(
      <SessionDetail
        entry={entry({
          startTime: '2026-07-16T01:00:00.000Z',
          endTime: '2026-07-16T01:30:00.000Z',
          serviceDurationMinutes: 0,
        })}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Visit length (minutes)')).toHaveValue(30);
  });

  it('a real stored length is shown as stored', () => {
    render(<SessionDetail entry={entry({ serviceDurationMinutes: 45 })} onBack={vi.fn()} />);
    expect(screen.getByLabelText('Visit length (minutes)')).toHaveValue(45);
  });

  it('names a Kin the record holds no name for from the household roster', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [{ _id: 'p1', name: 'QA-Pup' }] });
    render(<SessionDetail entry={entry({ kinIds: ['p1'], kinNames: [] })} onBack={vi.fn()} />);
    // Once in Kin covered, once beside its tick in the picker below.
    expect(screen.getAllByText('QA-Pup')).toHaveLength(2);
    expect(screen.queryByText('1 (names not on file)')).toBeNull();
  });

  it('still counts a Kin neither the record nor the roster can name', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [{ _id: 'p1', name: 'QA-Pup' }] });
    render(<SessionDetail entry={entry({ kinIds: ['p1', 'p9'], kinNames: [] })} onBack={vi.fn()} />);
    expect(screen.getByText('QA-Pup · 1 without a name on file')).toBeInTheDocument();
  });
});
// #1794, #1840: the visit sheet's clock confirm promises the household a
// notice only when the server says one can be sent. The login on the household
// record this screen reads (`kinfolk.uid`) is not consulted.
describe('SessionDetail: the clock confirm and the household notice', () => {
  function household(state: { status: 'ready'; data: Record<string, unknown> | null } | { status: 'loading' }) {
    useDocById.mockImplementation((path: string) => (path === 'kinfolk' ? state : { status: 'ready', data: null }));
  }
  async function openOnTheWay() {
    render(<SessionDetail entry={entry({ status: 'SCHEDULED', kinCareBatchId: 'b1', kinCareVisitId: 'v1' })} onBack={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^on the way$/i }));
    return screen.getByRole('dialog');
  }

  it('promises the notice when the server says the household will be told', async () => {
    const dialog = await openOnTheWay();
    expect(
      await within(dialog).findByText('The Whitfields will be told their Auntie is on the way.'),
    ).toBeInTheDocument();
  });

  it('says the switch is off in Settings when it is', async () => {
    previewVisitNotification.mockResolvedValue({ willNotify: false, reason: 'household_notices_off' });
    const dialog = await openOnTheWay();
    expect(
      await within(dialog).findByText(
        'The Whitfields will not be told, because notices to households are off in Settings.',
      ),
    ).toBeInTheDocument();
  });

  it("#1840: a login on the household record does not make it a portal sign-in; the server's answer does", async () => {
    household({ status: 'ready', data: { uid: 'uidAdmin' } });
    previewVisitNotification.mockResolvedValue({ willNotify: false, reason: 'household_has_no_portal_account' });
    const dialog = await openOnTheWay();
    expect(
      await within(dialog).findByText('The Whitfields will not be told, because they have no portal account.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/will be told/)).toBeNull();
  });

  it('says it is checking while the answer is on its way', async () => {
    previewVisitNotification.mockReturnValue(new Promise(() => {}));
    const dialog = await openOnTheWay();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Checking whether The Whitfields will be told.');
  });

  it('says nothing about the household when the server cannot be asked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    previewVisitNotification.mockRejectedValue(new Error('functions/unavailable'));
    const dialog = await openOnTheWay();
    await waitFor(() => expect(within(dialog).queryByText(/told/)).toBeNull());
    warn.mockRestore();
  });
});
