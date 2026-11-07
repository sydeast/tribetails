// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Kinfolk } from '../api/directory';

const h = vi.hoisted(() => ({
  doc: { current: { status: 'loading' } as unknown },
  props: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ kinfolkId: 'W8S3qdqZOzXOVtGGSDVK' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('../lib/firestore', () => ({ useDocById: () => h.doc.current }));
vi.mock('../screens/HouseholdMembers', () => ({
  HouseholdMembers: (p: { kinfolkId: string; kinfolkName?: string }) => {
    h.props(p);
    return <div>members screen for {p.kinfolkName}</div>;
  },
}));

import { HouseholdMembersView } from './HouseholdMembersView';

beforeEach(() => h.props.mockReset());

/** #1589: the route has only the id; the household's name must reach the screen. */
describe('HouseholdMembersView', () => {
  it('hands the household display name down, never the id', () => {
    h.doc.current = {
      status: 'ready',
      data: { _id: 'W8S3qdqZOzXOVtGGSDVK', firstName: 'Dre', lastName: 'East' } as unknown as Kinfolk,
    };
    render(<HouseholdMembersView />);
    expect(screen.getByText('members screen for Dre East')).toBeInTheDocument();
    expect(h.props.mock.calls[0]![0].kinfolkName).toBe('Dre East');
  });

  it('shows a loading cue and does not flash the id while the name loads', () => {
    h.doc.current = { status: 'loading' };
    render(<HouseholdMembersView />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(h.props).not.toHaveBeenCalled();
  });

  it('says so when the household cannot be read or is gone', () => {
    h.doc.current = { status: 'error', message: 'denied' };
    const { unmount } = render(<HouseholdMembersView />);
    expect(screen.getByText(/Couldn't load this household: denied/)).toBeInTheDocument();
    unmount();
    h.doc.current = { status: 'ready', data: null };
    render(<HouseholdMembersView />);
    expect(screen.getByText('This household is not on file.')).toBeInTheDocument();
    expect(h.props).not.toHaveBeenCalled();
  });
});
