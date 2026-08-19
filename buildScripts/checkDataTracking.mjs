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
 * and the index provenance total 543 bytes and are irreplaceable. `blocklist.json` holds people's
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
const
    DATA_DIR = 'apps/devindex/resources/data',

    DERIVED = [
        'users.jsonl',
        'tracker.json',
        'visited.json'
    ],

    CURATED = [
        'allowlist.json',
        'blocklist.json',
        'failed.json',
        'index-provenance.json',
        'optin-sync.json',
        'optout-sync.json',
        'threshold.json'
    ];

/**
 * @summary Paths git currently tracks under the data directory.
 * @returns {Set<String>} Basenames, not full paths.
 */
function trackedBasenames() {
    const output = execFileSync('git', ['ls-files', DATA_DIR], {encoding: 'utf-8'});

    return new Set(
        output.split('\n')
            .filter(line => line.trim())
            .map(line => line.slice(line.lastIndexOf('/') + 1))
    )
}

/**
 * @summary Runs both assertions and reports every violation, rather than the first.
 * @returns {void}
 */
function run() {
    const
        tracked = trackedBasenames(),
        // Reported together: fixing one and rediscovering the other on the next run is two cycles for
        // one problem, and these two failures have opposite remedies.
        wronglyTracked   = DERIVED.filter(name => tracked.has(name)),
        wronglyUntracked = CURATED.filter(name => !tracked.has(name));

    if (wronglyTracked.length === 0 && wronglyUntracked.length === 0) {
        console.log(`[data-tracking] OK — ${DERIVED.length} derived file(s) untracked, ${CURATED.length} curated file(s) tracked.`);
        return
    }

    if (wronglyTracked.length > 0) {
        console.error(
            `[data-tracking] DERIVED data is tracked and must not be: ${wronglyTracked.join(', ')}.\n` +
            `[data-tracking] Fix: git rm --cached ${wronglyTracked.map(name => `${DATA_DIR}/${name}`).join(' ')}\n` +
            `[data-tracking] These are regenerated every run. Committing them is what took neomjs/neo's .git to 4.1 GB.`
        )
    }

    if (wronglyUntracked.length > 0) {
        console.error(
            `[data-tracking] CURATED data is NOT tracked and must be: ${wronglyUntracked.join(', ')}.\n` +
            `[data-tracking] Fix: git add -f ${wronglyUntracked.map(name => `${DATA_DIR}/${name}`).join(' ')}\n` +
            `[data-tracking] These cannot be regenerated — blocklist.json carries opt-out decisions. If a .gitignore\n` +
            `[data-tracking] rule swept the whole directory, narrow it to the three derived files instead.`
        )
    }

    process.exit(1)
}

run();
