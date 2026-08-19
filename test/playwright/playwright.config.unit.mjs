import {defineConfig}  from '@playwright/test';
import path            from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/**
 * The engine's own unit config ships inside the `neo.mjs` package, and this repository deliberately
 * does NOT reuse it. Two reasons, both structural rather than stylistic:
 *
 * 1. Its `testDir` resolves against its own `__dirname`, so it collects the ENGINE's specs out of
 *    `node_modules`, not this workspace's.
 * 2. It declares a mandatory Chroma `webServer`. DevIndex has no Brain tier and no `chroma` binary,
 *    so every run would block on a service this app never talks to.
 *
 * What follows is therefore the minimum a pure-Node app suite needs, plus the one piece of hard-won
 * runtime knowledge that would otherwise have been left behind in the engine repo — see `profiling`.
 */
process.env.UNIT_TEST_MODE = 'true';

/**
 * The two wall-clock-budget specs.
 *
 * Both assert elapsed-time budgets, which only mean anything on an uncontended CPU: under parallel
 * workers the store-filter measurement has been observed at roughly double its budget purely from
 * scheduling contention, which reports as a product regression that does not exist.
 *
 * Keep this list narrow. A spec whose timing assertion is a RATIO or a loose timeout survives
 * contention and belongs in the bulk project — only a genuine wall-clock budget belongs here.
 * @type {RegExp}
 */
const profilingTestMatch = /[\\/]devindex[\\/](StoreFilter|GridScroll)Profile\.spec\.mjs$/;

export default defineConfig({
    testDir      : path.join(__dirname, 'unit'),
    outputDir    : path.join(__dirname, 'test-results/unit'),
    fullyParallel: true,
    forbidOnly   : !!process.env.CI,
    retries      : process.env.CI ? 2 : 0,
    workers      : process.env.CI ? 4 : undefined,
    reporter     : [['list'], ['json', {outputFile: path.join(__dirname, 'test-results/unit/test-results.json')}]],
    use          : {trace: 'on-first-retry'},

    projects: [{
        name      : 'unit',
        testIgnore: [profilingTestMatch]
    }, {
        // Isolation needs BOTH settings, because neither alone is sufficient:
        //
        //   `dependencies: ['unit']` is the BARRIER — this project does not start until the bulk
        //   suite has finished, so the contention that busts the budgets is already over. A worker
        //   cap alone would not achieve this: independent projects interleave up to the global
        //   maximum.
        //
        //   `workers: 1` is the cross-file SERIALIZER — `fullyParallel: false` only serializes
        //   within a single file, so the two profiling specs live in separate files and would still
        //   run concurrently with each other.
        //
        // Together they let the bulk suite go wide while each profiling spec measures truly alone.
        name         : 'unit-profiling',
        dependencies : ['unit'],
        testMatch    : profilingTestMatch,
        fullyParallel: false,
        workers      : 1
    }]
});
