// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { VisitTrackingStatus } from '../lib/visitTracking';

/**
 * The live line (issue #772): what each tracker phase reads as, on the card
 * (with the mock's own idle line) and on the detail sheet (nothing when idle).
 */

const { useVisitTracking } = vi.hoisted(() => ({ useVisitTracking: vi.fn() }));
vi.mock('../lib/visitTracking', () => ({ useVisitTracking }));

import {
  VisitTrackingIndicator,
  routeEmptyTextWhileArrived,
  routeLastPingLine,
  trackingLine,
} from './VisitTrackingIndicator';

function withStatus(status: VisitTrackingStatus) {
  useVisitTracking.mockReturnValue(status);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('VisitTrackingIndicator', () => {
  it('idle on the card: the mock line, with its dot, because the phone may be the tracker', () => {
    withStatus({ phase: 'idle' });
    render(<VisitTrackingIndicator sessionId="s1" idleText="GPS tracking · live route" />);
    const line = screen.getByTestId('visit-tracking');
    expect(line).toHaveTextContent('GPS tracking · live route');
    expect(line).toHaveAttribute('data-phase', 'idle');
    expect(line.querySelector('.vtrack__dot')).not.toBeNull();
  });

  it('idle on the sheet: renders nothing rather than a claim', () => {
    withStatus({ phase: 'idle' });
    const { container } = render(<VisitTrackingIndicator sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('starting: says the browser is being asked, no dot yet', () => {
    withStatus({ phase: 'starting' });
    render(<VisitTrackingIndicator sessionId="s1" idleText="GPS tracking · live route" />);
    const line = screen.getByTestId('visit-tracking');
    expect(line).toHaveTextContent('Asking this browser for your location');
    expect(line.querySelector('.vtrack__dot')).toBeNull();
  });

  it('on: names this browser as the tracker and counts the saved fixes', () => {
    withStatus({ phase: 'on', fixes: 0 });
    const { rerender } = render(<VisitTrackingIndicator sessionId="s1" />);
    expect(screen.getByTestId('visit-tracking')).toHaveTextContent(/^Tracking on from this browser$/);

    withStatus({ phase: 'on', fixes: 1 });
    rerender(<VisitTrackingIndicator sessionId="s1" />);
    expect(screen.getByTestId('visit-tracking')).toHaveTextContent('1 ping saved');

    withStatus({ phase: 'on', fixes: 12 });
    rerender(<VisitTrackingIndicator sessionId="s1" />);
    const line = screen.getByTestId('visit-tracking');
    expect(line).toHaveTextContent('Tracking on from this browser · 12 pings saved');
    expect(line).toHaveAttribute('data-phase', 'on');
    expect(line.querySelector('.vtrack__dot')).not.toBeNull();
  });

  it('off: says tracking is off for this visit and why, with no live dot', () => {
    withStatus({ phase: 'off', reason: 'denied', message: 'location was denied in this browser.' });
    render(<VisitTrackingIndicator sessionId="s1" idleText="GPS tracking · live route" />);
    const line = screen.getByTestId('visit-tracking');
    expect(line).toHaveTextContent(
      'Tracking off for this visit: location was denied in this browser.',
    );
    expect(line).toHaveAttribute('data-phase', 'off');
    expect(line.querySelector('.vtrack__dot')).toBeNull();
    expect(screen.queryByText(/live route/)).toBeNull();
  });
});

describe('trackingLine', () => {
  it('has no sentence for idle without an idle line', () => {
    expect(trackingLine({ phase: 'idle' })).toBeNull();
  });
});

describe('routeEmptyTextWhileArrived', () => {
  it('waits on this browser while it is tracking or starting', () => {
    expect(routeEmptyTextWhileArrived({ phase: 'on', fixes: 0 })).toBe(
      'Waiting for the first GPS ping from this browser.',
    );
    expect(routeEmptyTextWhileArrived({ phase: 'starting' })).toBe(
      'Waiting for the first GPS ping from this browser.',
    );
  });

  it('says tracking is off for the visit when this browser could not track it', () => {
    expect(
      routeEmptyTextWhileArrived({
        phase: 'off',
        reason: 'unsupported',
        message: 'this browser cannot share location.',
      }),
    ).toBe(
      'No route is being recorded from this browser. Tracking is off for this visit: this browser cannot share location.',
    );
  });

  it('keeps the field-app sentence when this tab is not the tracker', () => {
    expect(routeEmptyTextWhileArrived({ phase: 'idle' })).toMatch(/The field app writes one/);
  });
});
describe('#2338: the Arrived card line when this browser is not the tracker', () => {
  const ZONE = 'America/Chicago';
  // 2026-11-17 20:05 UTC is 14:05 in Chicago.
  const AT = Date.UTC(2026, 10, 17, 20, 5);
  it('names the last ping and its time, in 24 hours, in the business zone', () => {
    expect(
      routeLastPingLine({ points: [{ t: AT - 60_000 }, { t: AT }, { t: AT - 120_000 }], error: null, ready: true }, ZONE),
    ).toBe('GPS route · last ping 14:05');
  });
  it('says no ping has landed, rather than claiming a live route', () => {
    expect(routeLastPingLine({ points: [], error: null, ready: true }, ZONE)).toBe('No GPS pings yet');
  });
  it('says nothing while loading or when the read failed', () => {
    expect(routeLastPingLine({ points: [], error: null, ready: false }, ZONE)).toBeNull();
    expect(routeLastPingLine({ points: [{ t: AT }], error: 'denied', ready: true }, ZONE)).toBeNull();
  });
  it('an undated route is still a recorded route', () => {
    expect(routeLastPingLine({ points: [{}], error: null, ready: true }, ZONE)).toBe('GPS route recorded');
  });
  it('the idle line can go without the live dot', () => {
    withStatus({ phase: 'idle' });
    render(<VisitTrackingIndicator sessionId="s1" idleText="No GPS pings yet" idleLive={false} />);
    const line = screen.getByTestId('visit-tracking');
    expect(line).toHaveTextContent('No GPS pings yet');
    expect(line.querySelector('.vtrack__dot')).toBeNull();
  });
});
