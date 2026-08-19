import fs   from 'fs';
import path from 'path';

/**
 * @summary Places `marked` where the engine's Markdown imports expect it, until the engine bundles it.
 *
 * **The defect.** `neo.mjs` reaches `marked` through two relative specifiers that leave the package:
 *
 * ```
 * src/component/Markdown.mjs    →  '../../node_modules/marked/lib/marked.esm.js'
 * src/app/content/Component.mjs →  '../../../node_modules/marked/lib/marked.esm.js'
 * ```
 *
 * Inside the engine's own repository those land on the repo-root `node_modules/`. Inside a workspace
 * the engine is itself under `node_modules/neo.mjs/`, so the same specifiers land on
 * `node_modules/neo.mjs/node_modules/marked/` — where npm's flat install never puts it. Every
 * consumer of `Neo.component.Markdown` therefore fails with a dynamic-import error, which for this
 * app is the entire Learn section.
 *
 * **Why the engine uses a path at all**, rather than the obvious `import {marked} from 'marked'`:
 * Neo executes application logic in Web Workers, and import maps have never been supported in worker
 * scope. Bare specifiers are simply unavailable there, so every third-party ESM dependency has to be
 * reachable by path. That is a browser platform gap, not an engine shortcut.
 *
 * **The engine already solved this twice.** `parse5` and `highlight.js` are bundled into the engine's
 * OWN `dist/` and imported as `'../../../dist/parse5.mjs'` — a path that never leaves the package, so
 * it resolves identically whether neo is the repository or a dependency. `marked` is the one
 * third-party ESM dependency that never received that treatment.
 *
 * **This script is therefore a bridge, and it retires itself.** The moment the engine ships
 * `dist/marked.mjs`, the condition below goes false and this becomes a no-op that announces why —
 * rather than a workaround that silently outlives the bug it was written for. Delete it once the
 * engine version in `package.json` carries the fix.
 */
const
    repoRoot    = path.resolve(import.meta.dirname, '..'),
    enginePath  = path.join(repoRoot, 'node_modules', 'neo.mjs'),
    bundledPath = path.join(enginePath, 'dist', 'marked.mjs'),
    sourcePath  = path.join(repoRoot, 'node_modules', 'marked'),
    targetPath  = path.join(enginePath, 'node_modules', 'marked');

/**
 * @summary Places the shim, or explains why it is not needed.
 * @returns {void}
 */
function run() {
    // Nothing to bridge to yet: a fresh clone before `npm install` has no engine at all.
    if (!fs.existsSync(enginePath)) {
        console.log('[marked-shim] neo.mjs is not installed yet — nothing to do.');
        return
    }

    // The sunset condition. `dist/marked.mjs` existing means the engine bundles marked the way it
    // already bundles parse5, so its own imports resolve and this bridge is dead weight.
    if (fs.existsSync(bundledPath)) {
        console.log('[marked-shim] neo.mjs now ships dist/marked.mjs — this shim is obsolete and can be deleted.');
        return
    }

    if (!fs.existsSync(sourcePath)) {
        console.warn('[marked-shim] `marked` is not installed at the workspace root — skipping.');
        return
    }

    // Replaced rather than skipped-if-present: a stale copy from an earlier `marked` version is
    // harder to notice than a missing one, and copying 476 KB once per install is not worth
    // protecting against with a version comparison.
    fs.rmSync(targetPath, {force: true, recursive: true});
    fs.mkdirSync(path.dirname(targetPath), {recursive: true});
    fs.cpSync(sourcePath, targetPath, {recursive: true});

    console.log('[marked-shim] placed marked at node_modules/neo.mjs/node_modules/marked for worker-scope resolution.')
}

run();
