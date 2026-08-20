import {defineConfig}  from '@playwright/test';
import path            from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url),
      __dirname  = path.dirname(__filename),
      REPO_ROOT  = path.resolve(__dirname, '../..'),
      PORT       = Number(process.env.DEVINDEX_E2E_PORT || 8090);

/**
 * The engine ships an e2e config, and this repository deliberately does NOT reuse it — the same
 * structural reasoning `playwright.config.unit.mjs` records for the unit suite, plus one more:
 *
 * 1. Its `testDir` resolves against its own `__dirname`, so it would collect the ENGINE's specs out
 *    of `node_modules` rather than this workspace's.
 * 2. It carries a GPU-probe project, a benchmark system-info reporter and a Chroma-aware template
 *    resolver — infrastructure for measuring the engine, none of which these specs consult.
 * 3. Its `globalSetup` builds theme assets relative to ITS OWN location, which out of
 *    `node_modules` is the wrong `dist/`. See `e2e/globalSetup.mjs`.
 *
 * What follows is the minimum these five specs actually need.
 *
 * ## Why this suite is NOT wired into CI, and must not be
 *
 * Not an oversight, and not a TODO. Every spec here drives the real grid, which needs the real
 * `users.jsonl` — and that file is gitignored (`.gitignore:26`, zero tracked) while
 * `buildScripts/pullDevIndexData.mjs:49` deliberately skips its fetch when `CI` is set, because the
 * collection workflow fetches the index itself. So under CI there is no data, the body renders no
 * rows, and all eleven cases fail for a reason that has nothing to do with the code.
 *
 * Two of them are also wall-clock benchmarks. `.github/workflows/ci.yml` already records the same
 * hazard one job up, excluding the profiling specs because a shared runner can double their budget —
 * "a regression report for something that did not regress". That reasoning applies here harder, not
 * less. The engine repository reaches the same conclusion by the same route: nothing in its
 * workflows runs its e2e suite either.
 *
 * This is a local / pre-merge suite. Run it before touching the grid, the store or the scroll path.
 */
export default defineConfig({
    testDir      : path.join(__dirname, 'e2e'),
    outputDir    : path.join(__dirname, 'test-results/e2e'),
    // Serial by construction: two of these specs are wall-clock benchmarks, and a parallel worker
    // stealing CPU reports as a product regression that does not exist. The unit config isolates its
    // two profiling specs into a serialized project for exactly this reason; here every spec either
    // measures timing or drives a real pointer gesture, so the whole suite is the serial case.
    fullyParallel: false,
    workers      : 1,
    forbidOnly   : !!process.env.CI,
    retries      : 0,
    timeout      : 120000,
    reporter     : [['list'], ['json', {outputFile: path.join(__dirname, 'test-results/e2e/test-results.json')}]],
    globalSetup  : path.join(__dirname, 'e2e/globalSetup.mjs'),

    use: {
        baseURL : `http://localhost:${PORT}`,
        // Local Google Chrome rather than the bundled build: `npm ci` here does not run
        // `playwright install`, so the bundled chromium is absent on a fresh checkout and the run
        // fails at launch with a missing-executable error that looks like a config fault.
        channel : 'chrome',
        trace   : 'on-first-retry',
        viewport: {width: 1920, height: 1080}
    },

    webServer: {
        // `globalSetup` runs AFTER `webServer` starts, so the theme build is invoked here as well —
        // the hook then re-checks and no-ops. No `--prefix`: the command must serve the clone it was
        // launched from.
        command            : `node ./test/playwright/e2e/globalSetup.mjs && npm run server-start -- --port ${PORT} --no-open`,
        cwd                : REPO_ROOT,
        url                : `http://localhost:${PORT}/apps/devindex/index.html`,
        timeout            : 300000,
        // NEVER reuse: an already-listening server from another clone satisfies the readiness URL
        // and then serves the wrong tree to every spec — false reds and, worse, false greens.
        reuseExistingServer: false
    }
});
