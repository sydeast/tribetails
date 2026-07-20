// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagChip } from './TagChip';
import { TAG_PALETTE, type TagDef } from '../lib/tags/model';

const orange = TAG_PALETTE[1]!;
const vocab: TagDef[] = [
  { name: 'VIP', color: orange, icon: '⭐' },
  { name: 'Reactive', color: TAG_PALETTE[4]!, icon: '' },
];

describe('TagChip', () => {
  it('renders the resolved name, emoji, and tone for a vocab hit (case-insensitive)', () => {
    render(<TagChip name="vip" vocab={vocab} />);
    const chip = screen.getByText('VIP').closest('.tag-chip') as HTMLElement;
    expect(chip).toHaveAttribute('data-token', 'orange');
    expect(chip).not.toHaveClass('tag-chip--neutral');
    expect(chip.style.getPropertyValue('--tag-tone')).toBe(orange.css);
    expect(screen.getByText('⭐')).toBeInTheDocument();
  });

  it('renders a vocab hit with no emoji (color kept, no icon glyph)', () => {
    render(<TagChip name="Reactive" vocab={vocab} />);
    const chip = screen.getByText('Reactive').closest('.tag-chip') as HTMLElement;
    expect(chip).toHaveAttribute('data-token', 'coral');
    expect(chip.querySelector('.tag-chip__icon')).toBeNull();
  });

  it('renders a neutral chip for an unknown/free-form name, no tone, no emoji', () => {
    render(<TagChip name="brand new" vocab={vocab} />);
    const chip = screen.getByText('brand new').closest('.tag-chip') as HTMLElement;
    expect(chip).toHaveClass('tag-chip--neutral');
    expect(chip).not.toHaveAttribute('data-token');
    expect(chip.style.getPropertyValue('--tag-tone')).toBe('');
  });

  it('shows no remove control unless onRemove is given', () => {
    render(<TagChip name="VIP" vocab={vocab} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('calls onRemove when the × is clicked', async () => {
    const onRemove = vi.fn();
    render(<TagChip name="VIP" vocab={vocab} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: /remove vip tag/i }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
