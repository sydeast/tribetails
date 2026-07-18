// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ExpirationRow } from '../../api/expirations';
import { localDateIso } from '../../lib/invoiceFormat';

const { listExpirations } = vi.hoisted(() => ({ listExpirations: vi.fn() }));
vi.mock('../../api/expirations', async (orig) => ({
  ...(await orig<typeof import('../../api/expirations')>()),
  listExpirations,
}));

import { ExpirationCountdownWidget } from './ExpirationCountdownWidget';

function exp(over: Partial<ExpirationRow> = {}): ExpirationRow {
  return { _id: 'e1', label: 'Gate code', dateIso: localDateIso(new Date()), kind: 'gateCode', ...over };
}

beforeEach(() => {
  listExpirations.mockReset();
});

describe('ExpirationCountdownWidget', () => {
  it('lists the upcoming expiries with a countdown', async () => {
    listExpirations.mockResolvedValue([exp({ label: 'Front gate code', dateIso: localDateIso(new Date()) })]);
    render(<ExpirationCountdownWidget />);

    expect(await screen.findByText('Front gate code')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('shows the empty state (not an error) when nothing lapses soon', async () => {
    listExpirations.mockResolvedValue([exp({ label: 'Old license', dateIso: '2020-01-01' })]);
    render(<ExpirationCountdownWidget />);
    expect(await screen.findByText(/nothing lapses/i)).toBeInTheDocument();
  });

  it('fails loud (names the callable) when the load rejects', async () => {
    listExpirations.mockRejectedValue(new Error('permission-denied'));
    render(<ExpirationCountdownWidget />);
    expect(await screen.findByText(/listExpirations failed:.*permission-denied/i)).toBeInTheDocument();
  });
});
