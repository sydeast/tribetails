// Restores jest-dom's matcher types (toBeInTheDocument, toHaveValue, ...) on
// vitest's `expect()`, which @testing-library/jest-dom@7.0.1 no longer does
// for vitest 5.
//
// Two things changed between vitest 4 and vitest 5:
//
// 1. vitest 4's `JestAssertion<T>` extended the global `namespace jest {
//    interface Matchers<R, T> }`, and jest-dom's `types/jest.d.ts` (loaded
//    automatically here via tsconfig's `"types": [..., "@testing-library/
//    jest-dom"]`) augmented exactly that global interface. vitest 5's
//    `JestAssertion<R, T>` no longer touches the `jest` namespace at all, so
//    that bridge is gone.
// 2. jest-dom also ships a `types/vitest.d.ts` that augments `vitest`'s own
//    `Assertion` interface directly, loaded only via the runtime side-effect
//    import `@testing-library/jest-dom/vitest` in test-setup.ts. But
//    test-setup.ts lives outside this project's tsconfig `include` (it's
//    wired in purely as vitest's `setupFiles`, which `tsc` never follows), so
//    `tsc --noEmit` never sees that file either.
//
// Net effect: none of jest-dom's matcher types reach `expect()`'s result
// type under vitest 5, producing `Property 'toBeInTheDocument' does not
// exist on type 'Assertion<void, HTMLElement>'` (TS2339) everywhere.
//
// `Matchers<R, T>` is vitest's own, intentionally-empty extension point for
// exactly this (`Assertion` already extends it), so augment that directly
// instead of relying on jest-dom's broken bridges. Delete this file once
// jest-dom ships a release whose vitest augmentation targets `Matchers` (or
// is reachable here) for vitest 5.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > extends TestingLibraryMatchers<T, R> {}
}
