import fs                from 'fs/promises';
import path              from 'path';
import { fileURLToPath } from 'url';
import Base              from '../../../node_modules/neo.mjs/src/core/Base.mjs';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../../');

/**
 * Default configuration object for the DevIndex Backend Services.
 */
const defaultConfig = {
    /**
     * The root directory of the project.
     * @type {string}
     */
    projectRoot,

    /**
     * GitHub API Configuration
     */
    github: {
        /**
         * Minimum stars for repository discovery.
         * @type {number}
         */
        minStars: 1000,
        /**
         * Minimum total contributions to be included in the DevIndex index.
         * @type {number}
         */
        minTotalContributions: 1000,
        /**
         * Number of items per page for API requests.
         * @type {number}
         */
        perPage: 30,
        /**
         * GraphQL points kept untouched for the downstream label-index rebuild.
         *
         * GitHub Actions' repository `GITHUB_TOKEN` currently receives a 1,000-point GraphQL
         * window, while a future GitHub App can receive a larger one. A fixed 100-point reserve
         * protects the small downstream query in either posture without treating the limit as 5,000.
         * @type {number}
         */
        graphqlDownstreamReserve: 100,
        /**
         * Maximum primary GraphQL points reserved while one user is in flight.
         *
         * The bound covers a profile request plus the oldest observed DevIndex history (2007)
         * split into four-year windows, every window falling back once to single years, and rename
         * recovery margin. Unused points are released after the user settles; response-reported
         * `cost` and `remaining` still determine later admission.
         * @type {number}
         */
        graphqlUserReservation: 32,
        /**
         * Request timeout in milliseconds.
         * @type {number}
         */
        timeout: 10000,
        /**
         * Maximum number of users to keep in the index.
         *
         * **Rationale:** A 50,000 user cap results in a ~20MB `users.jsonl` file. While the file is gzipped
         * and streamed over the network, allowing the index to grow unbounded (e.g., 100k users / ~40MB)
         * would introduce significant client-side memory constraints and parsing overhead, eventually degrading
         * the application's responsiveness. The cap ensures the app remains fast and "fun to use" while forcing
         * a "Meritocracy" where only the most active developers remain in the index.
         *
         * @type {number}
         */
        maxUsers: 50000
    },

    /**
     * Spider (Discovery) Configuration
     */
    spider: {
        /**
         * How many users to process in one run.
         * @type {number}
         */
        batchSize: 50,
        /**
         * Maximum depth for crawling (if applicable).
         * @type {number}
         */
        maxDepth: 2,
        /**
         * Backpressure Valve: If the tracker backlog of pending users (`lastUpdate: null`)
         * exceeds this amount, the Spider will abort its run to let the Updater catch up.
         * @type {number}
         */
        maxPendingUsers: 2000
    },

    /**
     * Updater (Enrichment) Configuration
     */
    updater: {
        /**
         * Maximum number of users processed concurrently after GraphQL budget admission.
         * @type {number}
         */
        concurrency: 8,
        /**
         * Number of users to process before saving a checkpoint.
         * @type {number}
         */
        saveInterval: 10
    },

    /**
     * Data Paths
     */
    paths: {
        /**
         * The main rich data store for the frontend (formerly data.json).
         * Contains full profiles, contributions, etc.
         * @type {string}
         */
        users: path.resolve(projectRoot, 'apps/devindex/resources/data/users.jsonl'),

        /**
         * The backend discovery index (formerly users.json).
         * Contains login, id, lastUpdate timestamp.
         * Used for prioritizing updates.
         * @type {string}
         */
        tracker: path.resolve(projectRoot, 'apps/devindex/resources/data/tracker.json'),

        /**
         * Tracks visited resources (repos, users) to prevent cycles.
         * @type {string}
         */
        visited: path.resolve(projectRoot, 'apps/devindex/resources/data/visited.json'),

        /**
         * List of excluded usernames (bots, banned users).
         * @type {string}
         */
        blocklist: path.resolve(projectRoot, 'apps/devindex/resources/data/blocklist.json'),

        /**
         * List of users to always track, ignoring thresholds.
         * @type {string}
         */
        allowlist: path.resolve(projectRoot, 'apps/devindex/resources/data/allowlist.json'),

        /**
         * List of users who failed update processing (Penalty Box).
         * @type {string}
         */
        failed: path.resolve(projectRoot, 'apps/devindex/resources/data/failed.json'),

        /**
         * Stores the minimum total contributions required to enter the index.
         * @type {string}
         */
        threshold: path.resolve(projectRoot, 'apps/devindex/resources/data/threshold.json'),

        /**
         * State tracking for the Opt-Out service (last processed timestamp).
         * @type {string}
         */
        optoutSync: path.resolve(projectRoot, 'apps/devindex/resources/data/optout-sync.json'),

        /**
         * State tracking for the Opt-In service (last processed timestamp).
         * @type {string}
         */
        optinSync: path.resolve(projectRoot, 'apps/devindex/resources/data/optin-sync.json'),

        /**
         * Manifest for the published WORKING SET: one SHA-256 per derived file, written together.
         *
         * **Set-scoped rather than per-file, because a partial match is the dangerous outcome.**
         * The three derived files are one working set: every run reads all three, mutates all three
         * and writes all three. Verifying them independently would let a run proceed with an index
         * from one generation and a tracker from another — and `tracker.json` decides who gets
         * enriched, so a torn read makes the scheduler skip users that are stale and re-enrich users
         * that are not, while every log line stays green.
         *
         * **A MANIFEST, not provenance, and the distinction is load-bearing.** It was tracked in git,
         * which made it a trusted anchor the artifacts could not influence. That required committing
         * it on every run — and an hourly commit needs a write checkout, a push credential and an
         * answer to "did the branch move", which is precisely the machinery this migration exists to
         * delete. 355 bytes is not worth reintroducing a publication state machine for.
         *
         * So it ships WITH the set and is derived rather than trusted. What it still catches: a torn
         * or partial publication, a file that failed to propagate, and any mixing of generations —
         * the operational failures that actually occur. What it can no longer catch: a wholesale,
         * internally consistent overwrite of all four objects. That is the accepted cost, stated
         * rather than implied, and it is the right trade because a consistently stale set is safe to
         * work from while a mixed one is not.
         * @type {string}
         */
        workingSetManifest: path.resolve(projectRoot, 'apps/devindex/resources/data/working-set-manifest.json')
    },

    /**
     * The published working set, read rather than re-derived.
     *
     * **These three files are one object with one lifecycle, not a deliverable plus some state.**
     * Every run reads all three, mutates all three and writes all three. `users.jsonl` is the only one
     * a browser ever sees, which made it tempting to treat the other two as lesser — but by history
     * cost they are the same problem: in `neomjs/neo` the three carry 40.06 GB, 3.76 GB and 1.38 GB of
     * blob bytes respectively, and `tracker.json` has MORE commits than the index does. Sizing them by
     * their on-disk bytes rather than their commit rate is what made them look cheap.
     *
     * So they travel together: fetched together, verified together, published together. There is no
     * bootstrap phase — the first run in this repository is simply the next iteration of a loop that
     * has been turning hourly elsewhere.
     */
    publishedWorkingSet: {
        /**
         * Base URL the working set is fetched from. Declared once; the three filenames are derived
         * from `paths` rather than restated, so a rename cannot desynchronise the fetch from the write.
         *
         * **Still points at what neo publishes**, because that is where all three are served from
         * today — verified: `users.jsonl`, `tracker.json` and `visited.json` each return 200 from this
         * base, since `neomjs/pages` carries the whole `node_modules/neo.mjs/` tree and the Cloud Run
         * middleware proxies it. So the READ side is already live; only publishing is not.
         *
         * That is why `working-set-provenance.json` ships with `digests: null`. While neo is still the
         * publisher, this repository cannot hold a digest for bytes it did not write — neo's next
         * hourly run would invalidate it and every hydration would reject. A null record takes the
         * documented absence branch instead, adopting the published set unverified, which is exactly
         * the hand-off this migration needs. The first run that PUBLISHES writes real digests and
         * verification becomes live from then on.
         *
         * When the destination is chosen this one literal changes and nothing else does.
         * @type {string}
         */
        baseUrl: 'https://neomjs.com/node_modules/neo.mjs/apps/devindex/resources/data/',

        /**
         * Request timeout in ms, per file. Generous: the index alone is ~23 MiB and a slow fetch that
         * succeeds is worth more than a fast fall back to the checkout, which is the path this exists
         * to retire.
         * @type {number}
         */
        timeout: 120000
    }
};

/**
 * @summary Configuration Manager for the DevIndex Backend Pipeline.
 *
 * This class provides a centralized, read-only configuration interface for all backend services.
 * It defines critical constants for the GitHub API (rate limits, timeouts), the discovery algorithms
 * (spider depth, batch size), and the file system paths for data persistence.
 *
 * **Architecture Note:**
 * This class uses a `Proxy` pattern to expose the `data` object properties directly on the default export,
 * providing a cleaner API for consumers (e.g., `config.github.minStars` instead of `config.data.github.minStars`).
 *
 * @class DevIndex.services.Config
 * @extends Neo.core.Base
 * @singleton
 */
class Config extends Base {
    static config = {
        /**
         * @member {String} className='DevIndex.services.Config'
         * @protected
         */
        className: 'DevIndex.services.Config',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * The current configuration object.
     * @member {Object} data
     */
    data = null;

    /**
     * Initializes the configuration object.
     * @param {Object} config
     */
    construct(config) {
        super.construct(config);
        this.data = Neo.clone(defaultConfig, true);
    }
}

const instance = Neo.setupClass(Config);

export default new Proxy(instance, {
    get(target, prop, receiver) {
        // 1. Prefer properties/methods on the instance itself
        if (Reflect.has(target, prop)) {
            return Reflect.get(target, prop, receiver);
        }
        // 2. Fallback to the data object
        return target.data[prop];
    }
});
