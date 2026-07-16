// Registers jest-dom's DOM matchers (toBeInTheDocument, toHaveTextContent,
// ...) on vitest's `expect`. Loaded for every spec via vitest.config.ts's
// `setupFiles` — harmless for the plain-logic *.test.ts files that never
// touch the DOM, since it only adds matchers rather than requiring one.
import '@testing-library/jest-dom/vitest';

// @testing-library/react's auto-cleanup only self-registers when it finds a
// GLOBAL `afterEach` (vitest.config.ts doesn't set `test.globals: true`, so
// that never happens here) — without this, every component spec in a file
// renders on top of the previous one's still-mounted DOM, and a second
// `screen.findByText(...)` match starts failing as "found multiple elements"
// the moment a file has more than one render() in it.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
