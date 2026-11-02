// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * #1492: a Kin the office archives (both copies now carry `archived`) is not
 * drawn on the household's roster, and a Kin the office restores is. This runs
 * the real `getMyKin` and its direct read of `families/{kinfolkId}/kin`, with
 * only Firestore itself stubbed, so the roster is checked end to end on the
 * screen rather than at the mapper.
 */

const fs = vi.hoisted(() => ({
  docs: [] as Array<{ id: string; data: Record<string, unknown> }>,
}));
vi.mock('firebase/firestore', () => ({
  collection: () => ({ path: 'families/fam1/kin' }),
  getDocs: async () => ({ docs: fs.docs.map((d) => ({ id: d.id, data: () => d.data })) }),
}));
vi.mock('../lib/firebase', () => ({ firestore: { name: 'test-firestore' } }));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

import { Kin } from './Kin';

function renderRoster() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Kin />
    </QueryClientProvider>,
  );
}

describe('Kin roster and the office archive (#1492)', () => {
  it('does not draw a Kin the office archived', async () => {
    fs.docs = [
      { id: 'k1', data: { name: 'Rex', species: 'Dog', status: 'active' } },
      { id: 'k2', data: { name: 'Bo', species: 'Cat', status: 'archived', removalRequestId: 'fam1_k2' } },
    ];
    renderRoster();
    expect(await screen.findByText('Rex')).toBeInTheDocument();
    expect(screen.queryByText('Bo')).not.toBeInTheDocument();
  });

  it('draws the Kin again once the office restores it', async () => {
    fs.docs = [
      { id: 'k1', data: { name: 'Rex', species: 'Dog', status: 'active' } },
      { id: 'k2', data: { name: 'Bo', species: 'Cat', status: 'active' } },
    ];
    renderRoster();
    expect(await screen.findByText('Rex')).toBeInTheDocument();
    expect(screen.getByText('Bo')).toBeInTheDocument();
  });
});
