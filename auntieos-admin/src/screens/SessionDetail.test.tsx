// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type SessionEntry } from '../api/sessions';
import { SessionDetail } from './SessionDetail';

function entry(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    _id: 'sess1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    kinIds: ['p1', 'p2'],
    kinNames: ['Biscuit', 'Gravy'],
    serviceType: 'Dog Walk',
    startTime: '2026-07-16T14:00:00.000Z',
    arrivedAt: '',
    endTime: '2026-07-16T15:00:00.000Z',
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  };
}

describe('SessionDetail', () => {
  it('renders the session fields from the passed entry (by value, no fetch)', () => {
    render(<SessionDetail entry={entry({ notes: 'Bring the long leash.' })} onBack={vi.fn()} />);
    expect(screen.getByText('The Whitfields')).toBeInTheDocument();
    expect(screen.getByText('Dog Walk')).toBeInTheDocument();
    expect(screen.getByText('SCHEDULED')).toBeInTheDocument();
    // Timing (start/end parseable), Kin, and Notes sections all show.
    expect(screen.getByText('Timing')).toBeInTheDocument();
    expect(screen.getByText('Kin covered')).toBeInTheDocument();
    expect(screen.getByText('Bring the long leash.')).toBeInTheDocument();
  });

  // R1: a KinCare session covers every Kin in the home, so the panel NAMES them
  // rather than reporting a bare count an operator cannot check against a home.
  it('names the Kin this session covers', () => {
    render(<SessionDetail entry={entry()} onBack={vi.fn()} />);
    expect(screen.getByText('Biscuit, Gravy')).toBeInTheDocument();
  });

  it('discloses Kin that are covered but carry no name, instead of under-reporting', () => {
    render(<SessionDetail entry={entry({ kinNames: ['Biscuit'] })} onBack={vi.fn()} />);
    expect(screen.getByText('Biscuit')).toBeInTheDocument();
    expect(screen.getByText('Unnamed Kin')).toBeInTheDocument();
  });

  it('falls back to a count when a pre-R1 doc has ids but no names', () => {
    render(<SessionDetail entry={entry({ kinNames: [] })} onBack={vi.fn()} />);
    expect(screen.getByText('2 (names not on file)')).toBeInTheDocument();
  });

  // R1 regression: the Kin panel used to be HIDDEN whenever kinIds was empty,
  // and empty was exactly how a whole-household booking was stored. The panel
  // now always renders and says what it does and does not know.
  it('still shows the Kin panel when the record carries no Kin at all', () => {
    render(<SessionDetail entry={entry({ kinIds: [], kinNames: [] })} onBack={vi.fn()} />);
    expect(screen.getByText('Kin')).toBeInTheDocument();
    expect(screen.getByText(/No Kin are recorded on this session/i)).toBeInTheDocument();
  });

  it('omits all-blank sections (no Timing/Notes panels when those fields are empty)', () => {
    render(
      <SessionDetail
        entry={entry({ startTime: '', endTime: '', arrivedAt: '', completedAt: '', kinIds: [], kinNames: [], notes: '' })}
        onBack={vi.fn()}
      />,
    );
    // The head still renders (household + chip), the blank sections do not.
    expect(screen.getByText('The Whitfields')).toBeInTheDocument();
    expect(screen.queryByText('Timing')).toBeNull();
    expect(screen.queryByText('Notes')).toBeNull();
  });

  it('shows an honest unavailable state when the entry does not resolve (null), never a blank detail', () => {
    render(<SessionDetail entry={null} onBack={vi.fn()} />);
    expect(screen.getByText(/no longer available/i)).toBeInTheDocument();
  });

  it('AO-12 guard: an unrecognized status reads UNKNOWN, never a fabricated SCHEDULED', () => {
    render(<SessionDetail entry={entry({ status: 'some_new_code' })} onBack={vi.fn()} />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText('SCHEDULED')).toBeNull();
  });

  it('calls onBack from the Back control', async () => {
    const onBack = vi.fn();
    render(<SessionDetail entry={entry()} onBack={onBack} />);
    await userEvent.click(screen.getByRole('button', { name: /back to auntie time/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
