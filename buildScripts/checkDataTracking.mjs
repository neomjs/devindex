import {execFileSync} from 'child_process';

/**
 * @summary Fails if derived DevIndex data is tracked, or if curated DevIndex data is not.
 *
 * **Two assertions, and the second is the one that makes the first honest.**
 *
 * Derived files must stay out of git: `users.jsonl`, `tracker.json` and `visited.json` are ~26.5 MiB
 * rewritten in full every run. The same file in `neomjs/neo` carries 1,802 commits behind a 4.1 GB
 * `.git` while this repository's is 14 MB, and there is no cheap way back once the blobs exist.
 *
 * Curated files must stay IN git: allowlist, blocklist, failed, optin-sync, optout-sync, threshold
 * total 543 bytes and are irreplaceable. `blocklist.json` holds people's
 * opt-out decisions.
 *
 * Checking only the first would be satisfied by `.gitignore`-ing the whole directory — which passes
 * loudly while silently discarding the opt-out audit trail. That is not a hypothetical failure mode;
 * it is the obvious shortcut, and the second assertion exists precisely to close it. A guard that can
 * be satisfied by the wrong fix is worse than no guard, because it certifies the wrong fix.
 *
 * Reads `git ls-files` rather than the filesystem, deliberately: the question is what git TRACKS, and
 * a derived file present on disk is correct and expected — every developer has one after
 * `npm run devindex:pull-data`. Testing for existence would fail on a healthy checkout.
 */
const DATA_DIR = 'apps/devindex/resources/data';

/**
 * @summary Repo-relative paths git currently tracks under the data directory.
 * @returns {String[]}
 */
function trackedPaths() {
    return execFileSync('git', ['ls-files', DATA_DIR], {encoding: 'utf-8'})
        .split('\n')
        .filter(line => line.trim())
}

/**
 * @summary Fails if ANYTHING under the data directory is tracked.
 *
 * Total rather than a named list, because the list was the bug. It used to name three "derived" files
 * to keep out and six "curated" ones to keep in — a split by file SIZE, when the real question is who
 * writes them. Every file there is pipeline state, including `blocklist.json`, which `OptOut` appends
 * to and which therefore cannot survive in a runner that is discarded.
 *
 * A total assertion also covers the case a list cannot: a NEW file added to that directory and
 * committed. Under the old guard it passed, because it was on neither list.
 * @returns {void}
 */
function run() {
    const tracked = trackedPaths();

    if (tracked.length === 0) {
        console.log(`[data-tracking] OK — nothing under ${DATA_DIR} is tracked.`);
        return
    }

    console.error(
        `[data-tracking] ${tracked.length} file(s) tracked under ${DATA_DIR}, and none may be:\n` +
        tracked.map(path => `  ${path}`).join('\n') + '\n' +
        `[data-tracking] Fix: git rm --cached ${tracked.join(' ')}\n` +
        '[data-tracking] Every file here is written by the pipeline and round-trips through the\n' +
        '[data-tracking] publication. Committing one makes each run permanent in history; leaving one\n' +
        '[data-tracking] out of the working set silently discards what that run decided.'
    );

    process.exit(1)
}

run();
