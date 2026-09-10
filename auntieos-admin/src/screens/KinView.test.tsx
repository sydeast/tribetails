// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { KinDetail } from '../api/kinView';

// The household step is a real route link, and a real `Link` wants a
// RouterProvider no suite in this tree mounts (AppShell.test.tsx convention).
vi.mock('@tanstack/react-router', () => ({
  linkOptions: (o: unknown) => o,
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce((p, [k, v]) => p.replace(`$${k}`, v), to)}
      {...rest}
    >
      {children}
    </a>
  ),
}));

const { getKin } = vi.hoisted(() => ({ getKin: vi.fn() }));
vi.mock('../api/kinView', async (orig) => ({
  ...(await orig<typeof import('../api/kinView')>()),
  getKin,
}));
// The Tags panel (ProfileTagsSection) loads the vocab + persists tag edits.
const getBusinessSettings = vi.fn();
vi.mock('../api/settings', () => ({ getBusinessSettings: () => getBusinessSettings() }));
const saveBusinessSettings = vi.fn();
vi.mock('../api/settingsWrite', () => ({ saveBusinessSettings: (patch: unknown) => saveBusinessSettings(patch) }));
const { updateKinTags } = vi.hoisted(() => ({ updateKinTags: vi.fn() }));
vi.mock('../api/directoryWrite', async (orig) => ({
  ...(await orig<typeof import('../api/directoryWrite')>()),
  updateKinTags,
}));

import { KinView } from './KinView';
import { mergeKinDetail } from '../api/kinView';

function kin(over: Partial<KinDetail> = {}): KinDetail {
  return mergeKinDetail('p1', { name: 'Willow', species: 'Dog', breed: 'Lab', age: '4', sex: 'F', ...over });
}

beforeEach(() => {
  getKin.mockReset();
  getBusinessSettings.mockReset();
  getBusinessSettings.mockResolvedValue({ householdTags: [], petTags: [] });
  saveBusinessSettings.mockReset();
  saveBusinessSettings.mockResolvedValue({ updatedAt: 'now', updatedBy: 'auntie' });
  updateKinTags.mockReset();
  updateKinTags.mockResolvedValue(undefined);
});

describe('mergeKinDetail (pure)', () => {
  it('defaults strings + coerces booleans, never undefined', () => {
    const k = mergeKinDetail('p9', { name: 'Rex', reactive: true, spayedNeutered: 'yes' as unknown as boolean });
    expect(k._id).toBe('p9');
    expect(k.name).toBe('Rex');
    expect(k.reactive).toBe(true);
    expect(k.spayedNeutered).toBe(false); // non-true value -> false, not "yes"
    expect(k.vetInfo).toBe('');
  });

  it('reads tags string-only, defaulting a missing/legacy field to []', () => {
    expect(mergeKinDetail('p1', {}).tags).toEqual([]); // legacy doc, no tags field
    expect(mergeKinDetail('p1', { tags: ['Reactive', 42, 'Meds'] }).tags).toEqual(['Reactive', 'Meds']);
    expect(mergeKinDetail('p1', { tags: 'nope' }).tags).toEqual([]); // not an array
  });
});

describe('KinView', () => {
  it('loads and renders basics', async () => {
    getKin.mockResolvedValue(kin({ weight: '52 lbs', colorMarkings: 'Black' }));
    render(<KinView kinId="p1" kinName="Willow" onBack={vi.fn()} />);
    expect(await screen.findByText('52 lbs')).toBeInTheDocument();
    expect(screen.getByText('Black')).toBeInTheDocument();
    expect(getKin).toHaveBeenCalledWith('p1');
  });

  it('marks a reactive pet with a small alert pill under the Kin box, not a page banner', async () => {
    getKin.mockResolvedValue(kin({ reactive: true, routine: 'Slow approach' }));
    render(<KinView kinId="p1" kinName="Willow" onBack={vi.fn()} />);
    expect(await screen.findByText(/handle with care/i)).toBeInTheDocument();
    // No page-level banner: a banner carries role="alert" (Banner.tsx), the
    // marker does not.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Slow approach')).toBeInTheDocument();
  });

  it('omits all-blank sections (no empty Health/Feeding panels)', async () => {
    getKin.mockResolvedValue(kin());
    render(<KinView kinId="p1" kinName="Willow" onBack={vi.fn()} />);
    await screen.findByText('Basics');
    expect(screen.queryByText('Health')).toBeNull();
    expect(screen.queryByText('Feeding')).toBeNull();
    expect(screen.queryByText(/handle with care/i)).toBeNull();
  });

  it('has no "Kin profile." subtitle under the name', async () => {
    getKin.mockResolvedValue(kin());
    render(<KinView kinId="p1" kinName="Willow" onBack={vi.fn()} />);
    await screen.findByText('Basics');
    expect(screen.queryByText('Kin profile.')).toBeNull();
  });

  it('calls onBack from the Back control', async () => {
    getKin.mockResolvedValue(kin());
    const onBack = vi.fn();
    render(<KinView kinId="p1" kinName="Willow" onBack={onBack} />);
    await userEvent.click(await screen.findByRole('button', { name: /back to directory/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('shows and edits pet tags, saving via updateKinTags', async () => {
    getKin.mockResolvedValue(kin({ tags: ['Reactive'] }));
    render(<KinView kinId="p1" kinName="Willow" onBack={vi.fn()} />);
    expect(await screen.findByText('Reactive')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/add a pet tag/i), 'On meds{Enter}');
    await waitFor(() => expect(updateKinTags).toHaveBeenCalledWith('p1', ['Reactive', 'On meds']));
  });
});

/**
 * Item 7b, against `auntieos-kin-detail-2026-05-27.html`, whose trail reads
 * `Directory / Lorna Wren / Biscuit`.
 */
describe('KinView: breadcrumbs', () => {
  it('puts the household between the Directory and the pet', async () => {
    getKin.mockResolvedValue(kin());
    render(
      <KinView
        kinId="p1"
        kinName="Willow"
        household={{ id: 'kf-1', name: 'the Wrens' }}
        onBack={vi.fn()}
      />,
    );
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    // A real route link, because this view sits on /directory and the household
    // profile is somewhere else.
    expect(within(nav).getByRole('link', { name: 'the Wrens' })).toHaveAttribute(
      'href',
      '/directory/kf-1',
    );
    expect(within(nav).getByText('Willow')).toHaveAttribute('aria-current', 'page');
  });

  /**
   * The household step is DROPPED, not filled in, when the Directory could not
   * resolve which home the pet lives in. A trail step is a claim about where
   * you are, and a guessed one points at a household the pet does not live in,
   * which is worse than a shorter trail.
   */
  it('omits the household step rather than guessing at one', async () => {
    getKin.mockResolvedValue(kin());
    render(<KinView kinId="p1" kinName="Willow" onBack={vi.fn()} />);
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
    expect(within(nav).getAllByRole('listitem')).toHaveLength(2);
  });

  it('walks back to the list from the trail', async () => {
    getKin.mockResolvedValue(kin());
    const onBack = vi.fn();
    render(<KinView kinId="p1" kinName="Willow" onBack={onBack} />);
    const nav = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await userEvent.click(within(nav).getByRole('button', { name: 'Directory' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
