// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ getIntegrationsHealth: vi.fn() }));
vi.mock('../../api/integrations', async (importOriginal) => {
  // The status label/tone maps are real: they are part of what this section
  // renders, and stubbing them would let a wrong label pass this file.
  const actual = await importOriginal<typeof import('../../api/integrations')>();
  return { ...actual, getIntegrationsHealth: api.getIntegrationsHealth };
});

import { IntegrationsSection } from './IntegrationsSection';
import type { IntegrationHealth, IntegrationsHealthResult } from '../../api/integrations';

/**
 * What this section must never do, stated as tests rather than as a comment:
 *
 *   - render a reassuring row when the read failed (AsyncRegion owns it, and it
 *     is asserted here because this is the screen where a false green means an
 *     operator stops looking for the reason invoices are not sending)
 *   - paraphrase the remediation, which carries the exact command to paste
 *   - show a secret VALUE, which the server never sends and this file never asks for
 *   - claim a secret is undeclared when the server said it could not find out
 */

function integration(over: Partial<IntegrationHealth> = {}): IntegrationHealth {
  return {
    key: 'twilio',
    name: 'Twilio',
    purpose: 'SMS to kinfolk.',
    status: 'configured',
    summary: 'Credentials are set. Not verified here.',
    secrets: [
      {
        name: 'TWILIO_AUTH_TOKEN',
        required: true,
        purpose: 'Signs sends.',
        declared: true,
        resolves: true,
        length: 32,
      },
    ],
    liveness: { outcome: 'none', detail: 'Not verified here.' },
    remediation: '',
    externalStep: '',
    ownedBySection: '',
    ...over,
  };
}

function result(over: Partial<IntegrationsHealthResult> = {}): IntegrationsHealthResult {
  return {
    checkedAt: '2026-07-31T12:00:00.000Z',
    declaredKnown: true,
    declaredError: '',
    integrations: [integration()],
    ...over,
  };
}

beforeEach(() => {
  api.getIntegrationsHealth.mockReset();
  api.getIntegrationsHealth.mockResolvedValue(result());
});

describe('IntegrationsSection renders each status class', () => {
  it('shows a working integration as working', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        integrations: [
          integration({
            key: 'cloudinary',
            name: 'Cloudinary',
            status: 'working',
            summary: 'A signed upload can be signed.',
          }),
        ],
      }),
    );
    render(<IntegrationsSection />);
    expect(await screen.findByText('Working')).toBeInTheDocument();
    expect(screen.getByText('A signed upload can be signed.')).toBeInTheDocument();
  });

  it('shows set-but-unverified as its own class, not as working', async () => {
    render(<IntegrationsSection />);
    expect(await screen.findByText('Set up, not verified')).toBeInTheDocument();
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
  });

  it('names the missing secret rather than saying only that something is wrong', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        integrations: [
          integration({
            status: 'missing',
            summary: 'Not usable: TWILIO_AUTH_TOKEN is not set.',
            secrets: [
              {
                name: 'TWILIO_AUTH_TOKEN',
                required: true,
                purpose: 'Signs sends.',
                declared: true,
                resolves: false,
                length: 0,
              },
            ],
          }),
        ],
      }),
    );
    render(<IntegrationsSection />);
    expect(await screen.findByText('Missing')).toBeInTheDocument();
    expect(screen.getByText(/TWILIO_AUTH_TOKEN is not set/)).toBeInTheDocument();
    expect(screen.getByText('not set')).toBeInTheDocument();
  });

  it('shows a check that could not be made as its own class, never as working', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        integrations: [
          integration({
            status: 'unknown',
            summary: 'Credentials are set, but the check could not be made: Firestore is unreachable',
          }),
        ],
      }),
    );
    render(<IntegrationsSection />);
    expect(await screen.findByText('Could not check')).toBeInTheDocument();
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
  });
});

describe('IntegrationsSection remediation', () => {
  it('prints the command verbatim, so it can be pasted', async () => {
    const command =
      'Twilio is missing TWILIO_AUTH_TOKEN. Set it from mytribe/, then redeploy the functions:\n' +
      'firebase functions:secrets:set TWILIO_AUTH_TOKEN --project auntieos-ttpc\n' +
      'firebase deploy --only functions:mytribe';
    api.getIntegrationsHealth.mockResolvedValue(
      result({ integrations: [integration({ status: 'missing', remediation: command })] }),
    );
    render(<IntegrationsSection />);
    const block = await screen.findByText(/firebase functions:secrets:set TWILIO_AUTH_TOKEN/);
    expect(block.textContent).toBe(command);
  });

  it('shows no remediation block when nothing is owed', async () => {
    render(<IntegrationsSection />);
    await screen.findByText('Twilio');
    expect(screen.queryByText('What to do')).not.toBeInTheDocument();
  });

  it('names an external console step even while the integration is otherwise fine', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        integrations: [
          integration({
            key: 'stripe',
            name: 'Stripe',
            externalStep: 'Stripe Connect onboarding is not built here. It needs a Connect client ID.',
          }),
        ],
      }),
    );
    render(<IntegrationsSection />);
    expect(await screen.findByText(/Stripe Connect onboarding is not built here/)).toBeInTheDocument();
  });
});

describe('IntegrationsSection never leaks a credential', () => {
  it('reports a length, and offers no field that could carry a value', async () => {
    render(<IntegrationsSection />);
    expect(await screen.findByText('set, 32 characters')).toBeInTheDocument();
  });
});

describe('IntegrationsSection failure state', () => {
  it('says the read failed, offers Retry, and renders no status pill at all', async () => {
    api.getIntegrationsHealth.mockRejectedValue(new Error('permission-denied'));
    render(<IntegrationsSection />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Couldn’t load integrations|Couldn't load integrations/)).toBeInTheDocument();
    expect(screen.getByText('permission-denied')).toBeInTheDocument();
    expect(screen.getByText(/Integrations unavailable while the load is failing/)).toBeInTheDocument();
    // The whole point: a failed read must not show a row of reassuring pills.
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
    expect(screen.queryByText('Set up, not verified')).not.toBeInTheDocument();
  });

  it('retries the callable rather than offering a button that does nothing', async () => {
    api.getIntegrationsHealth.mockRejectedValueOnce(new Error('permission-denied'));
    api.getIntegrationsHealth.mockResolvedValue(result());
    render(<IntegrationsSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Set up, not verified')).toBeInTheDocument();
  });

  it('withdraws every declared claim when the server could not read the declared set', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        declaredKnown: false,
        declaredError: 'the functions index would not load',
        integrations: [
          integration({
            secrets: [
              {
                name: 'TWILIO_AUTH_TOKEN',
                required: true,
                purpose: 'Signs sends.',
                // False only because the walk failed. Rendering it as a finding
                // would send the operator to edit a function that is correct.
                declared: false,
                resolves: true,
                length: 32,
              },
            ],
          }),
        ],
      }),
    );
    render(<IntegrationsSection />);

    expect(await screen.findByText(/Part of this check could not run/)).toBeInTheDocument();
    expect(screen.getByText(/the functions index would not load/)).toBeInTheDocument();
    expect(screen.queryByText('no deployed function declares this')).not.toBeInTheDocument();
  });

  it('flags an undeclared secret when the server DID look', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        integrations: [
          integration({
            secrets: [
              {
                name: 'TWILIO_AUTH_TOKEN',
                required: true,
                purpose: 'Signs sends.',
                declared: false,
                resolves: true,
                length: 32,
              },
            ],
          }),
        ],
      }),
    );
    render(<IntegrationsSection />);
    expect(await screen.findByText('no deployed function declares this')).toBeInTheDocument();
  });
});

describe('IntegrationsSection hands Google Calendar off rather than rebuilding it', () => {
  const google = integration({
    key: 'googleCalendar',
    name: 'Google Calendar',
    ownedBySection: 'googleCalendar',
    summary: 'No Google account has been connected yet.',
  });

  it('opens the section that owns the connect flow', async () => {
    api.getIntegrationsHealth.mockResolvedValue(result({ integrations: [google] }));
    const onOpenSection = vi.fn();
    render(<IntegrationsSection onOpenSection={onOpenSection} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Open Google Calendar settings' }));
    expect(onOpenSection).toHaveBeenCalledWith('googleCalendar');
  });

  it('states where to go instead of showing a button that cannot navigate', async () => {
    api.getIntegrationsHealth.mockResolvedValue(result({ integrations: [google] }));
    render(<IntegrationsSection />);

    expect(await screen.findByText(/live in the Google Calendar section/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Google Calendar settings' })).not.toBeInTheDocument();
  });
});

describe('IntegrationsSection re-checks on demand', () => {
  it('asks the server again rather than re-rendering a cached answer', async () => {
    render(<IntegrationsSection />);
    await screen.findByText('Twilio');
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(api.getIntegrationsHealth).toHaveBeenCalledTimes(2));
  });
});
