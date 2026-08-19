import '@testing-library/jest-dom/vitest';
import { cleanup, configure, getConfig } from '@testing-library/react';
import { afterEach } from 'vitest';

// The SECOND deadline, and the one that hides. Raising vitest's `testTimeout`
// alone does not make this suite trustworthy, because Testing Library keeps a
// budget of its own: `findBy*` and `waitFor` give up after 1000ms and throw
// `Unable to find an accessible element...`. That reads like a real assertion
// failure -- the element genuinely was not there when the query gave up -- so
// it is far more misleading than a timeout, which at least announces itself.
//
// Measured with three copies of this suite running at once, five of the twelve
// failures were this, not a timeout: queries abandoning a Review step or a
// calendar gridcell that the contended event loop had simply not painted yet.
// Under that load the suite's own tests run 3.9x slower at the median and
// 13.2x at p95, so 1000ms buys roughly 75ms of unloaded margin.
//
// 5000 restores real margin while staying well inside the 30000ms per-test
// budget in vitest.config.ts, so a query that is never going to resolve is
// still reported by Testing Library, naming the element it wanted, rather than
// being cut off by vitest with no idea what it was waiting for. No spec here
// asserts absence by letting a `waitFor` reject, and none uses
// `waitForElementToBeRemoved`, so this cannot slow down a passing test, only
// one that was going to fail anyway.
configure({ asyncUtilTimeout: 5000 });

// Make that second shape announce itself.
//
// Raising the budget makes the failure rarer. It does not make it legible, and
// illegibility is the worse half of the problem. Under load this suite fails in
// two shapes: `Test timed out in 5000ms`, which says what it is, and `Unable to
// find an element with the text: ...`, which says nothing about the clock and
// reads exactly like a regression. Only the first is self-identifying, so
// anyone sorting flake from defect by searching for "timed out" silently
// misfiles every instance of the second -- and will eventually wave through a
// real regression wearing that costume, which is the whole complaint in #455.
//
// So when a query fails having used up essentially its whole budget, say so.
// The elapsed time is the evidence that separates "the app rendered the wrong
// thing" (fails fast, the DOM was there and did not match) from "nothing had
// rendered yet" (fails at the deadline). The wording deliberately contains the
// words "timed out" so the obvious grep finds this shape too.
//
// This composes with the wrapper already in place rather than replacing it:
// React Testing Library installs its own `asyncWrapper` to drive `act()`, and
// dropping that would break every async test in the suite.
//
// One caveat worth knowing before it confuses somebody. The elapsed time comes
// from `Date.now()`, which `vi.useFakeTimers()` fakes. A spec that advances
// fake time by seconds inside a `waitFor` that then fails on its merits could
// therefore collect a deadline notice it does not deserve. No spec does that
// today, and the cost is a misleading paragraph rather than a wrong verdict,
// but that is the explanation if you ever see the notice where it makes no
// sense.
const wrapped = getConfig().asyncWrapper;
configure({
  asyncWrapper: async (cb) => {
    const started = Date.now();
    try {
      return await wrapped(cb);
    } catch (error) {
      const elapsed = Date.now() - started;
      const budget = getConfig().asyncUtilTimeout;
      // Only a query that ran to the end of the clock. One that failed early
      // failed on its merits and its message is already the right message.
      if (error instanceof Error && elapsed >= budget * 0.9) {
        error.message =
          `Timed out after ${elapsed}ms waiting for this query ` +
          `(asyncUtilTimeout is ${budget}ms).\nThis is a DEADLINE, not proof the app ` +
          `rendered the wrong thing: nothing matched before the clock ran out, which on a ` +
          `loaded machine is usually the clock. Re-run this file on its own before treating ` +
          `it as a regression. See #455.\n\n${error.message}`;
      }
      throw error;
    }
  },
});

// Testing Library only auto-cleans when vitest runs with `globals: true`, and we
// do not (MyTribe/web does the same, keeping the default 'node' environment for
// plain-logic specs). Without this, renders pile up in the same document and a
// query happily matches the PREVIOUS test's DOM, so an assertion can pass or fail
// for reasons that have nothing to do with the test that wrote it.
afterEach(cleanup);
