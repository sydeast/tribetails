// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EntityCardGrid } from './EntityCardGrid';

/**
 * `EntityCardGrid` is the one definition behind the list-shape rule (see
 * `docs/2026-05-31-den-redesign-design.md`). Before it, three screens each
 * carried their own copy of the same `repeat(auto-fill, minmax(…, 1fr))`
 * declaration, which is how Directory, Vet clinics and Invites drifted to three
 * different card widths without anybody deciding to.
 *
 * jsdom ships no layout engine, so none of these assertions can look at a
 * computed grid. They assert the STATE CARRIERS instead: the role and
 * accessible name a screen reader reads, and the custom property the stylesheet
 * consumes. That is deliberate, and it is also why the visual harness
 * (`npm run visual:react`) is the other half of the proof rather than an extra.
 */
describe('EntityCardGrid', () => {
  it('renders a list semantic so a screen reader announces the count', () => {
    render(
      <EntityCardGrid label="Templates">
        <li>one</li>
        <li>two</li>
      </EntityCardGrid>,
    );

    expect(screen.getByRole('list', { name: 'Templates' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  /**
   * The mocks genuinely disagree on card width: Directory draws 290px
   * (`ui-ideas/auntieos-directory-2026-05-27.html`), Vet clinics 300px, and the
   * Template Bank 310px. One definition therefore has to take the number rather
   * than impose one, or standardizing the SHAPE would put two screens off-mock.
   */
  it('carries the caller card width as the custom property the grid reads', () => {
    render(
      <EntityCardGrid label="Kinfolk" minCardWidth="290px">
        <li>one</li>
      </EntityCardGrid>,
    );

    const grid = screen.getByRole('list', { name: 'Kinfolk' });
    expect(grid.style.getPropertyValue('--entity-card-min')).toBe('290px');
  });

  /** Omitting it leaves the stylesheet's own default in charge, not an inline blank. */
  it('sets no inline width when the caller does not name one', () => {
    render(
      <EntityCardGrid label="Clinics">
        <li>one</li>
      </EntityCardGrid>,
    );

    expect(
      screen.getByRole('list', { name: 'Clinics' }).style.getPropertyValue('--entity-card-min'),
    ).toBe('');
  });

  /**
   * Directory's cards hold a variable-length kin list, so they hang from the top
   * of the row instead of stretching to the tallest sibling. That is a real
   * per-screen choice, not a default: opting in keeps Directory's shipped
   * rendering byte-identical through this consolidation.
   */
  it('opts a screen into top alignment without changing the default', () => {
    const { rerender } = render(
      <EntityCardGrid label="Kinfolk" align="start">
        <li>one</li>
      </EntityCardGrid>,
    );
    expect(screen.getByRole('list', { name: 'Kinfolk' })).toHaveClass('entity-grid--start');

    rerender(
      <EntityCardGrid label="Kinfolk">
        <li>one</li>
      </EntityCardGrid>,
    );
    expect(screen.getByRole('list', { name: 'Kinfolk' })).not.toHaveClass('entity-grid--start');
  });
});
