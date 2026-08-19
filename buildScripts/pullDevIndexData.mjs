import fs           from 'fs';
import path         from 'path';
import Neo          from '../node_modules/neo.mjs/src/Neo.mjs';
import * as core    from '../node_modules/neo.mjs/src/core/_export.mjs';
import config       from '../apps/devindex/services/config.mjs';

/**
 * @summary Fetches the published contributor index onto disk, so the app serves it locally.
 *
 * **Why this exists at all: the index is DELIVERED, not versioned.**
 *
 * `users.jsonl` is ~23 MiB uncompressed and is regenerated in full every hour. Committing it is the
 * most expensive possible way to deliver a file with those two properties, and the cost is not
 * hypothetical — the same file in `neomjs/neo` has 1,802 commits behind it and a **4.1 GB** `.git`,
 * where this repository's is 14 MB. Every clone pays for every historical revision of a file nobody
 * ever reads the history of. So it is gitignored here and fetched instead.
 *
 * **Why fetched to disk rather than fetched by the browser.** The app reads
 * `apps/devindex/resources/data/users.jsonl` through a `basePath`-relative URL, which is same-origin
 * and needs no CORS, no proxy and no second code path — in a deployed build the publish step writes
 * the file to exactly that location. Pointing the store at a remote host instead would move the cost
 * from one download per developer to one download per visitor per page load, which is worse for
 * everyone including us. Local is right; *committed* was the part that was wrong.
 *
 * **Freshness is deliberately not guaranteed, because development does not need it.** A contributor
 * building UI works against 50,000 records whose currency is irrelevant to the work. The consumer
 * that genuinely needs the current index is the pipeline, and it fetches over HTTPS on every run with
 * a digest check (`Storage.hydrateWorkingSet`). Re-run this script when you want newer data; nothing
 * degrades if you never do.
 *
 * The URL is read from {@link DevIndex.services.Config} rather than restated here, so the producer
 * and this script cannot drift onto different artifacts — which is the whole failure mode the digest
 * check exists to catch, and it would be perverse to reintroduce it one directory away.
 */
const
    targetPath = config.paths.users,
    {baseUrl}  = config.publishedWorkingSet,
    url        = `${baseUrl}${targetPath.slice(targetPath.lastIndexOf('/') + 1)}`;

/**
 * @summary Whether this process should skip the fetch entirely.
 *
 * CI is the case worth naming: the collection workflow runs `npm ci` and never reads this file — its
 * producer fetches the index over HTTPS and verifies it. Downloading ~10 MB into a runner that is
 * about to discard it is pure waste, and it would fire on every scheduled run forever.
 * @returns {String|null} Reason to skip, or `null` to proceed.
 */
function skipReason() {
    if (process.env.CI)                            return 'CI is set — the pipeline fetches the index itself';
    if (process.env.DEVINDEX_SKIP_DATA_PULL)       return 'DEVINDEX_SKIP_DATA_PULL is set';
    return null
}

/**
 * @summary Downloads the index, or explains why the app will start empty.
 *
 * NEVER fatal. This runs from `postinstall`, and an offline install, a proxy or a transient 5xx must
 * not fail `npm install` for a file the repository can function without — the failure mode is one
 * empty grid with a printed remedy, not a broken checkout. Exiting non-zero here would make a
 * network hiccup indistinguishable from a broken dependency tree.
 * @returns {Promise<void>}
 */
async function run() {
    const skip = skipReason();

    if (skip) {
        console.log(`[devindex-data] Skipped — ${skip}.`);
        return
    }

    let response;

    try {
        response = await fetch(url, {signal: AbortSignal.timeout(120000)});
    } catch (error) {
        return warn(`fetch failed: ${error.message}`)
    }

    if (!response.ok) {
        return warn(`HTTP ${response.status} from ${url}`)
    }

    // Written via a temp file and renamed, so an interrupted download cannot leave a truncated index
    // in place. A half-written JSONL parses as far as its last complete line and would present as
    // missing contributors rather than as a failed download.
    const
        buffer   = Buffer.from(await response.arrayBuffer()),
        tempPath = `${targetPath}.tmp`;

    fs.mkdirSync(path.dirname(targetPath), {recursive: true});
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, targetPath);

    const
        lines = buffer.toString('utf-8').split('\n').filter(line => line.trim()).length,
        mib   = (buffer.length / 1024 / 1024).toFixed(1);

    console.log(`[devindex-data] Fetched ${lines.toLocaleString('en-US')} contributor records (${mib} MiB) to ${path.relative(process.cwd(), targetPath)}.`)
}

/**
 * @summary Reports a non-fatal failure with the command that fixes it.
 * @param {String} reason
 * @returns {void}
 */
function warn(reason) {
    console.warn(
        `[devindex-data] Could not fetch the contributor index — ${reason}.\n` +
        `[devindex-data] The app will start with an empty grid. Run \`npm run devindex:pull-data\` once you are online.`
    )
}

run();
