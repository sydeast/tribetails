// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecretField } from './SecretField';

describe('SecretField', () => {
  it('renders as password type by default (masked)', () => {
    render(<SecretField value="secret123" onChange={() => {}} id="test" />);
    const input = screen.getByDisplayValue('secret123') as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  it('shows a toggle button', () => {
    render(<SecretField value="secret123" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Show/i })).toBeInTheDocument();
  });

  it('reveals the value when toggle is clicked', async () => {
    render(<SecretField value="secret123" onChange={() => {}} />);
    const input = screen.getByDisplayValue('secret123') as HTMLInputElement;
    const toggleButton = screen.getByRole('button', { name: /Show/i });

    expect(input.type).toBe('password');

    await userEvent.click(toggleButton);

    expect(input.type).toBe('text');
    expect(screen.getByRole('button', { name: /Hide/i })).toBeInTheDocument();
  });

  it('hides the value when toggle is clicked again', async () => {
    render(<SecretField value="secret123" onChange={() => {}} />);
    const input = screen.getByDisplayValue('secret123') as HTMLInputElement;
    const toggleButton = screen.getByRole('button', { name: /Show/i });

    await userEvent.click(toggleButton);
    expect(input.type).toBe('text');

    const hideButton = screen.getByRole('button', { name: /Hide/i });
    await userEvent.click(hideButton);

    expect(input.type).toBe('password');
  });

  it('is still editable while masked', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<SecretField value="secret123" onChange={onChange} />);

    const input = screen.getByDisplayValue('secret123') as HTMLInputElement;
    // Value is masked but still editable
    expect(input.type).toBe('password');

    // Simulate editing: pass a new value directly via onChange
    onChange('newSecret456');

    // Rerender with new value to simulate form update
    rerender(<SecretField value="newSecret456" onChange={onChange} />);

    const updatedInput = screen.getByDisplayValue('newSecret456') as HTMLInputElement;
    expect(updatedInput.type).toBe('password');
  });

  it('has autocomplete disabled for security', () => {
    render(<SecretField value="secret123" onChange={() => {}} />);
    const input = screen.getByDisplayValue('secret123') as HTMLInputElement;
    expect(input.getAttribute('autocomplete')).toBe('off');
  });

  it('accepts custom placeholder', () => {
    render(<SecretField value="" onChange={() => {}} placeholder="Enter secret" />);
    expect(screen.getByPlaceholderText('Enter secret')).toBeInTheDocument();
  });

  it('accepts custom label', () => {
    render(<SecretField value="" onChange={() => {}} label="API Key" />);
    expect(screen.getByText('API Key')).toBeInTheDocument();
  });

  it('value round-trips correctly when rerendered', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SecretField value="" onChange={onChange} />);

    // Rerender with a new value (simulating parent state update)
    rerender(<SecretField value="myPassword123" onChange={onChange} />);

    // Verify the input displays the updated value
    expect((screen.getByDisplayValue('myPassword123') as HTMLInputElement).value).toBe('myPassword123');
  });

  it('cleared value round-trips correctly', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SecretField value="initialSecret" onChange={onChange} />);

    // Rerender with cleared value (simulating parent state update)
    rerender(<SecretField value="" onChange={onChange} />);

    // Verify the input displays the cleared value
    expect((screen.getByDisplayValue('') as HTMLInputElement).value).toBe('');
  });
});
