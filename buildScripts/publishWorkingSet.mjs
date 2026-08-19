import fs        from 'fs/promises';
import {spawn}   from 'child_process';
import Neo       from '../node_modules/neo.mjs/src/Neo.mjs';
import * as core from '../node_modules/neo.mjs/src/core/_export.mjs';
import config    from '../apps/devindex/services/config.mjs';
import Storage   from '../apps/devindex/services/Storage.mjs';

/**
 * @summary Publishes the working set to the content plane, without committing anything.
 *
 * **This is the step that makes the whole migration true.** The derived files are regenerated in full
 * every run, so committing them makes every hour permanent — the same three files in `neomjs/neo`
 * carry 40.06 GB, 3.76 GB and 1.38 GB of blob bytes. Publishing them as objects instead means the
 * repository stops growing and the browser still reads them same-origin, because the Cloud Run
 * middleware serves this bucket at the app's own path.
 *
 * **Deliberately not a port of neo's `dataSyncPipeline.mjs`.** That script is 948 lines and every one
 * of its eighteen functions serves git publication, multi-credential scoping, or the deferred-failure
 * flag — three things this pipeline does not do. Its bounded state machine exists because neo commits
 * to `dev`, a branch humans also push to; an object upload has no rebase, no allowlist and no "did the
 * branch move" question. Porting it would inherit an answer to a question this architecture never
 * asks, and would tell the next reader that DevIndex commits somewhere.
 *
 * **Order matters and is the only real invariant here.** The manifest is written LAST, after all three
 * payload objects are uploaded. A reader that fetches a manifest is therefore reading one that
 * describes objects already present; the reverse order would advertise a set that is still arriving,
 * which is precisely the torn read `Storage.hydrateWorkingSet` refuses. Uploads are not transactional
 * — this ordering is what substitutes for that.
 */
const
    BUCKET_ENV = 'DEVINDEX_PUBLISH_BUCKET',
    bucket     = process.env[BUCKET_ENV];

/**
 * @summary Runs one command, rejecting on non-zero exit.
 * @param {String}   command
 * @param {String[]} args
 * @returns {Promise<void>}
 */
function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {stdio: 'inherit'});

        child.on('error', reject);
        child.on('close', code => code === 0
            ? resolve()
            : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)));
    })
}

/**
 * @summary Uploads the payload objects, then the manifest that describes them.
 * @returns {Promise<void>}
 */
async function publish() {
    if (!bucket) {
        throw new Error(
            `${BUCKET_ENV} is not set. Publishing has no destination, so this run produced data that ` +
            'would be discarded. Set it to the content-plane prefix (see the deployment repo).'
        )
    }

    const members = Storage.workingSetMembers();

    await assertNotCollapsed();

    // Recomputed from what is on disk RIGHT NOW rather than trusting a stamp written earlier in the
    // run: the manifest must describe the bytes actually being uploaded, or it certifies a set that
    // was never published.
    await Storage.recordWorkingSetManifest();

    for (const {file, path: localPath} of members) {
        await assertReadable(localPath, file);
        await run('gcloud', ['storage', 'cp', localPath, `${bucket}/${file}`]);
    }

    // A dated copy under a separate prefix, so there is a restore ladder past the 7-day soft-delete
    // window the bucket provides. Daily rather than hourly: hourly would be 24x the storage for
    // restore points nobody distinguishes, and the soft-delete window already covers today.
    const today = new Date().toISOString().slice(0, 10),
          users = members.find(member => member.key === 'users');

    await run('gcloud', ['storage', 'cp', users.path, `${bucket}/archive/users-${today}.jsonl`]);

    // LAST, and the ordering is the guarantee — see the module docblock.
    const manifestPath = config.paths.workingSetManifest,
          manifestFile = manifestPath.slice(manifestPath.lastIndexOf('/') + 1);

    await run('gcloud', ['storage', 'cp', manifestPath, `${bucket}/${manifestFile}`]);

    console.log(`[publish] Published ${members.length} objects plus the manifest to ${bucket}.`)
}

/**
 * @summary Refuses to publish an index that lost a large share of its records.
 *
 * **The failure this exists for is invisible, self-reinforcing, and permanent.** The pipeline reads
 * its own output: a corrupt set is published, the next run fetches it, the manifest MATCHES because
 * it is exactly what we wrote, and the damage is adopted as truth and compounds. The manifest proves
 * integrity of transmission, never correctness of content — a corrupt-but-consistent set passes every
 * check this pipeline has.
 *
 * Under git that was survivable: an implausible diff landed in a commit and 1,800 restore points sat
 * behind it. Publishing to an object store replaces that with a 7-day soft-delete window, so a
 * corruption nobody notices inside a week is unrecoverable.
 *
 * So this compares what is about to be published against what was fetched at the start of the run and
 * refuses a large drop. Pruning is legitimate and bounded — the meritocracy cap evicts the tail — but
 * it evicts a few, not a fifth. The threshold is deliberately loose: this is a catastrophe brake, not
 * a quality gate, and a brake that fires on ordinary churn gets disabled.
 * @returns {Promise<void>}
 */
async function assertNotCollapsed() {
    const
        THRESHOLD = 0.8,
        current   = (await fs.readFile(config.paths.users, 'utf-8').catch(() => '')).split('\n').filter(Boolean).length,
        previous  = await fetchPublishedCount();

    if (!previous) {
        console.log('[publish] No published index to compare against — skipping the collapse check.');
        return
    }

    if (current < previous * THRESHOLD) {
        throw new Error(
            `Refusing to publish: the index dropped from ${previous.toLocaleString('en-US')} to ` +
            `${current.toLocaleString('en-US')} records (${Math.round(100 * current / previous)}%). ` +
            'Pruning removes a tail, not a fifth of the index. Publishing this would overwrite the only ' +
            'copy and the next run would adopt it as truth. Set DEVINDEX_ALLOW_INDEX_COLLAPSE=1 if this ' +
            'drop is genuinely intended.'
        )
    }

    console.log(`[publish] Index size check: ${current.toLocaleString('en-US')} records (was ${previous.toLocaleString('en-US')}).`)
}

/**
 * @summary Record count of the currently published index, or null when there is none.
 * @returns {Promise<Number|null>}
 */
async function fetchPublishedCount() {
    if (process.env.DEVINDEX_ALLOW_INDEX_COLLAPSE) return null;

    const {baseUrl, timeout} = config.publishedWorkingSet,
          file               = config.paths.users.slice(config.paths.users.lastIndexOf('/') + 1);

    try {
        const response = await fetch(`${baseUrl}${file}`, {signal: AbortSignal.timeout(timeout)});

        if (!response.ok) return null;

        return (await response.text()).split('\n').filter(Boolean).length
    } catch (error) {
        return null
    }
}

/**
 * @summary Refuses to publish a member that is missing or empty.
 *
 * An empty object would be published as truth and adopted by the next run, so the cheap check is
 * worth more here than anywhere else in the pipeline.
 * @param {String} localPath
 * @param {String} file
 * @returns {Promise<void>}
 */
async function assertReadable(localPath, file) {
    const stat = await fs.stat(localPath).catch(() => null);

    if (!stat || stat.size === 0) {
        throw new Error(`${file} is missing or empty — refusing to publish a set that would truncate the next run.`)
    }
}

publish().catch(error => {
    console.error(`[publish] ${error.message}`);
    process.exit(1)
});
