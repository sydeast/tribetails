// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  it('dismisses suggestions on outside pointerdown', async () => {
    render(
      <div>
        <TagAssignField value={[]} vocab={vocab} onChange={vi.fn()} />
        <button type="button">Somewhere else</button>
      </div>,
    );
    await userEvent.type(screen.getByLabelText(/add a tag/i), 'vi');
    expect(await screen.findByRole('button', { name: /^⭐?\s*VIP$/i })).toBeInTheDocument();

    // No blur, no timers: a pointer landing outside the field closes the list
    // on its own. This is the case a focus-only guard misses, e.g. a press on
    // something that never takes focus.
    fireEvent.pointerDown(screen.getByRole('button', { name: /somewhere else/i }));

    expect(screen.queryByRole('button', { name: /^⭐?\s*VIP$/i })).toBeNull();
  });

  it('dismisses on blur without swallowing suggestion click', async () => {
    const onChange = vi.fn();
    render(<TagAssignField value={[]} vocab={vocab} onChange={onChange} />);
    const input = screen.getByLabelText(/add a tag/i);
    await userEvent.type(input, 'vi');
    const option = await screen.findByRole('button', { name: /^⭐?\s*VIP$/i });

    // The classic race: blur reaches the field before the suggestion's click.
    // The click must still land.
    fireEvent.blur(input);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(['VIP']);

    // And with focus gone for good, the list closes shortly after.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^⭐?\s*VIP$/i })).toBeNull();
    });
  });

  it('keeps existing Escape behavior', async () => {
    render(<TagAssignField value={[]} vocab={vocab} onChange={vi.fn()} onCreateVocab={vi.fn()} />);
    const input = screen.getByLabelText(/add a tag/i);
    await userEvent.type(input, 'Grooming');
    expect(await screen.findByRole('button', { name: /to your tags/i })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    expect(input).toHaveValue('');
    expect(screen.queryByRole('button', { name: /to your tags/i })).toBeNull();
  });
});
