// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Spinner } from './Spinner';
import { LoadingRow } from './LoadingRow';

/**
 * The animation itself is a stylesheet concern (Spinner.css) and is not
 * asserted here, jsdom does not run it. What is asserted is the accessibility
 * contract issue #714 asked for: a name a screen reader can say, and a busy
 * flag, without a second live region that would double-announce whatever
 * LoadingRow or AsyncRegion already wraps it in.
 */
describe('Spinner', () => {
  it('carries its label as an accessible name', () => {
    render(<Spinner label="Reading the connection" />);
    expect(screen.getByRole('img', { name: 'Reading the connection' })).toBeInTheDocument();
  });

  it('marks itself busy', () => {
    render(<Spinner label="Loading" />);
    expect(screen.getByRole('img', { name: 'Loading' })).toHaveAttribute('aria-busy', 'true');
  });

  it('claims no status role of its own, so a caller is free to own the live region', () => {
    render(<Spinner label="Loading" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('LoadingRow', () => {
  it('shows the sentence next to the spinner', () => {
    render(<LoadingRow label="Checking integrations…" />);
    expect(screen.getByText('Checking integrations…')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Checking integrations…' })).toBeInTheDocument();
  });

  it('hides the visible sentence from assistive tech, since the spinner already names it', () => {
    // Otherwise a screen reader says the same sentence twice: once for the
    // spinner's accessible name, once for the plain text next to it.
    const { container } = render(<LoadingRow label="Loading flags…" />);
    const visible = container.querySelector('[aria-hidden="true"]');
    expect(visible).toHaveTextContent('Loading flags…');
  });
});
