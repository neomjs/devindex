/**
 * @summary Re-exports the engine's unit-test runtime setup so specs import it by a stable local path.
 *
 * The real implementation ships inside the `neo.mjs` package: it installs the Node.js globals a
 * browserless Neo runtime needs (`globalThis.Neo`, `DOMRect`) at import time, then `setup()` applies
 * per-spec config. Both the side effects and the export ride through this module unchanged.
 *
 * **Why a shim rather than importing the package path directly from each spec.** DevIndex still lives
 * in `neomjs/neo` as well while the extraction finishes, and the specs there import
 * `'../../../setup.mjs'`. Keeping that specifier identical here means the two copies differ only
 * where they genuinely must — the engine imports — instead of also differing in a line that carries
 * no information. When the app leaves `neo`, this file is the single place that knows the engine is
 * a dependency rather than a sibling.
 */
export {setup} from '../../node_modules/neo.mjs/test/playwright/setup.mjs';
