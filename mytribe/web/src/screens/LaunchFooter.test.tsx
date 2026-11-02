// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BUSINESS_PUBLIC_CARD_CACHE_KEY } from '../lib/businessPublicCard';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LaunchError } from './LaunchError';
import { LaunchOffline } from './LaunchOffline';
/**
 * #1428: both launch screens draw before any read can answer, so the footer
 * comes from the cached public card only, and is left out when none is cached.
 */
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), getDoc: vi.fn(() => new Promise(() => {})) }));
vi.mock('../lib/firebase', () => ({ firestore: { name: 'test-firestore' }, auth: {} }));
vi.mock('../api/portal', () => ({ getMyHome: vi.fn() }));
vi.mock('firebase/auth', () => ({ onAuthStateChanged: vi.fn(), getAuth: vi.fn() }));
const screens = [
  ['LaunchOffline', () => <LaunchOffline />],
  ['LaunchError', () => <LaunchError onRetry={vi.fn()} onSignOut={vi.fn()} />],
] as const;
describe.each(screens)('%s footer', (_name, ui) => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());
  it('names the cached business', () => {
    localStorage.setItem(BUSINESS_PUBLIC_CARD_CACHE_KEY, JSON.stringify({ name: 'Pawsome Test Co' }));
    render(<QueryClientProvider client={new QueryClient()}>{ui()}</QueryClientProvider>);
    expect(screen.getByText('Pawsome Test Co')).toBeTruthy();
    expect(document.querySelector('.errfoot')?.textContent).toBe('Cared for by Pawsome Test Co');
  });
  it('omits the footer with no cache and never shows a literal name', () => {
    render(<QueryClientProvider client={new QueryClient()}>{ui()}</QueryClientProvider>);
    expect(document.querySelector('.errfoot')).toBeNull();
    expect(document.body.textContent).not.toContain('Tribe Tails Pet Care');
  });
  it('omits the footer when the cached name is blank', () => {
    localStorage.setItem(BUSINESS_PUBLIC_CARD_CACHE_KEY, JSON.stringify({ name: '  ' }));
    render(<QueryClientProvider client={new QueryClient()}>{ui()}</QueryClientProvider>);
    expect(document.querySelector('.errfoot')).toBeNull();
  });
});
