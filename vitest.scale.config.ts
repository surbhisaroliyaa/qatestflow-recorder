import { defineConfig } from 'vitest/config'

// The 120-test RUN proof (`npm run test:scale`) — kept out of `npm test` on
// purpose. It launches real headless Chromium for every test, which takes
// minutes, and `npm test` has to stay at about a second so it is run
// constantly (and by the pre-commit hook). See test-scale/run-scale.test.ts.
export default defineConfig({
  test: {
    include: ['test-scale/**/*.test.ts'],
    environment: 'node',
    // The run itself is bounded inside the test; this is only the outer net.
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000
  }
})
