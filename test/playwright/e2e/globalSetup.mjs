import {execFile}       from 'node:child_process';
import fs               from 'node:fs';
import path             from 'node:path';
import {pathToFileURL}  from 'node:url';
import {promisify}      from 'node:util';

const execFileAsync = promisify(execFile),
      REPO_ROOT     = path.resolve(import.meta.dirname, '../../..'),
      CSS_ROOT      = path.join(REPO_ROOT, 'dist/development/css');

/**
 * @summary Guarantees a development theme build exists before any browser starts.
 *
 * Without `dist/development/css`, the app still boots and the grid header still renders — so the
 * page looks alive — but the body computes to `height: 0`, row virtualization derives zero visible
 * rows from it, and every row-dependent assertion fails while the footer cheerfully reports 50,000
 * records. That reads exactly like a data-layer or engine fault and is neither.
 *
 * This is written here rather than reused from the engine for two independent reasons, both
 * verified rather than assumed:
 *
 * 1. `neo.mjs`'s own `buildScripts/util/developmentThemeAssets.mjs` derives its target from
 *    `import.meta.dirname`, so imported out of `node_modules` it would build into
 *    `node_modules/neo.mjs/dist/` — never this workspace's `dist/`.
 * 2. It is not in the published package at the version this repository consumes.
 *
 * The same standalone reasoning the unit config records for itself, one layer down.
 */
export default async function globalSetup() {
    if (fs.existsSync(CSS_ROOT) && fs.readdirSync(CSS_ROOT).length > 0) {
        return
    }

    // `npm run build-themes` prompts interactively and cannot be scripted; the flags below are the
    // non-interactive form of the same build.
    await execFileAsync('node', [
        './node_modules/neo.mjs/buildScripts/build/themes.mjs', '-f', '-n', '-e', 'dev', '-t', 'all'
    ], {cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024})
}

// Playwright starts `webServer` before its `globalSetup` hook, so running this module as the first
// web-server command step closes that ordering gap; the later hook then re-checks and no-ops.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await globalSetup()
}
