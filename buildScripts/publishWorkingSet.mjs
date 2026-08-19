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

    // Recomputed from what is on disk RIGHT NOW rather than trusting a stamp written earlier in the
    // run: the manifest must describe the bytes actually being uploaded, or it certifies a set that
    // was never published.
    await Storage.recordWorkingSetManifest();

    for (const {file, path: localPath} of members) {
        await assertReadable(localPath, file);
        await run('gcloud', ['storage', 'cp', localPath, `${bucket}/${file}`]);
    }

    // LAST, and the ordering is the guarantee — see the module docblock.
    const manifestPath = config.paths.workingSetManifest,
          manifestFile = manifestPath.slice(manifestPath.lastIndexOf('/') + 1);

    await run('gcloud', ['storage', 'cp', manifestPath, `${bucket}/${manifestFile}`]);

    console.log(`[publish] Published ${members.length} objects plus the manifest to ${bucket}.`)
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
