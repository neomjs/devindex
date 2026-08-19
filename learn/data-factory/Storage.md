# Storage & Configuration

The DevIndex Data Factory relies on two foundational services to manage its state and execution parameters: **`Storage`** ([`DevIndex.services.Storage`](https://github.com/neomjs/devindex/blob/main/apps/devindex/services/Storage.mjs)) and **`Config`** ([`DevIndex.services.Config`](https://github.com/neomjs/devindex/blob/main/apps/devindex/services/config.mjs)). 

Together, they provide a robust, JSON-backed persistence layer and a centralized configuration interface that dictates how the Spider and Updater services behave.

---

## The Configuration Manager (`config.mjs`)

The `Config` service provides a read-only, centralized source of truth for all backend services. It abstracts away environment-specific paths and critical magic numbers.

### Architectural Note: The Proxy Pattern
To provide a cleaner developer experience, the `config.mjs` module exports a `Proxy` instance. This allows consumers to access nested configuration data directly on the export, rather than digging through a `.data` property.

```javascript
// Instead of:
// import config from './config.mjs';
// const limit = config.data.github.maxUsers;

// You can use:
import config from './config.mjs';
const limit = config.github.maxUsers;
```

### Key Configurations

1.  **API Constraints (`config.github`)**: 
    Defines `minStars` and `minTotalContributions` to filter noise. It also sets the `perPage` limit for GraphQL pagination to optimize payload sizes and API quota usage.
2.  **Algorithm Tuning (`config.spider`)**: 
    Controls the aggressiveness of the discovery engine. `maxPendingUsers` (e.g., 2000) acts as a critical **Backpressure Valve**. If the Spider runs too far ahead of the Updater, it halts to let the pipeline catch up, preventing the `tracker.json` backlog from ballooning.
3.  **Path Resolution (`config.paths`)**: 
    Abstracts all absolute file paths using `path.resolve`, ensuring the services can be executed from any working directory (e.g., via cron jobs or GitHub Actions) without pathing errors.

---

## The Persistence Layer (`Storage.mjs`)

The `Storage` service acts as a flat-file, NoSQL-style database abstraction. It manages all file I/O operations asynchronously using `fs/promises`.

### Atomic-ish Writes
To prevent data corruption during concurrent or interrupted writes, the `Storage` service employs an "atomic-ish" write strategy. Data is first serialized to a temporary file (`.tmp`), and only when the write is complete is it renamed over the existing file.

```javascript
// Simplified from writeJson()
const tempPath = `${path}.tmp`;
await fs.writeFile(tempPath, content, 'utf-8');
await fs.rename(tempPath, path); // Atomic rename
```

### Managed Resources

The Storage service maintains several distinct data stores:

1.  **`users.jsonl` (The Rich Data Store)**
    *   **Format:** JSON Lines (JSONL).
    *   **Purpose:** Contains the fully enriched profile data for all qualifying users. This is the ultimate source of truth consumed by the Frontend UI.
    *   **The 50k Meritocracy Cap:** To ensure the frontend remains highly responsive, this file is strictly capped (defined by `config.github.maxUsers`, currently 50,000). The `Storage` service automatically enforces this cap.

2.  **`tracker.json` (The Index)**
    *   **Format:** JSON Object mapped to an Array internally.
    *   **Purpose:** A lightweight map (`login` -> `lastUpdate`) used by the Backend to schedule updates. Users discovered by the Spider are added here with `lastUpdate: null` (Pending), signaling high priority to the Updater.

3.  **`visited.json` (The Cache)**
    *   **Format:** JSON Array (treated as a Set).
    *   **Purpose:** Stores keys (e.g., `repo:facebook/react`) to prevent the Spider from redundantly re-scanning the same sources across different runs.

### The Working Set: derived, delivered, never versioned

The first three files above — `users.jsonl`, `tracker.json` and `visited.json` — form the **working
set**. Every run reads all three, mutates all three and writes all three; `Cleanup` alone rewrites the
lot before every command. They are treated as one object with one lifecycle, and that has two
consequences worth knowing before you touch this layer.

**They are not in git, and must never be.** All three are regenerated in full every hour, so
committing them makes each hour permanent. The same three files in `neomjs/neo` carry **40.06 GB**,
**3.76 GB** and **1.38 GB** of blob bytes respectively — and `tracker.json` has *more* commits behind
it than the index does, despite being a tenth of the size. Judging these by their on-disk bytes rather
than their commit rate is the mistake that lets the small ones through.

So `.gitignore` excludes them and `npm run check-data-tracking` fails if any becomes tracked. The same
guard asserts the *curated* files ARE tracked, because ignoring the directory wholesale would satisfy
the first rule while silently discarding `blocklist.json` — somebody's opt-out decision, and the one
file here nothing can regenerate.

**They are fetched as a set, and verified as a set.** `Storage.hydrateWorkingSet()` downloads all
three from `config.publishedWorkingSet.baseUrl` once per process, before anything reads them, and
adopts them **all-or-nothing**. A partial adoption is the dangerous outcome: `tracker.json` decides who
gets enriched, so an index from one generation paired with a tracker from another makes the Updater
skip users that are stale and re-enrich users that are not — silently, with every log line green.
`working-set-manifest.json` holds one digest per file, written together and checked together, so a
mismatch on any one rejects the whole set rather than mixing.

It is a **manifest**, not provenance, and the distinction is deliberate. It began as a git-tracked
anchor the artifacts could not influence — which is stronger, and which required committing it on
every run. An hourly commit needs a write checkout, a push credential and an answer to "did the branch
move": the entire publication state machine this migration exists to delete, for 355 bytes. So it
ships *with* the set instead. It still catches a torn or partial publication, a file that failed to
propagate, and any mixing of generations — the failures that actually happen. It cannot catch a
wholesale, internally consistent overwrite. That is the accepted cost, and it is the right trade,
because a consistently stale set is safe to work from while a mixed one is not.

Rejection is never silent, and never empty. A refused set falls back to the local copies and says why.
If there is no local index either, `getUsers()` **throws** rather than returning `[]` — because
`updateUsers()` merges into whatever it returns and writes the result as the entire index, so an empty
prior state would publish a truncated one. `DEVINDEX_ALLOW_EMPTY_INDEX=1` is the declared escape for a
genuine first-ever run, which is the only case that legitimately has nothing and which no measurement
can distinguish from an outage.

**Working locally:** `npm install` fetches the index for you, and `npm run devindex:pull-data`
refreshes it. Your copy going stale does not matter — development needs *representative* data, not
current data. The pipeline is the consumer that needs currency, and it re-fetches every run.

4.  **`blocklist.json` & `allowlist.json` (Overrides)**
    *   **Format:** JSON Arrays.
    *   **Purpose:** Configuration files for manual or automated overrides (Opt-Outs and VIPs). The Storage service automatically enforces case-insensitivity when interacting with these lists.

5.  **`failed.json` (The Penalty Box)**
    *   **Format:** JSON Object (`login` -> `timestamp`).
    *   **Purpose:** Tracks users who failed the enrichment process (e.g., due to suspended accounts or API errors). The Cleanup service uses the timestamps here to determine when to retry.

### The `maxUsers` Pruning Logic

The most complex operation in the Storage service is `updateUsers()`, which enforces the `maxUsers` cap while respecting the `allowlist`.

When new users are upserted into `users.jsonl`:
1.  The entire dataset is merged and **sorted descending by `total_contributions`**.
2.  An `effectiveMax` is calculated as `maxUsers + allowlist.size`. This guarantees that manually allowlisted users (who might have low code contributions but high community impact) do not consume the 50,000 organic slots.
3.  If the sorted list exceeds `effectiveMax`, it is truncated.
4.  The logins that fell below the cut line are passed to `deleteUsers()`, removed from `tracker.json`, and the `threshold.json` file is updated to reflect the new minimum entry bar.

This automatic pruning ensures the DevIndex remains a true, competitive meritocracy.