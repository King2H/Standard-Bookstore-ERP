// Frontend test setup — runs before every test file. Adds jest-dom's DOM
// matchers (toBeInTheDocument, toBeDisabled, etc.) to vitest's expect.
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// findBy* and waitFor give up after 1 s by default. A whole page (the
// Dashboard, the book form) can take longer to render on a busy machine, so
// they failed there while passing in CI (owner's PC, PR #196; reproduced on
// one CPU). They still fail well inside the 20 s test timeout.
configure({ asyncUtilTimeout: 10_000 });
