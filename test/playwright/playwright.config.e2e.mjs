import {defineConfig}                       from '@playwright/test';
import path                                 from 'path';
import {fileURLToPath}                      from 'url';
import {activeLaunchArgs, requiresGlProbe}  from './e2e/utils/gpuIntent.mjs';

/**
 * This suite defaults to the ENGINE profile, where the engine repository defaults to presenting.
 * The difference is not preference, it is what this app is:
 *
 * The header runs an OffscreenCanvas animation, and the `Activity (17y)` column runs one **per
 * mounted cell** — twenty to forty concurrent animations at a normal viewport, on top of a 50,000
 * record grid. That workload is present in every spec here regardless of what the spec asserts, so
 * the GPU-intent flags apply to all of them and `e2e/gl.setup.mjs` gates on their taking effect.
 *
 * The engine repository's opposite default is equally correct for it: most of its e2e suite is
 * functional, and `--disable-frame-rate-limit` suppresses headed compositing on retina hosts, which
 * starves `page.screenshot`. Nothing here captures screenshots.
 *
 * Set `NEO_E2E_ENGINE_PROFILE=0` to opt back into presenting — needed only if a spec here ever
 * starts capturing frames, which none currently does.
 *
 * **What evidences which flag class, because the two are easy to conflate.** The GPU-intent flags are
 * proven by the GL gate reporting `state=accelerated` on a real renderer — never by a timing. Frame
 * scheduling is proven by `GridProfile`'s own CPU breakdown, which reports roughly six times the
 * Scripting total uncapped (Mobile 815 → 4902 ms, Laptop 913 → 5310 ms). That is more work SAMPLED
 * in the same window, not slower work, and it is precisely why the two axes are split below.
 */
process.env.NEO_E2E_ENGINE_PROFILE ??= '1';

const __filename   = fileURLToPath(import.meta.url),
      __dirname    = path.dirname(__filename),
      REPO_ROOT    = path.resolve(__dirname, '../..'),
      PORT         = Number(process.env.DEVINDEX_E2E_PORT || 8090),
      launchArgs   = activeLaunchArgs(),
      needsGlProbe = requiresGlProbe(launchArgs);

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
 * `GridProfile` also emits wall-clock CPU totals. `.github/workflows/ci.yml` already records the same
 * hazard one job up, excluding the profiling specs because a shared runner can double their budget —
 * "a regression report for something that did not regress". That reasoning applies here harder, not
 * less. The engine repository reaches the same conclusion by the same route: nothing in its
 * workflows runs its e2e suite either.
 *
 * This is a local / pre-merge suite. Run it before touching the grid, the store or the scroll path.
 *
 * ## Provenance of `e2e/utils/gpuIntent.mjs`, `e2e/utils/glState.mjs`, `e2e/gl.setup.mjs`
 *
 * Byte-identical copies of the engine's, taken deliberately as a **temporary bridge**, not adopted as
 * a fork. They are generic browser-policy code with no DevIndex knowledge in them, and duplicating
 * generic policy is how two repositories quietly diverge on what "accelerated" means.
 *
 * **Retirement trigger:** the moment `neo.mjs` publishes a test-support surface that exports them —
 * or any consumer beyond this repository needs the same trio. Whoever hits either should delete these
 * three files and import instead. Until then the duplication is the cheaper of two bad options,
 * because the alternative is this suite having no acceleration gate at all.
 */
/**
 * Acceleration and frame scheduling are two axes, and only one of them is demanded.
 *
 * The operator's requirement is full GPU support — that is the GPU-intent flags, and it applies to
 * everything here, because the header canvas and the per-mounted-cell `Activity` canvases are
 * present in every spec regardless of what the spec asserts.
 *
 * `--disable-frame-rate-limit` is a different claim. Uncapping the compositor is right for a
 * profiler that wants to see the engine's real work rate, and wrong for a gesture spec that asserts
 * what a user would observe: a drag measured on an uncapped compositor is no longer representative
 * of the capped browser everyone actually runs. So the functional specs stay capped and only the
 * measurement project uncaps.
 *
 * Both share the same GPU-intent flags, so the GL gate below covers both.
 */
const CAPPED_ARGS = launchArgs.filter(arg => arg !== '--disable-frame-rate-limit'),

      functionalProject = {
          name      : 'chromium',
          testMatch : /e2e[\\/]grid[\\/].*\.spec\.mjs$/,
          use       : {channel: 'chrome', launchOptions: {args: CAPPED_ARGS}}
      },

      benchmarkProject = {
          name      : 'benchmark',
          testMatch : /e2e[\\/]benchmarks[\\/].*\.spec\.mjs$/,
          use       : {channel: 'chrome', launchOptions: {args: launchArgs}}
      };

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
        baseURL      : `http://localhost:${PORT}`,
        // Local Google Chrome rather than the bundled build: `npm ci` here does not run
        // `playwright install`, so the bundled chromium is absent on a fresh checkout and the run
        // fails at launch with a missing-executable error that looks like a config fault.
        channel      : 'chrome',
        trace        : 'on-first-retry',
        viewport     : {width: 1920, height: 1080}
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
    },

    // Boot gate. The engine profile above CLAIMS hardware acceleration; this observes that the flags
    // actually resolved to it, before a single benchmark attributes a number to a GPU it may not be
    // using. A canvas-per-mounted-cell app silently falling back to software rendering still passes
    // every assertion here — it just measures something else, which is the failure mode a green
    // suite cannot tell you about.
    //
    // It launches with the SAME args as the suite; probing a differently-configured browser would
    // prove nothing about this one.
    projects: needsGlProbe ? [{
        name     : 'gl-probe',
        testMatch: /gl\.setup\.mjs$/,
        use      : {channel: 'chrome', launchOptions: {args: launchArgs}}
    },
        {...functionalProject, dependencies: ['gl-probe']},
        {...benchmarkProject,  dependencies: ['gl-probe']}
    ] : [functionalProject, benchmarkProject]
});
