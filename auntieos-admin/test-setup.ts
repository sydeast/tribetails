import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only auto-cleans when vitest runs with `globals: true`, and we
// do not (MyTribe/web does the same, keeping the default 'node' environment for
// plain-logic specs). Without this, renders pile up in the same document and a
// query happily matches the PREVIOUS test's DOM, so an assertion can pass or fail
// for reasons that have nothing to do with the test that wrote it.
afterEach(cleanup);
