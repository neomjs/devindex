import {test, expect}  from '@playwright/test';
import {spawnSync}     from 'child_process';
import fs              from 'fs';
import os              from 'os';
import path            from 'path';
import {fileURLToPath} from 'url';
import {load}          from 'js-yaml';

const
    REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'),
    WORKFLOW  = load(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/data-sync-pipeline.yml'), 'utf-8')),
    STEPS     = WORKFLOW.jobs.collect.steps,
    PROBE     = STEPS.find(({name}) => name === 'Probe publish access').run;

/**
 * @summary Runs the workflow's own probe script against a stub `gcloud` that answers with a fixed output.
 * @param {Object} gcloud `{out, exit}` for the stub's one call
 * @param {String} [bucket='gs://neomjs-middleware-dist/devindex']
 * @returns {{status: Number, stdout: String}}
 */
function probe({out, exit}, bucket='gs://neomjs-middleware-dist/devindex') {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'devindex-probe-'));

    fs.writeFileSync(path.join(bin, 'gcloud'), `#!/usr/bin/env bash\necho ${JSON.stringify(out)}\nexit ${exit}\n`, {mode: 0o755});

    const {status, stdout} = spawnSync('bash', ['-e', '-c', PROBE], {
        encoding: 'utf-8',
        env     : {...process.env, DEVINDEX_PUBLISH_BUCKET: bucket, PATH: `${bin}:${process.env.PATH}`}
    });

    return {status, stdout}
}

/**
 * The publish probe runs before the stages and gates the run, so its classification decides whether an empty
 * store can ever be filled: the destination holds nothing until the first publish, and the publish runs after
 * the probe.
 */
test.describe('data-sync pipeline — the publish probe', () => {
    test('a destination that lists objects passes', () => {
        const {status, stdout} = probe({exit: 0, out: 'gs://neomjs-middleware-dist/devindex/users.jsonl'});

        expect(status).toBe(0);
        expect(stdout).toContain('can read the destination')
    });

    test('an empty destination the identity can list passes, so the first publish can fill it', () => {
        const {status, stdout} = probe({exit: 1, out: 'ERROR: (gcloud.storage.ls) One or more URLs matched no objects.'});

        expect(status).toBe(0);
        expect(stdout).toContain('holds nothing yet')
    });

    test('a refused listing fails as the bucket grant', () => {
        const {status, stdout} = probe({exit: 1, out: 'ERROR: (gcloud.storage.ls) [devindex-publish-sa] does not have storage.objects.list access (403)'});

        expect(status).toBe(1);
        expect(stdout).toContain('the bucket grant, not the identity')
    });

    test('a refused impersonation fails as the identity', () => {
        const {status, stdout} = probe({exit: 1, out: 'ERROR: Failed to impersonate: getAccessToken 403 PERMISSION_DENIED'});

        expect(status).toBe(1);
        expect(stdout).toContain('Impersonation refused')
    });

    test('an unset destination fails before any listing', () => {
        const {status, stdout} = probe({exit: 0, out: 'never called'}, '');

        expect(status).toBe(1);
        expect(stdout).toContain('DEVINDEX_PUBLISH_BUCKET is not set')
    });

    test('the probe and the store token come before every stage that hydrates', () => {
        const names = STEPS.map(({name}) => name),
              auth  = names.indexOf('Authenticate to Google Cloud');

        expect(auth).toBeGreaterThan(-1);
        expect(names.indexOf('Probe publish access')).toBeGreaterThan(auth);

        STEPS.filter(({name}) => name.startsWith('DevIndex ')).forEach(({env, name}) => {
            expect(names.indexOf(name), `${name} runs after the probe`).toBeGreaterThan(names.indexOf('Probe publish access'));
            expect(env.DEVINDEX_STORE_TOKEN, `${name} can hydrate from the store`).toContain('steps.gcp-auth.outputs.access_token')
        })
    })
});
