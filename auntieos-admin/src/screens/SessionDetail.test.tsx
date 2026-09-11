// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type SessionEntry } from '../api/sessions';
/**
 * The screen now hosts writes (#397 L19), so four seams are mocked. Each is
 * mocked at the module this screen actually imports, so a spec drives the same
 * call the browser would make.
 */
const { setVisitLifecycle, updateKinCareSession } = vi.hoisted(() => ({
  setVisitLifecycle: vi.fn(),
  updateKinCareSession: vi.fn(),
}));
vi.mock('../api/sessionsWrite', () => ({ setVisitLifecycle, updateKinCareSession }));
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
const { useBreadcrumbs } = vi.hoisted(() => ({ useBreadcrumbs: vi.fn() }));
vi.mock('../lib/breadcrumbs', async (importOriginal) => {
  // The NORMALIZERS stay real: `routePointsFromGpsSummary` is what turns the
  // stored summary into a drawable route, and stubbing it would let the GPS
  // cases pass over a shape the app never produces. Only the live listener is
  // replaced, because jsdom has no Firestore.
  const actual = await importOriginal<typeof import('../lib/breadcrumbs')>();
  return { ...actual, useBreadcrumbs };
});
import { SessionDetail } from './SessionDetail';
beforeEach(() => {
  setVisitLifecycle.mockReset();
  updateKinCareSession.mockReset();
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

describe('SessionDetail', () => {
  it('renders the session fields from the passed entry (by value, no fetch)', () => {
    render(<SessionDetail entry={entry({ notes: 'Bring the long leash.' })} onBack={vi.fn()} />);
    // By ROLE, not by text: the breadcrumb's last step names this session too,
    // exactly as `auntieos-kincare-detail-2026-05-27.html` shows it, so the
    // household name is legitimately on the page twice.
    expect(screen.getByRole('heading', { name: 'The Whitfields' })).toBeInTheDocument();
    expect(screen.getByText('Dog Walk')).toBeInTheDocument();
    expect(screen.getByText('SCHEDULED')).toBeInTheDocument();
    // Timing (start/end parseable), Kin, and Notes sections all show.
    expect(screen.getByText('Timing')).toBeInTheDocument();
    expect(screen.getByText('Kin covered')).toBeInTheDocument();
    expect(screen.getByText('Bring the long leash.')).toBeInTheDocument();
  });

  // R1: a KinCare session covers every Kin in the home, so the panel NAMES them
  // rather than reporting a bare count an operator cannot check against a home.
  it('names the Kin this session covers', () => {
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(screen.getByText('Biscuit, Gravy')).toBeInTheDocument();
  });

  it('discloses Kin that are covered but carry no name, instead of under-reporting', () => {
    render(<SessionDetail entry={entry({ kinNames: ['Biscuit'] })} onBack={vi.fn()} />);
    expect(screen.getByText('Biscuit')).toBeInTheDocument();
    expect(screen.getByText('Unnamed Kin')).toBeInTheDocument();
  });

  it('falls back to a count when a pre-R1 doc has ids but no names', () => {
    render(<SessionDetail entry={entry({ kinNames: [] })} onBack={vi.fn()} />);
    expect(screen.getByText('2 (names not on file)')).toBeInTheDocument();
  });

  // R1 regression: the Kin panel used to be HIDDEN whenever kinIds was empty,
  // and empty was exactly how a whole-household booking was stored. The panel
  // now always renders and says what it does and does not know.
  it('still shows the Kin panel when the record carries no Kin at all', () => {
    render(<SessionDetail entry={entry({ kinIds: [], kinNames: [] })} onBack={vi.fn()} />);
    expect(screen.getByText('Kin')).toBeInTheDocument();
    expect(screen.getByText(/No Kin are recorded on this session/i)).toBeInTheDocument();
  });

  it('omits the all-blank Timing panel, and keeps Notes because Notes is now a write surface', () => {
    render(
      <SessionDetail
        entry={entry({ startTime: '', endTime: '', arrivedAt: '', completedAt: '', kinIds: [], kinNames: [], notes: '' })}
        onBack={vi.fn()}
      />,
    );
    // The head still renders (household + chip), and a Timing panel with no
    // timing on file still hides.
    expect(screen.getByRole('heading', { name: 'The Whitfields' })).toBeInTheDocument();
    expect(screen.queryByText('Timing')).toBeNull();
    // Notes DELIBERATELY no longer hides when empty: it carries the note
    // composer, and a panel that vanished when there was nothing to read would
    // take the only way to write one with it. It says it is empty instead.
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByText(/no notes on this visit yet/i)).toBeInTheDocument();
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
    expect(within(nav).getByText('The Whitfields')).toHaveAttribute('aria-current', 'page');
    // "Auntie Time" is what the rail calls /sessions; naming it anything else
    // would point at a screen the operator cannot find.
    await userEvent.click(within(nav).getByRole('button', { name: 'Auntie Time' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows an honest unavailable state when the entry does not resolve (null), never a blank detail', () => {
    render(<SessionDetail entry={null} onBack={vi.fn()} />);
    expect(screen.getByText(/no longer available/i)).toBeInTheDocument();
  });

  it('AO-12 guard: an unrecognized status reads UNKNOWN, never a fabricated SCHEDULED', () => {
    render(<SessionDetail entry={entry({ status: 'some_new_code' })} onBack={vi.fn()} />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('SCHEDULED')).toBeNull();
  });

  it('calls onBack from the Back control', async () => {
    const onBack = vi.fn();
    render(<SessionDetail entry={entry()} onBack={onBack} />);
    await userEvent.click(screen.getByRole('button', { name: /back to auntie time/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
/**
 * #397 L19: the write surface. Before this, the web admin could not edit a Kin
 * Care session, clock in or out, or see GPS. `SessionDetail.tsx` rendered
 * clocked-in/out as read-only `Fact`s and `Sessions.tsx` said the write flows
 * were "still NOT built here".
 */
const clockOk = (over: Record<string, unknown> = {}) => ({
  ok: true,
  sessionId: 'sess1',
  action: 'ARRIVED',
  from: 'ON_MY_WAY',
  status: 'ARRIVED',
  changed: true,
  notified: true,
  notifySkipped: null,
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
  it('clocks in through the callable, with a whole-second instant', async () => {
    setVisitLifecycle.mockResolvedValue(clockOk());
    render(<SessionDetail entry={entry({ status: 'ON_MY_WAY' })} onBack={vi.fn()} />);
    await clock(/^clock in$/i, /yes, clock in/i);
    expect(setVisitLifecycle).toHaveBeenCalledTimes(1);
    const [id, action, opts] = setVisitLifecycle.mock.calls[0]!;
    expect(id).toBe('sess1');
    expect(action).toBe('ARRIVED');
    expect(opts.atIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(await screen.findByText(/ON_MY_WAY → ARRIVED/)).toBeInTheDocument();
  });
  it('says whether the household was actually told, rather than implying it', async () => {
    setVisitLifecycle.mockResolvedValue(
      clockOk({ notified: false, notifySkipped: 'session_has_no_routing_ids' }),
    );
    render(<SessionDetail entry={entry({ status: 'ON_MY_WAY' })} onBack={vi.fn()} />);
    await clock(/^clock in$/i, /yes, clock in/i);
    expect(await screen.findByText(/household was not notified/i)).toBeInTheDocument();
  });
  it('clocks out from ARRIVED and offers the undo beside it', async () => {
    setVisitLifecycle.mockResolvedValue(clockOk({ action: 'DEPARTED', from: 'ARRIVED', status: 'DEPARTED' }));
    render(<SessionDetail entry={entry({ status: 'ARRIVED', arrivedAt: '2026-07-16T14:02:00Z' })} onBack={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^undo arrival$/i })).toBeInTheDocument();
    await clock(/^clock out$/i, /yes, clock out/i);
    expect(setVisitLifecycle.mock.calls[0]![1]).toBe('DEPARTED');
  });
  // The refusal the server owns. The button is not offered here (the courtesy
  // half), and this pins the courtesy so a state cannot quietly start
  // showing a control that always fails.
  it('does NOT offer a clock-out on a visit nobody clocked into', () => {
    render(<SessionDetail entry={entry({ status: 'SCHEDULED' })} onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^clock out$/i })).toBeNull();
  });
  it('surfaces the server’s own refusal verbatim, and does not claim a write', async () => {
    setVisitLifecycle.mockRejectedValue(
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
    setVisitLifecycle.mockResolvedValue(
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
    setVisitLifecycle.mockResolvedValue(
      clockOk({ action: 'UNDO_ARRIVAL', from: 'ARRIVED', status: 'SCHEDULED', notified: false }),
    );
    render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^undo arrival$/i }));
    expect(screen.getByText(/nobody is notified/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /yes, undo the arrival/i }));
    expect(setVisitLifecycle.mock.calls[0]![1]).toBe('UNDO_ARRIVAL');
  });
});
describe('SessionDetail: timing reads the right fields', () => {
  // The defect this closes: "Clocked out" used to read `completedAt`, so every
  // visit completed from the Bookings screen looked as though someone had
  // clocked out of it. They are different events.
  it('shows departedAt as the clock-out and completedAt as the completion', () => {
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
    expect(screen.getByText('Clocked in')).toBeInTheDocument();
    expect(screen.getByText('Clocked out')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });
  it('shows no clock-out on a visit completed from the office without one', () => {
    render(
      <SessionDetail
        entry={entry({ status: 'COMPLETED', departedAt: '', completedAt: '2026-07-16T18:00:00Z' })}
        onBack={vi.fn()}
      />,
    );
    expect(screen.queryByText('Clocked out')).toBeNull();
    expect(screen.getByText('Completed')).toBeInTheDocument();
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
    expect(await screen.findByText(/saved: serviceDurationMinutes/i)).toBeInTheDocument();
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
describe('SessionDetail: note to office', () => {
  it('prepends a stamped (office) line and keeps the earlier notes', async () => {
    updateKinCareSession.mockResolvedValue({ ok: true, sessionId: 'sess1', updated: ['notes'] });
    render(<SessionDetail entry={entry({ notes: 'Gate sticks.' })} onBack={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/note to office/i), 'Key was under the mat.');
    await userEvent.click(screen.getByRole('button', { name: /add note/i }));
    expect(updateKinCareSession).toHaveBeenCalledTimes(1);
    const notes = updateKinCareSession.mock.calls[0]![1].notes as string;
    expect(notes).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] \(office\) Key was under the mat\.\nGate sticks\.$/);
  });
  it('cannot send a blank note', () => {
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(screen.getByRole('button', { name: /add note/i })).toBeDisabled();
  });
  it('reports a failed note rather than clearing the box as though it landed', async () => {
    updateKinCareSession.mockRejectedValue(new Error('permission denied'));
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/note to office/i), 'Something happened.');
    await userEvent.click(screen.getByRole('button', { name: /add note/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/permission denied/i);
    expect(screen.getByLabelText(/note to office/i)).toHaveValue('Something happened.');
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
    render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Live visit route' })).toBeInTheDocument();
    expect(screen.getByText('Pings')).toBeInTheDocument();
  });
  it('is not live once the visit is DEPARTED: a replay must not claim movement', () => {
    useBreadcrumbs.mockReturnValue({ points: [crumb(30.2, -97.7, 1), crumb(30.3, -97.8, 2)], error: null, ready: true });
    render(<SessionDetail entry={entry({ status: 'DEPARTED' })} onBack={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Visit route' })).toBeInTheDocument();
  });
  // `purgeOldVisitRoutes` deletes breadcrumbs past the retention window, so a
  // completed visit's only route is the saved summary. A panel that read
  // breadcrumbs alone would be blank on exactly the visits an operator reviews.
  it('falls back to the saved summary on a completed visit, and says it is the down-sampled copy', () => {
    render(
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
    expect(screen.getByText(/down-sampled copy/i)).toBeInTheDocument();
  });
  it('tells "waiting for the first ping" apart from "no route was recorded"', () => {
    const { unmount } = render(<SessionDetail entry={entry({ status: 'ARRIVED' })} onBack={vi.fn()} />);
    expect(screen.getByText(/waiting for the first gps ping/i)).toBeInTheDocument();
    unmount();
    render(<SessionDetail entry={entry({ status: 'DEPARTED' })} onBack={vi.fn()} />);
    expect(screen.getByText(/no gps breadcrumbs were recorded/i)).toBeInTheDocument();
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
  // "usually listed under the arrival departure times". The Route panel already
  // follows the Timing panel, so this asserts the order rather than trusting it.
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
    const timing = screen.getByText('Timing');
    const strip = screen.getByText(/Arrived at 12:05pm/);
    expect(timing.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And nothing else sits between the two panels.
    const panels = [...container.querySelectorAll('h2, h3, h4')].map((h) => h.textContent);
    expect(panels.indexOf('Route')).toBe(panels.indexOf('Timing') + 1);
  });
});
