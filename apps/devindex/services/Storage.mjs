import {createHash} from 'crypto';
import fs           from 'fs/promises';
import Base         from '../../../node_modules/neo.mjs/src/core/Base.mjs';
import config       from './config.mjs';

/**
 * @summary DevIndex Persistence Layer (JSON File System).
 *
 * This service manages all file I/O operations, acting as a simple, flat-file database abstraction.
 * It ensures atomic-ish writes (by overwriting files completely) and handles the normalization of data.
 *
 * **Managed Resources:**
 * - **`users.jsonl` (Rich Data Store):** Contains the full, enriched profile data for all users who met the threshold.
 *   This is the source of truth for the Frontend UI.
 *   **The `maxUsers` Cap:** To ensure the application remains highly responsive, the size of this file is
 *   strictly capped (e.g., 50,000 users). While the data is gzipped and streamed to the client, an unbounded
 *   file (e.g., 100k users / 40MB) would eventually cause client-side parsing and memory bottlenecks.
 *   When the cap is reached, `Storage` automatically prunes the bottom performers and raises the entry
 *   bar via `threshold.json`.
 * - **`tracker.json` (The Index):** A lightweight map (`login` -> `lastUpdate`) used by the Backend to schedule updates.
 *   It includes "Pending" users (`lastUpdate: null`) discovered by the Spider but not yet processed.
 * - **`visited.json` (Cache):** A Set of keys (e.g., `repo:owner/name`) to prevent the Spider from re-scanning the same sources.
 * - **`blocklist.json` / `allowlist.json`:** Configuration files for manual overrides.
 *
 * **Key Features:**
 * - **Case Insensitivity:** Automatically normalizes login keys to lowercase to prevent duplicates.
 * - **Deletion Support:** The `updateTracker` method supports a `delete: true` flag for active pruning.
 *
 * @class DevIndex.services.Storage
 * @extends Neo.core.Base
 * @singleton
 */
class Storage extends Base {
    static config = {
        /**
         * @member {String} className='DevIndex.services.Storage'
         * @protected
         */
        className: 'DevIndex.services.Storage',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * Initializes the storage service.
     * Ensures all required data files exist.
     * @returns {Promise<void>}
     */
    async initAsync() {
        await this.ensureFiles();
    }

    /**
     * Checks if data files exist and creates them with defaults if missing.
     * @returns {Promise<void>}
     */
    async ensureFiles() {
        const files = [
            { path: config.paths.users,     default: [] },
            { path: config.paths.tracker,   default: {} },
            { path: config.paths.visited,   default: [] },
            { path: config.paths.blocklist, default: [] },
            { path: config.paths.allowlist, default: [] },
            { path: config.paths.failed,    default: {} },
            { path: config.paths.threshold, default: { tc: config.github.minTotalContributions } },
            { path: config.paths.optoutSync, default: { lastCheck: null } },
            { path: config.paths.optinSync, default: { lastCheck: null } }
        ];

        for (const file of files) {
            try {
                await fs.access(file.path);
            } catch {
                await this.writeJson(file.path, file.default);
                console.log(`[Storage] Created missing file: ${file.path}`);
            }
        }
    }

    /**
     * Reads the blocklist.
     * @returns {Promise<Set<String>>} Set of blocklisted logins.
     */
    async getBlocklist() {
        const list = await this.readJson(config.paths.blocklist, []);
        return new Set(list.map(item => item.toLowerCase()));
    }

    /**
     * Adds users to the blocklist.
     * @param {Array<String>} logins
     * @returns {Promise<void>}
     */
    async addToBlocklist(logins) {
        const current = await this.readJson(config.paths.blocklist, []);
        const currentSet = new Set(current.map(item => item.toLowerCase()));
        let changed = false;

        for (const login of logins) {
            if (!currentSet.has(login.toLowerCase())) {
                current.push(login);
                currentSet.add(login.toLowerCase());
                changed = true;
            }
        }

        if (changed) {
            current.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            await this.writeJson(config.paths.blocklist, current);
        }
    }

    /**
     * Removes users from the blocklist.
     * @param {Array<String>} logins
     * @returns {Promise<void>}
     */
    async removeFromBlocklist(logins) {
        const current = await this.readJson(config.paths.blocklist, []);
        const targetSet = new Set(logins.map(l => l.toLowerCase()));
        
        const initialLen = current.length;
        const filtered = current.filter(item => !targetSet.has(item.toLowerCase()));

        if (filtered.length !== initialLen) {
            await this.writeJson(config.paths.blocklist, filtered);
        }
    }

    /**
     * Reads the opt-out sync state.
     * @returns {Promise<Object>}
     */
    async getOptOutSync() {
        return this.readJson(config.paths.optoutSync, { lastCheck: null });
    }

    /**
     * Saves the opt-out sync state.
     * @param {Object} data
     * @returns {Promise<void>}
     */
    async saveOptOutSync(data) {
        await this.writeJson(config.paths.optoutSync, data);
    }

    /**
     * Reads the opt-in sync state.
     * @returns {Promise<Object>}
     */
    async getOptInSync() {
        return this.readJson(config.paths.optinSync, { lastCheck: null });
    }

    /**
     * Saves the opt-in sync state.
     * @param {Object} data
     * @returns {Promise<void>}
     */
    async saveOptInSync(data) {
        await this.writeJson(config.paths.optinSync, data);
    }

    /**
     * Reads the allowlist.
     * @returns {Promise<Set<String>>} Set of allowlisted logins.
     */
    async getAllowlist() {
        const list = await this.readJson(config.paths.allowlist, []);
        return new Set(list.map(item => item.toLowerCase()));
    }

    /**
     * Reads the minimum required total contributions from the threshold file.
     * @returns {Promise<Number>}
     */
    async getLowestContributionThreshold() {
        const data = await this.readJson(config.paths.threshold, { tc: config.github.minTotalContributions });
        return data.tc;
    }

    /**
     * Reads the failed list (Penalty Box).
     * Handles legacy Array format by migrating to Map with current timestamp.
     * @returns {Promise<Map<String, String>>} Map of login -> timestamp.
     */
    async getFailed() {
        const raw = await this.readJson(config.paths.failed, {});
        const map = new Map();

        if (Array.isArray(raw)) {
            // Migration: Convert legacy array to Object with current timestamp
            const now = new Date().toISOString();
            raw.forEach(login => map.set(login.toLowerCase(), now));
        } else {
            Object.entries(raw).forEach(([login, ts]) => map.set(login.toLowerCase(), ts));
        }

        return map;
    }

    /**
     * Updates the failed list (Penalty Box).
     * @param {Array<String>} logins List of logins to add or remove.
     * @param {Boolean} [add=true] True to add, False to remove.
     * @returns {Promise<void>}
     */
    async updateFailed(logins, add=true) {
        const current = await this.getFailed();
        let changed = false;

        logins.forEach(login => {
            const key = login.toLowerCase();
            if (add) {
                if (!current.has(key)) {
                    current.set(key, new Date().toISOString());
                    changed = true;
                }
            } else {
                if (current.has(key)) {
                    current.delete(key);
                    changed = true;
                }
            }
        });

        if (changed) {
            await this.saveFailed(current);
        }
    }

    /**
     * Persists the failed map to disk.
     * @param {Map<String, String>} map
     * @returns {Promise<void>}
     */
    async saveFailed(map) {
        const sorted = {};
        Array.from(map.keys()).sort().forEach(key => {
            sorted[key] = map.get(key);
        });
        await this.writeJson(config.paths.failed, sorted);
    }

    /**
     * Reads the visited log.
     * @returns {Promise<Set<String>>} Set of visited keys (e.g. "repo:owner/name", "user:login").
     */
    async getVisited() {
        await this.hydrateWorkingSet();

        const list = await this.readJson(config.paths.visited, []);
        return new Set(list);
    }

    /**
     * Saves new items to the visited log.
     * @param {Set<String>|Array<String>} newItems
     * @returns {Promise<void>}
     */
    async updateVisited(newItems) {
        await this.hydrateWorkingSet();

        const current    = await this.readJson(config.paths.visited, []);
        const currentSet = new Set(current);
        let changed      = false;

        const items = Array.isArray(newItems) ? newItems : Array.from(newItems);

        for (const item of items) {
            if (!currentSet.has(item)) {
                currentSet.add(item);
                changed = true;
            }
        }

        if (changed) {
            await this.writeJson(config.paths.visited, Array.from(currentSet));
        }
    }

    /**
     * Reads the tracker index (formerly users.json).
     * @returns {Promise<Array<{login: String, lastUpdate: String}>>}
     */
    async getTracker() {
        await this.hydrateWorkingSet();

        const raw = await this.readJson(config.paths.tracker, {});

        // Return as Array for Consumers
        return Object.entries(raw).map(([login, lastUpdate]) => ({ login, lastUpdate }));
    }

    /**
     * Updates the Tracker Index with new states or timestamps.
     *
     * Handles three types of operations based on the input:
     * 1.  **Insert (Discovery):** Adds a new user with `lastUpdate: null`.
     * 2.  **Update (Success):** Updates an existing user with a new `lastUpdate` timestamp.
     * 3.  **Delete (Pruning):** Removes a user if `delete: true` is present in the update object.
     *
     * Performs a case-insensitive lookup to prevent duplicate entries for the same user.
     *
     * @param {Object[]} updates List of update operations.
     * @param {String} updates[].login The user's login.
     * @param {String} [updates[].lastUpdate] The last update timestamp.
     * @param {Boolean} [updates[].delete] True to delete the user.
     * @returns {Promise<void>}
     */
    async updateTracker(updates) {
        await this.hydrateWorkingSet();

        const current = await this.readJson(config.paths.tracker, {});
        // Normalize keys to lowercase to prevent duplicates
        const map = {};
        Object.entries(current).forEach(([k, v]) => map[k.toLowerCase()] = { originalKey: k, val: v });

        let changed = false;

        for (const update of updates) {
            const key      = update.login.toLowerCase();
            const existing = map[key];

            // Update if new or if timestamp is newer
            // Note: We might be updating the key casing if the new login has different casing,
            // but for the map we stick to the original unless it's new.
            // Actually, we want to canonicalize to the most recent login casing?
            // Let's just use the update.login as the key if we write it back.

            const existingTime = existing ? existing.val : undefined;

            if (update.delete) {
                if (existing) {
                    delete map[key];
                    changed = true;
                }
            } else if (existingTime == null || (update.lastUpdate && update.lastUpdate > existingTime)) {
                // If it exists, update the entry. If not, create new.
                if (existing) {
                    existing.val = update.lastUpdate || existingTime || null;
                    // Optionally update originalKey if we want to prefer the new casing
                    existing.originalKey = update.login;
                } else {
                    map[key] = { originalKey: update.login, val: update.lastUpdate || null };
                }
                changed = true;
            }
        }

        if (changed) {
            // Reconstruct object with original keys
            const out = {};
            Object.values(map).forEach(item => {
                out[item.originalKey] = item.val;
            });
            await this.writeJson(config.paths.tracker, out);
        }
    }

    /**
     * @summary Fetches the published working set onto disk, once per run, before anything reads it.
     *
     * **The nine members are one object** (`workingSetMembers`). A run reads, mutates and writes them
     * as one state — `Cleanup` alone rewrites several of them before every command.
     * Fetching them independently would let a run proceed with an index from one generation and a
     * tracker from another, and `tracker.json` is what decides who gets enriched: a torn read makes the
     * scheduler skip users that are stale and re-enrich users that are not, silently. So the set is
     * adopted all-or-nothing, and verified wherever its source carries digests.
     *
     * **Materialised to disk rather than held in memory**, deliberately. Every existing reader and
     * writer already goes through `readJson`/`writeJson` on these paths; landing the fetched bytes
     * there means none of them need to know this happened, and there is no way for one caller to see
     * the fetched copy while another sees the checkout copy. The alternative — memoising parsed
     * objects — would leave `updateVisited`, which reads its path directly, on the old data.
     *
     * **Once per run, not per process.** The collection workflow runs each stage as its own process, and a
     * second adoption overwrites what the stages before it wrote: an opt-out recorded by OptOut would be gone
     * before Spider starts. So inside a workflow run the first hydration marks the run, and later processes of
     * the same run keep the local set. Outside one — a developer's checkout, a test — every process hydrates.
     *
     * Runs before the first access rather than on demand, for the same reason: hydration WRITES, so it
     * has to happen while the local files are still untouched by this run.
     * @returns {Promise<void>}
     */
    async hydrateWorkingSet() {
        this.hydration ??= this.hydrateOncePerRun();
        return this.hydration
    }

    /**
     * @summary Adopts the working set unless an earlier process of this workflow run already did.
     *
     * The run is marked whatever the adoption's outcome: a run decides its starting state once, and a later
     * stage must not work from a different one than the stages before it. The mark records the index size the
     * run starts from, which is the baseline the publisher's collapse check compares against.
     * @returns {Promise<void>}
     * @private
     */
    async hydrateOncePerRun() {
        const {GITHUB_RUN_ATTEMPT, GITHUB_RUN_ID} = process.env,
              run = GITHUB_RUN_ID ? `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` : null;

        if (run && (await this.readHydratedRun())?.run === run) {
            console.log(`[Storage] The working set was hydrated earlier in run ${run}; keeping this run's local writes.`);
            return
        }

        await this.fetchAndAdoptWorkingSet();

        run && await this.writeAtomic(config.paths.hydratedRun, JSON.stringify({run, users: await this.countIndex()}))
    }

    /**
     * @summary The mark the last hydration in this checkout left, `{run, users}`, or null.
     * @returns {Promise<Object|null>}
     * @private
     */
    async readHydratedRun() {
        try {
            return JSON.parse(await fs.readFile(config.paths.hydratedRun, 'utf-8'))
        } catch (error) {
            return null
        }
    }

    /**
     * @summary The index size this workflow run started from, or null outside a run or before its hydration.
     * @returns {Promise<Number|null>}
     */
    async runStartCount() {
        const {GITHUB_RUN_ATTEMPT, GITHUB_RUN_ID} = process.env,
              mark = await this.readHydratedRun();

        return GITHUB_RUN_ID && mark?.run === `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` ? mark.users : null
    }

    /**
     * @summary The number of records in the local index.
     * @returns {Promise<Number>}
     */
    async countIndex() {
        return (await fs.readFile(config.paths.users, 'utf-8').catch(() => '')).split('\n').filter(Boolean).length
    }

    /**
     * @summary Where the working set is read from. A run holding the store's credentials — the bucket
     * `DEVINDEX_PUBLISH_BUCKET` names and a short-lived `DEVINDEX_STORE_TOKEN` — reads the store it publishes
     * to, over the GCS endpoint. Any other process, a developer's checkout or a test, reads the public copy.
     * @returns {{baseUrl: String, headers: Object, store: Boolean}}
     * @private
     */
    workingSetSource() {
        const {DEVINDEX_PUBLISH_BUCKET: bucket, DEVINDEX_STORE_TOKEN: token} = process.env;

        if (bucket && token) {
            return {
                baseUrl: `https://storage.googleapis.com/${bucket.replace(/^gs:\/\//, '').replace(/\/$/, '')}/`,
                headers: {Authorization: `Bearer ${token}`},
                store  : true
            }
        }

        return {baseUrl: config.publishedWorkingSet.baseUrl, headers: {}, store: false}
    }

    /**
     * @summary Fetches every member and adopts them together — verified against the store's digests, or,
     * from the public copy, unverified by construction, since it carries none.
     *
     * A store that has never published — its manifest is a definite 404 — is seeded once from the public
     * copy, and the first publish replaces the seed. A store that answers anything else without complete
     * digests adopts nothing: seeding or trusting over a store that merely failed to answer would roll the
     * index back or accept an unverifiable set.
     * @returns {Promise<void>}
     * @private
     */
    async fetchAndAdoptWorkingSet() {
        const
            {timeout} = config.publishedWorkingSet,
            members   = this.workingSetMembers(),
            fetched   = {};

        let source             = this.workingSetSource(),
            {manifest, status} = await this.fetchManifest(source, timeout);

        if (source.store && status === 404) {
            console.warn(`[Storage] The store has published nothing yet — seeding once from ${config.publishedWorkingSet.baseUrl}.`);

            source = {baseUrl: config.publishedWorkingSet.baseUrl, headers: {}, store: false};
            ({manifest} = await this.fetchManifest(source, timeout))
        } else if (source.store && status !== 200) {
            return this.rejectWorkingSet(`the store's manifest could not be read (${status || 'no response'})`)
        } else if (source.store && !manifest?.digests) {
            return this.rejectWorkingSet('the store answered without digests, so its set cannot be verified')
        }

        for (const {key, file, path: localPath} of members) {
            const url = `${source.baseUrl}${file}`;

            let response, text;

            try {
                response = await fetch(url, {headers: source.headers, signal: AbortSignal.timeout(timeout)});

                if (!response.ok) {
                    return this.rejectWorkingSet(`HTTP ${response.status} for ${file}`)
                }

                text = await response.text();
            } catch (error) {
                return this.rejectWorkingSet(`fetch failed for ${file}: ${error.message}`)
            }

            const digest = this.digestOf(text);

            // Absence of a record is not mismatch. A deployment that has never published has nothing
            // to compare against, and treating that as tampering would make this path unreachable.
            if (manifest?.digests) {
                if (manifest.digests[key] !== digest) {
                    return this.rejectWorkingSet(
                        `${file} does not match the published manifest ` +
                        `(recorded ${String(manifest.digests[key]).slice(0, 12)}, fetched ${digest.slice(0, 12)})`
                    )
                }
            }

            fetched[key] = {text, localPath};
        }

        if (!manifest?.digests) {
            console.warn(`[Storage] ${source.baseUrl} carries no manifest — adopting the fetched set UNVERIFIED.`)
        }

        // Written only after EVERY member fetched and verified, so a failure part-way through leaves
        // the local set exactly as it was rather than half-replaced.
        for (const {text, localPath} of Object.values(fetched)) {
            await this.writeAtomic(localPath, text);
        }

        console.log(`[Storage] Adopted the published working set (${members.length} files).`)
    }

    /**
     * @summary Fetches a source's manifest, with the status that decides what its absence means: the store's
     * 404 is a store that never published, while the public copy carries no manifest at all.
     * @param {Object} source  See {@link #workingSetSource}
     * @param {Number} timeout
     * @returns {Promise<{manifest: (Object|null), status: Number}>} `status` is 0 when nothing parseable answered
     * @private
     */
    async fetchManifest({baseUrl, headers}, timeout) {
        const file = config.paths.workingSetManifest.slice(config.paths.workingSetManifest.lastIndexOf('/') + 1);

        try {
            const response = await fetch(`${baseUrl}${file}`, {headers, signal: AbortSignal.timeout(timeout)});

            return {manifest: response.ok ? JSON.parse(await response.text()) : null, status: response.status}
        } catch (error) {
            return {manifest: null, status: 0}
        }
    }

    /**
     * @summary The derived files that travel together, paired with their published basenames.
     *
     * Basenames are derived from `config.paths` rather than restated, so a rename cannot desynchronise
     * what is fetched from what is written.
     * @returns {Object[]}
     * @private
     */
    workingSetMembers() {
        // EVERY file the pipeline writes, not merely the large ones.
        //
        // This list was `users`, `tracker`, `visited` — chosen by which files were big enough to bloat
        // git. That is the wrong axis. The right one is *who writes it*, and by that test all nine are
        // pipeline state: `Cleanup` rewrites `allowlist`, `updateUsers` rewrites `threshold`, OptIn and
        // OptOut advance their own sync cursors, and **`OptOut` appends to `blocklist`**.
        //
        // The blocklist is why this matters beyond tidiness. A user opts out, `addToBlocklist` records
        // it, the runner is discarded — and with the file outside the working set the decision never
        // survives the run. The next Spider pass is free to re-index them, while the closing comment
        // has already told them they were "removed from the active DevIndex databases and added to the
        // blocklist". Losing that is a privacy failure, not a stale cache.
        return ['users', 'tracker', 'visited', 'blocklist', 'allowlist', 'threshold', 'failed', 'optinSync', 'optoutSync']
            .map(key => ({
                key,
                path: config.paths[key],
                file: config.paths[key].slice(config.paths[key].lastIndexOf('/') + 1)
            }))
    }

    /**
     * @summary Records why the published set was refused, then leaves the local copies in place.
     *
     * Audible by construction: a silent rejection would leave the git coupling in place while every
     * log line claimed it had been removed.
     * @param {String} reason
     * @returns {void}
     * @private
     */
    rejectWorkingSet(reason) {
        console.warn(`[Storage] Using the local working set — ${reason}.`);
    }

    /**
     * Reads the rich users data.
     * @returns {Promise<Array<Object>>}
     */
    async getUsers() {
        await this.hydrateWorkingSet();

        // **Fail closed. An absent prior index is indistinguishable from a lost one, and the two have
        // opposite correct responses.**
        //
        // `updateUsers` merges new records INTO this and writes the result as the whole index, so
        // returning `[]` does not degrade — it TRUNCATES: a run that enriched 200 users would publish
        // an index of 200 and 49,800 contributors would be gone with every log line green. That was
        // survivable while the checkout carried a committed copy; removing the file from git removed
        // that net.
        // EMPTY counts as absent, and the distinction is not academic: `ensureFiles` creates
        // `users.jsonl` as a zero-byte file at construction, long before anything tries to read it,
        // and `readJson` answers an empty JSONL with `[]` — which is TRUTHY. So on a fresh checkout
        // whose hydration then failed, `if (users)` would hand back the empty file and the guard
        // below would never fire, in precisely the case it was written for. A genuinely first-ever
        // run is the one legitimate empty index, and it has its own door: DEVINDEX_ALLOW_EMPTY_INDEX.
        const users = await this.readJson(config.paths.users, null);

        if (users?.length) return users;

        if (process.env.DEVINDEX_ALLOW_EMPTY_INDEX) {
            console.warn('[Storage] No published and no local index — proceeding EMPTY because DEVINDEX_ALLOW_EMPTY_INDEX is set. This publishes whatever this run produces as the entire index.');
            return []
        }

        throw new Error(
            'DevIndex has no prior index: the published working set could not be adopted and no local copy exists. ' +
            'Refusing to continue, because merging this run\'s output into an empty index would publish a truncated one. ' +
            'Fix the fetch, run `npm run devindex:pull-data`, or set DEVINDEX_ALLOW_EMPTY_INDEX=1 if this really is a first-ever run.'
        )
    }

    /**
     * @summary Content digest used to prove a fetched file is the one this pipeline wrote.
     * @param {String} content
     * @returns {String} Hex-encoded SHA-256.
     * @private
     */
    digestOf(content) {
        return createHash('sha256').update(content, 'utf-8').digest('hex');
    }

    /**
     * @summary Records the whole working set in one write, so the next run can recognise it.
     *
     * One record covering every member's digest rather than one record each: the set is adopted all-or-nothing,
     * so provenance that could be partially current would describe a state the reader must never act
     * on. Digests are taken over the bytes on disk — which is what a later fetch returns — because
     * deriving them from in-memory objects would compare a re-serialisation against a transmission and
     * drift on any formatting change, failing in a way that looks like tampering.
     * @returns {Promise<void>}
     */
    async recordWorkingSetManifest() {
        const digests = {};

        for (const {key, path: localPath} of this.workingSetMembers()) {
            const content = await fs.readFile(localPath, 'utf-8').catch(() => null);

            if (content === null) return;   // an incomplete set is not worth a record

            digests[key] = this.digestOf(content);
        }

        await this.writeJson(config.paths.workingSetManifest, {
            digests,
            publishedAt: new Date().toISOString()
        });
    }

    /**
     * Persists enriched user profiles to the Rich Data Store (`users.json`).
     *
     * Performs a **Merge & Sort** operation:
     * 1.  Loads existing data.
     * 2.  Overwrites or adds new records based on the `login` key.
     * 3.  **Sorts** the entire dataset by `total_contributions` (descending) to ensure the file is always ready for UI consumption.
     * 4.  Writes the result back to disk atomically.
     *
     * @param {Array<Object>} newRecords Array of user objects to upsert.
     * @returns {Promise<void>}
     */
    async updateUsers(newRecords) {
        await this.hydrateWorkingSet();

        const current = await this.getUsers();
        const map     = new Map(current.map(r => [r.l, r])); // 'l' is login
        let changed   = false;

        for (const record of newRecords) {
            // For rich data, we generally assume 'record' is the latest full snapshot
            map.set(record.l, record);
            changed = true;
        }

        if (changed) {
            // Convert back to array
            let result = Array.from(map.values());

            // Sort by total contributions (descending). 'tc' is total_contributions
            result.sort((a, b) => (b.tc || 0) - (a.tc || 0));

            const maxUsers   = config.github.maxUsers;
            const allowlist  = await this.getAllowlist();

            // We calculate `effectiveMax` as `maxUsers + allowlist.size` to protect the Meritocracy.
            // If we simply sliced at `maxUsers`, manually allowlisted users (e.g., conference speakers)
            // would unfairly consume slots that belong to organic, high-performing developers.
            // By adding the allowlist size to the cap, we guarantee 50,000 organic slots remain open.
            const effectiveMax = maxUsers ? maxUsers + allowlist.size : null;
            let prunedLogins = [];

            if (effectiveMax && result.length > effectiveMax) {
                const pruned = result.slice(effectiveMax);
                prunedLogins = pruned.map(u => u.l);
                result       = result.slice(0, effectiveMax);

                // Update threshold
                const lowestTc = result[result.length - 1].tc || config.github.minTotalContributions;
                await this.writeJson(config.paths.threshold, { tc: lowestTc });
            }

            await this.writeJson(config.paths.users, result);

            // Clean up tracker and penalty box if we pruned
            if (prunedLogins.length > 0) {
                const trackerUpdates = prunedLogins.map(login => ({ login, delete: true }));
                await this.updateTracker(trackerUpdates);
                await this.updateFailed(prunedLogins, false);
            }
        }
    }

    /**
     * Removes users from the Rich Data Store (`users.jsonl`).
     * @param {Array<String>} logins The list of logins to remove.
     * @returns {Promise<Boolean>} True if any were removed.
     */
    async deleteUsers(logins) {
        await this.hydrateWorkingSet();

        const current    = await this.getUsers();
        const targets    = new Set(logins.map(l => l.toLowerCase()));
        const initialLen = current.length;
        const filtered   = current.filter(u => !targets.has(u.l.toLowerCase()));

        if (filtered.length !== initialLen) {
            await this.writeJson(config.paths.users, filtered);
            return true;
        }
        return false;
    }

    // --- Low Level Helpers ---

    /**
     * Reads a JSON or JSONL file.
     * @param {String} path
     * @param {*} defaultValue
     * @returns {Promise<*>}
     * @private
     */
    async readJson(path, defaultValue) {
        try {
            const content = await fs.readFile(path, 'utf-8');

            if (path.endsWith('.jsonl')) {
                if (!content.trim()) return [];
                return content
                    .split('\n')
                    .filter(line => line.trim())
                    .map(line => JSON.parse(line));
            }

            return JSON.parse(content);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return defaultValue;
            }
            throw error;
        }
    }

    /**
     * @summary Writes a file through a temp-and-rename, creating the data directory when it is absent.
     *
     * The `mkdir` is load-bearing: git cannot express an empty directory, so a clean checkout has no
     * data directory at all and `ensureFiles()` runs before anything has fetched one. It sits at the
     * write rather than in `initAsync`, so no other path to a writer can bypass it.
     *
     * Temp-and-rename keeps the write atomic for a concurrent reader: `users.jsonl` is ~23 MiB, and a
     * torn write parses as far as its last complete line, presenting as missing contributors.
     * @param {String} filePath
     * @param {String} content
     * @returns {Promise<void>}
     * @private
     */
    async writeAtomic(filePath, content) {
        const tempPath = `${filePath}.tmp`;

        await fs.mkdir(filePath.slice(0, filePath.lastIndexOf('/')), {recursive: true});
        await fs.writeFile(tempPath, content, 'utf-8');
        await fs.rename(tempPath, filePath)
    }

    /**
     * Writes data to a JSON or JSONL file.
     * @param {String} path
     * @param {*} data
     * @returns {Promise<void>}
     * @private
     */
    async writeJson(path, data) {
        let content;

        if (path.endsWith('.jsonl')) {
            if (Array.isArray(data)) {
                content = data.map(item => JSON.stringify(item)).join('\n');
            } else {
                throw new Error('JSONL writer expects an Array');
            }
        } else if (path === config.paths.users && Array.isArray(data)) {
            // Legacy/Fallback formatter for users.json
            const lines = data.map(item => JSON.stringify(item));
            content = `[\n${lines.join(',\n')}\n]`;
        } else {
            content = JSON.stringify(data, null, 2);
        }

        await this.writeAtomic(path, content);

        // Recorded here rather than at each call site: the index is written from three places
        // (`saveUsers`, the prune path, and Cleanup's reconciliation), and provenance that only some
        // of them update is worse than none — a stale digest reads as a foreign artifact and would
        // send every subsequent run down the fallback path for a reason nobody could find.
        // Any member changing re-stamps the WHOLE set, because the record is set-scoped: a per-file
        // stamp could be partially current, which describes a state no reader may act on.
        // `workingSetProvenance` itself is excluded, or recording would recurse.
        if (path !== config.paths.workingSetManifest &&
            this.workingSetMembers().some(member => member.path === path)) {
            await this.recordWorkingSetManifest();
        }
    }
}

export default Neo.setupClass(Storage);
