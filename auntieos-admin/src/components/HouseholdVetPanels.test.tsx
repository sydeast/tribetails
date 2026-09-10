// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Async } from '../lib/async';
import type { VetClinic } from '../api/vetClinics';

const { getHouseholdData } = vi.hoisted(() => ({ getHouseholdData: vi.fn() }));
vi.mock('../api/householdData', async (orig) => ({
  ...(await orig<typeof import('../api/householdData')>()),
  getHouseholdData,
}));

const useCollection = vi.fn();
vi.mock('../lib/firestore', async (orig) => ({
  ...(await orig<typeof import('../lib/firestore')>()),
  useCollection: (spec: unknown) => useCollection(spec),
}));

import { HouseholdVetPanels } from './HouseholdVetPanels';
import { blankHouseholdRecord, type HouseholdRecord } from '../api/householdData';

function household(over: Partial<HouseholdRecord> = {}): HouseholdRecord {
  return { ...blankHouseholdRecord('k1'), ...over };
}

function ready<T>(data: T[]): Async<T[]> {
  return { status: 'ready', data };
}

beforeEach(() => {
  getHouseholdData.mockReset();
  useCollection.mockReset();
  useCollection.mockReturnValue(ready<VetClinic>([]));
});

describe('HouseholdVetPanels', () => {
  /**
   * #685: the vet clinic address, same as the profile's own service address,
   * opens Google Maps directions rather than sitting as plain text.
   */
  it('renders the vet clinic address as a Google Maps directions link', async () => {
    getHouseholdData.mockResolvedValue(
      household({
        primaryVetName: 'Riverside Animal',
        primaryVetAddress: '82 Creekside Ln',
        primaryVetPhone: '555-0100',
      }),
    );
    render(<HouseholdVetPanels kinfolkId="k1" />);

    const link = await screen.findByRole('link', { name: '82 Creekside Ln' });
    expect(link).toHaveAttribute(
      'href',
      'https://www.google.com/maps/dir/?api=1&destination=82%20Creekside%20Ln',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('renders the emergency vet clinic address as a directions link too', async () => {
    getHouseholdData.mockResolvedValue(
      household({
        emergencyVetName: 'Night Owl Vet ER',
        emergencyVetAddress: '9 Late Night Rd',
      }),
    );
    render(<HouseholdVetPanels kinfolkId="k1" />);

    const link = await screen.findByRole('link', { name: '9 Late Night Rd' });
    expect(link).toHaveAttribute(
      'href',
      'https://www.google.com/maps/dir/?api=1&destination=9%20Late%20Night%20Rd',
    );
  });

  it('renders no vet panels at all when the household has no vet on file', async () => {
    getHouseholdData.mockResolvedValue(household());
    const { container } = render(<HouseholdVetPanels kinfolkId="k1" />);
    await waitFor(() => expect(getHouseholdData).toHaveBeenCalledWith('k1'));
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(screen.queryByRole('heading', { name: 'Vet clinic' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
