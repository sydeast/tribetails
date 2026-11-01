// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const api = vi.hoisted(() => ({ getMyHome: vi.fn() }));
vi.mock('../api/portal', () => api);
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
import { BusinessFootnote, SettingsBusinessFootnote } from './BusinessFootnote';
/**
 * #1369: the footnote names the business from settings. It never falls back to a
 * hard-coded business; an unset name draws nothing.
 */
function renderFootnote(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
describe('BusinessFootnote', () => {
  it('reads the name from business settings (getMyHome)', async () => {
    api.getMyHome.mockResolvedValue({ businessName: 'Paws and Claws Pet Sitting' });
    renderFootnote(<SettingsBusinessFootnote />);
    await waitFor(() => expect(screen.getByText('Paws and Claws Pet Sitting')).toBeTruthy());
    expect(screen.getByText(/Cared for by/)).toBeTruthy();
    expect(screen.queryByText(/Tribe Tails Pet Care/)).toBeNull();
  });
  it('uses the lead and an explicit name when given (invoice: "Billed by")', () => {
    api.getMyHome.mockResolvedValue({ businessName: 'Ignored' });
    renderFootnote(<BusinessFootnote lead="Billed by" name="Acme Pet Care" />);
    expect(screen.getByText(/Billed by/)).toBeTruthy();
    expect(screen.getByText('Acme Pet Care')).toBeTruthy();
  });
  it('renders nothing when no name is set', async () => {
    api.getMyHome.mockResolvedValue({ businessName: '' });
    const { container } = renderFootnote(<SettingsBusinessFootnote />);
    await waitFor(() => expect(api.getMyHome).toHaveBeenCalled());
    expect(container.querySelector('.footnote')).toBeNull();
    expect(container.textContent).toBe('');
  });
  it('renders nothing when the home query fails', async () => {
    api.getMyHome.mockRejectedValue(new Error('offline'));
    const { container } = renderFootnote(<SettingsBusinessFootnote />);
    await waitFor(() => expect(api.getMyHome).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
