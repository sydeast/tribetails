// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BreedField } from './BreedField';

const DOGS = ['Border Collie', 'Boxer', 'Golden Retriever', 'Labrador Retriever'];

describe('BreedField', () => {
  it('shows the seeded bank when the field is opened with nothing typed', async () => {
    render(<BreedField value="" onChange={vi.fn()} catalog={DOGS} />);
    await userEvent.click(screen.getByLabelText('Breed'));
    const options = await screen.findAllByTestId('breedfield-option');
    expect(options.map((o) => o.textContent)).toEqual(DOGS);
  });

  it('commits the picked breed', async () => {
    const onChange = vi.fn();
    render(<BreedField value="" onChange={onChange} catalog={DOGS} />);
    await userEvent.click(screen.getByLabelText('Breed'));
    await userEvent.click(await screen.findByRole('option', { name: 'Boxer' }));
    expect(onChange).toHaveBeenCalledWith('Boxer');
  });

  it('keeps free text as the value, so a mix stays enterable', async () => {
    const onChange = vi.fn();
    render(<BreedField value="" onChange={onChange} catalog={DOGS} />);
    await userEvent.type(screen.getByLabelText('Breed'), 'L');
    expect(onChange).toHaveBeenCalledWith('L');
  });

  it('does not swallow Enter when no suggestion is highlighted', async () => {
    // The free-text contract: Enter belongs to the surrounding form unless the
    // operator is actively arrowing through suggestions.
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <BreedField value="Lab / pit mix" onChange={vi.fn()} catalog={DOGS} />
        <button type="submit">Save</button>
      </form>,
    );
    await userEvent.type(screen.getByLabelText('Breed'), '{Enter}');
    expect(onSubmit).toHaveBeenCalled();
  });

  it('commits the highlighted suggestion on Enter after arrowing to it', async () => {
    const onChange = vi.fn();
    render(<BreedField value="bo" onChange={onChange} catalog={DOGS} />);
    const input = screen.getByLabelText('Breed');
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('Boxer');
  });

  it('hides the list once the value exactly names a breed in the bank', async () => {
    render(<BreedField value="Boxer" onChange={vi.fn()} catalog={DOGS} />);
    await userEvent.click(screen.getByLabelText('Breed'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('degrades to a plain field with no popover when the species has no bank', async () => {
    render(<BreedField value="" onChange={vi.fn()} catalog={[]} />);
    await userEvent.click(screen.getByLabelText('Breed'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Breed')).toHaveValue('');
  });

  it('discloses a failed bank load rather than showing an empty dropdown silently', () => {
    render(
      <BreedField
        value=""
        onChange={vi.fn()}
        catalog={[]}
        note="Breed list unavailable right now, type it in."
      />,
    );
    expect(screen.getByTestId('breedfield-note')).toHaveTextContent(
      'Breed list unavailable right now, type it in.',
    );
  });

  it('closes on Escape without clearing what was typed', async () => {
    const onChange = vi.fn();
    render(<BreedField value="Bo" onChange={onChange} catalog={DOGS} />);
    const input = screen.getByLabelText('Breed');
    await userEvent.click(input);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('Bo');
    expect(onChange).not.toHaveBeenCalled();
  });
});
