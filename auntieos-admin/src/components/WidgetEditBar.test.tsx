// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WidgetEditBar, type WidgetEditBarProps } from './WidgetEditBar';

function setup(over: Partial<WidgetEditBarProps> = {}) {
  const props: WidgetEditBarProps = {
    label: 'Care flags',
    size: 'compact',
    canMoveUp: true,
    canMoveDown: true,
    canResize: true,
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onResize: vi.fn(),
    onRemove: vi.fn(),
    ...over,
  };
  render(<WidgetEditBar {...props} />);
  return props;
}

describe('WidgetEditBar', () => {
  it('names every control after the widget it acts on', () => {
    setup();
    // Four buttons, four names, none of them a bare arrow. Repeated down a
    // seven-card board, "Up" tells a screen reader user nothing about which
    // card is about to move.
    expect(screen.getByRole('button', { name: 'Move Care flags up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Care flags down' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make Care flags full width' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove Care flags from Home' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('shows the widget name and its current size', () => {
    setup({ size: 'wide' });
    expect(screen.getByText('Care flags')).toBeInTheDocument();
    // The resize button's name says what it will DO, which is the opposite
    // word, so the current state is shown separately or it cannot be read.
    expect(screen.getByText('Full width')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make Care flags half width' })).toBeInTheDocument();
  });

  it('reports the size the operator asked for, not a toggle', () => {
    const props = setup({ size: 'compact' });
    fireEvent.click(screen.getByRole('button', { name: 'Make Care flags full width' }));
    expect(props.onResize).toHaveBeenCalledWith('wide');
  });

  it('reports the other direction from a wide widget', () => {
    const props = setup({ size: 'wide' });
    fireEvent.click(screen.getByRole('button', { name: 'Make Care flags half width' }));
    expect(props.onResize).toHaveBeenCalledWith('compact');
  });

  it('moves and removes through the callbacks', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Move Care flags up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Care flags down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Care flags from Home' }));
    expect(props.onMoveUp).toHaveBeenCalledTimes(1);
    expect(props.onMoveDown).toHaveBeenCalledTimes(1);
    expect(props.onRemove).toHaveBeenCalledTimes(1);
  });

  it('genuinely disables a move that would be a no-op, rather than styling it out', () => {
    // The model's move helpers return the list unchanged out of bounds. A
    // button that still fires would announce a move that did not happen.
    const props = setup({ canMoveUp: false });
    const up = screen.getByRole('button', { name: 'Move Care flags up' });
    expect(up).toBeDisabled();
    fireEvent.click(up);
    expect(props.onMoveUp).not.toHaveBeenCalled();
  });

  it('disables the down control at the bottom of the board', () => {
    setup({ canMoveDown: false });
    expect(screen.getByRole('button', { name: 'Move Care flags down' })).toBeDisabled();
  });

  it('omits resize entirely where the model refuses it', () => {
    // `stats` is forced wide by setWidgetSize, so offering the control would
    // offer a change that silently does nothing.
    setup({ label: 'Stats', size: 'wide', canResize: false });
    expect(screen.queryByRole('button', { name: /width/ })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });
});
