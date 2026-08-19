// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, configure, getConfig } from '@testing-library/react';

/**
 * Guards the deadline notice installed in `test-setup.ts` (see #455).
 *
 * Under load this suite fails in two shapes, and only one of them used to say
 * so. `Test timed out in 5000ms` announces itself; `Unable to find an element
 * with the text: ...` looks exactly like a regression even when the only thing
 * that went wrong is that the machine was busy. Sorting flake from defect by
 * searching for "timed out" therefore misfiled every instance of the second
 * shape, which is how a red admin suite stopped meaning anything.
 *
 * These specs pin the distinction, because it is the kind of thing that gets
 * quietly dropped the next time somebody tidies the setup file. They shorten
 * `asyncUtilTimeout` so a deliberate miss costs milliseconds rather than the
 * real 5s budget.
 */
describe('a Testing Library query that runs out of time', () => {
  const original = getConfig().asyncUtilTimeout;
  afterEach(() => {
    configure({ asyncUtilTimeout: original });
  });

  it('reports itself as a timeout, so the usual grep for flake finds this shape too', async () => {
    configure({ asyncUtilTimeout: 50 });
    render(<div>present</div>);

    await expect(screen.findByText('never rendered')).rejects.toThrow(/timed out after \d+ms/i);
  });

  it('names the elapsed time and the budget it was measured against', async () => {
    configure({ asyncUtilTimeout: 50 });
    render(<div>present</div>);

    await expect(screen.findByText('never rendered')).rejects.toThrow(
      /asyncUtilTimeout is 50ms/,
    );
  });

  it('says a deadline is not proof the app rendered the wrong thing', async () => {
    configure({ asyncUtilTimeout: 50 });
    render(<div>present</div>);

    await expect(screen.findByText('never rendered')).rejects.toThrow(/DEADLINE/);
  });

  it('still carries the original message naming what it looked for', async () => {
    configure({ asyncUtilTimeout: 50 });
    render(<div>present</div>);

    await expect(screen.findByText('never rendered')).rejects.toThrow(/never rendered/);
  });

  it('leaves a query that fails on its merits alone, with no deadline notice', async () => {
    configure({ asyncUtilTimeout: 50 });
    render(<div>present</div>);

    // `getBy` fails immediately against the DOM that is already there, so it
    // spends none of the budget and its message must not be rewritten.
    expect(() => screen.getByText('never rendered')).toThrow(/never rendered/);
    expect(() => screen.getByText('never rendered')).not.toThrow(/timed out after/i);
  });

  it('does not touch a query that resolves inside its budget', async () => {
    configure({ asyncUtilTimeout: 50 });
    render(<div>present</div>);

    await expect(screen.findByText('present')).resolves.toBeInTheDocument();
  });
});
