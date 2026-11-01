// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Kin } from './Kin';
import type { GetMyKinResult } from '../api/types';
const mocks = vi.hoisted(() => ({
  getMyKin: vi.fn<() => Promise<GetMyKinResult>>(),
}));
vi.mock('../api/portal', () => ({ getMyKin: () => mocks.getMyKin() }));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));
describe('Kin roster', () => {
  it('shows the title with no explanatory subtitle under it (#1315)', async () => {
    mocks.getMyKin.mockResolvedValue({ kin: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Kin />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'The Kin' })).toBeInTheDocument();
    expect(screen.queryByText(/Everyone who shares your home/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tap a card/i)).not.toBeInTheDocument();
  });
});
