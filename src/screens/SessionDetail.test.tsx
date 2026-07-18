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
    // Timing (start/end parseable), Kin (2 kinIds), and Notes sections all show.
    expect(screen.getByText('Timing')).toBeInTheDocument();
    expect(screen.getByText('Kin covered')).toBeInTheDocument();
    expect(screen.getByText('Bring the long leash.')).toBeInTheDocument();
  });

  it('omits all-blank sections (no Timing/Kin/Notes panels when those fields are empty)', () => {
    render(
      <SessionDetail
        entry={entry({ startTime: '', endTime: '', arrivedAt: '', completedAt: '', kinIds: [], notes: '' })}
        onBack={vi.fn()}
      />,
    );
    // The head still renders (household + chip), the blank sections do not.
    expect(screen.getByText('The Whitfields')).toBeInTheDocument();
    expect(screen.queryByText('Timing')).toBeNull();
    expect(screen.queryByText('Kin')).toBeNull();
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
