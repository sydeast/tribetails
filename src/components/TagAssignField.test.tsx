// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagAssignField } from './TagAssignField';
import { TAG_PALETTE, type TagDef } from '../lib/tags/model';

const c = TAG_PALETTE[0]!;
function def(name: string, icon = ''): TagDef {
  return { name, color: c, icon };
}
const vocab = [def('VIP', '⭐'), def('Reactive'), def('Vet visit')];

describe('TagAssignField', () => {
  it('renders the current tags as removable chips', () => {
    render(<TagAssignField value={['VIP']} vocab={vocab} onChange={vi.fn()} />);
    expect(screen.getByText('VIP')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove vip tag/i })).toBeInTheDocument();
  });

  it('adds a tag by selecting an autocomplete suggestion (canonical vocab casing)', async () => {
    const onChange = vi.fn();
    render(<TagAssignField value={[]} vocab={vocab} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText(/add a tag/i), 'vi');
    await userEvent.click(await screen.findByRole('button', { name: /^⭐?\s*VIP$/i }));
    expect(onChange).toHaveBeenCalledWith(['VIP']);
  });

  it('adds a free-form tag on Enter', async () => {
    const onChange = vi.fn();
    render(<TagAssignField value={['VIP']} vocab={vocab} onChange={onChange} />);
    const input = screen.getByLabelText(/add a tag/i);
    await userEvent.type(input, 'Brand new{Enter}');
    expect(onChange).toHaveBeenCalledWith(['VIP', 'Brand new']);
  });

  it('removes a tag via its chip ×', async () => {
    const onChange = vi.fn();
    render(<TagAssignField value={['VIP', 'Reactive']} vocab={vocab} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /remove vip tag/i }));
    expect(onChange).toHaveBeenCalledWith(['Reactive']);
  });

  it('offers "add to your tags" for a new name and both assigns + creates it', async () => {
    const onChange = vi.fn();
    const onCreateVocab = vi.fn();
    render(<TagAssignField value={[]} vocab={vocab} onChange={onChange} onCreateVocab={onCreateVocab} />);
    await userEvent.type(screen.getByLabelText(/add a tag/i), 'Grooming');
    await userEvent.click(await screen.findByRole('button', { name: /add .*grooming.* to your tags/i }));
    expect(onCreateVocab).toHaveBeenCalledWith('Grooming');
    expect(onChange).toHaveBeenCalledWith(['Grooming']);
  });

  it('does not offer create for a name already in the vocabulary', async () => {
    render(<TagAssignField value={[]} vocab={vocab} onChange={vi.fn()} onCreateVocab={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/add a tag/i), 'vip');
    expect(screen.queryByRole('button', { name: /to your tags/i })).toBeNull();
  });
});
