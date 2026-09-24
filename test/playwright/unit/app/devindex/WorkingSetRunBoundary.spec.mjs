import {test, expect}  from '@playwright/test';
import {spawnSync}     from 'child_process';
import fs              from 'fs';
import os              from 'os';
import path            from 'path';
import {fileURLToPath} from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/**
 * The child's preload. Every working-set path moves into `DEVINDEX_TEST_DATA_DIR`, `fetch` serves the published
 * set from `DEVINDEX_TEST_PUBLISHED` (a JSON map of basename → body; the manifest answers 404), and the stage
 * bodies are replaced by the Storage calls a real stage makes first, per `DEVINDEX_TEST_STAGE`. Everything else —
 * `cli.mjs`, the Manager, Storage, the publisher — is the real code. The disk is slow, as on a CI runner: every
 * `fs/promises.access` waits 30 ms, so Storage's `ensureFiles()` is still running when anything that skips its
 * `ready()` reads the set (#37).
 */
const PRELOAD = `
import Neo       from '${REPO_ROOT}/node_modules/neo.mjs/src/Neo.mjs';
import * as core from '${REPO_ROOT}/node_modules/neo.mjs/src/core/_export.mjs';
import fsp       from 'fs/promises';
import path      from 'path';

const access = fsp.access;
fsp.access = async (...args) => {await new Promise(resolve => setTimeout(resolve, 30)); return access(...args)};

const {default: config} = await import('${REPO_ROOT}/apps/devindex/services/config.mjs');

Object.keys(config.paths).forEach(key => {
    config.paths[key] = path.join(process.env.DEVINDEX_TEST_DATA_DIR, path.basename(config.paths[key]))
});

const published = JSON.parse(process.env.DEVINDEX_TEST_PUBLISHED || '{}');

globalThis.fetch = async url => {
    const body = published[url.slice(url.lastIndexOf('/') + 1)];
    return body === undefined ? {ok: false, status: 404, text: async () => ''} : {ok: true, status: 200, text: async () => body}
};

const {default: Storage} = await import('${REPO_ROOT}/apps/devindex/services/Storage.mjs'),
      {default: OptIn}   = await import('${REPO_ROOT}/apps/devindex/services/OptIn.mjs'),
      {default: OptOut}  = await import('${REPO_ROOT}/apps/devindex/services/OptOut.mjs');

OptIn.run = async () => {
    if (process.env.DEVINDEX_TEST_STAGE === 'optin-removes') {
        await Storage.removeFromBlocklist(['old-block']);
        await Storage.getTracker()
    }
};

OptOut.run = async () => {
    await Storage.addToBlocklist(['opted-out']);
    await Storage.saveOptOutSync({lastCheck: '2026-09-24T12:00:00Z'});
    await Storage.deleteUsers(['opted-out'])
};
`;

const USERS = count => Array.from({length: count}, (_, i) => JSON.stringify({l: `user-${i}`})).join('\n') + '\n';

/**
 * @summary A published set of nine members; `blocklist` and the index size vary per arm.
 * @param {Object} [options]
 * @param {String[]} [options.blocklist=[]]
 * @param {Number}   [options.users=3]
 * @returns {Object} basename → body
 */
function publishedSet({blocklist=[], users=3}={}) {
    return {
        'allowlist.json'  : '[]',
        'blocklist.json'  : JSON.stringify(blocklist),
        'failed.json'     : '{}',
        'optin-sync.json' : '{"lastCheck":null}',
        'optout-sync.json': '{"lastCheck":null}',
        'threshold.json'  : '{}',
        'tracker.json'    : '{}',
        'users.jsonl'     : USERS(users),
        'visited.json'    : '[]'
    }
}

/**
 * @summary A fresh runner: an empty data directory, the preload, and a stub `gcloud` that records its calls.
 * @returns {Object}
 */
function runner() {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'devindex-run-')),
          data = path.join(dir, 'data'),
          bin  = path.join(dir, 'bin');

    fs.mkdirSync(data);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(dir, 'preload.mjs'), PRELOAD);
    fs.writeFileSync(path.join(bin, 'gcloud'), `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(path.join(dir, 'gcloud.log'))}\n`, {mode: 0o755});

    return {
        data,
        gcloudCalls: () => fs.existsSync(path.join(dir, 'gcloud.log')) ? fs.readFileSync(path.join(dir, 'gcloud.log'), 'utf-8').trim().split('\n') : [],
        read       : file => fs.readFileSync(path.join(data, file), 'utf-8'),
        run        : (script, args, env) => spawnSync(process.execPath, ['--import', path.join(dir, 'preload.mjs'), path.join(REPO_ROOT, script), ...args], {
            cwd     : REPO_ROOT,
            encoding: 'utf-8',
            timeout : 60_000,
            env     : {
                ...process.env,
                CI                    : '',
                DEVINDEX_PUBLISH_BUCKET: '',
                DEVINDEX_STORE_TOKEN  : '',
                DEVINDEX_TEST_DATA_DIR: data,
                GITHUB_RUN_ATTEMPT    : '1',
                GITHUB_RUN_ID         : '77',
                PATH                  : `${bin}:${process.env.PATH}`,
                ...env
            }
        }),
        write      : (file, body) => fs.writeFileSync(path.join(data, file), body)
    }
}

/**
 * The run boundary, through the real CLI and the real publisher in separate processes, the way the workflow runs
 * them: a stage's first write must come after its run's one hydration, and the publisher's collapse check must
 * compare against what that hydration adopted.
 */
test.describe('DevIndex working set — the run boundary', () => {
    test('no opt-ins, then an opt-out: the new blocklist entry and sync state survive into the next stage', () => {
        const r         = runner(),
              published = JSON.stringify(publishedSet());

        const optin  = r.run('apps/devindex/services/cli.mjs', ['optin'],  {DEVINDEX_TEST_PUBLISHED: published, DEVINDEX_TEST_STAGE: 'optin-none'}),
              optout = r.run('apps/devindex/services/cli.mjs', ['optout'], {DEVINDEX_TEST_PUBLISHED: published});

        expect(optin.status,  optin.stderr).toBe(0);
        expect(optout.status, optout.stderr).toBe(0);

        expect(JSON.parse(r.read('blocklist.json'))).toContain('opted-out');
        expect(JSON.parse(r.read('optout-sync.json')).lastCheck).toBe('2026-09-24T12:00:00Z')
    });

    test('an opt-in\'s blocklist removal before its first read survives that read', () => {
        const r         = runner(),
              published = JSON.stringify(publishedSet({blocklist: ['old-block']}));

        const optin = r.run('apps/devindex/services/cli.mjs', ['optin'], {DEVINDEX_TEST_PUBLISHED: published, DEVINDEX_TEST_STAGE: 'optin-removes'});

        expect(optin.status, optin.stderr).toBe(0);
        expect(JSON.parse(r.read('blocklist.json'))).not.toContain('old-block')
    });

    test('the collapse check compares with the run\'s start, not the public seed', () => {
        const r = runner();

        // The run started from 60 records; the public seed would say 1,000; the run publishes 50 (83 %)
        r.write('users.jsonl', USERS(50));
        r.write('hydrated-run.txt', JSON.stringify({run: '77-1', users: 60}));

        const publish = r.run('buildScripts/publishWorkingSet.mjs', [], {
            DEVINDEX_PUBLISH_BUCKET: 'gs://test-bucket/devindex',
            DEVINDEX_TEST_PUBLISHED: JSON.stringify(publishedSet({users: 1000}))
        });

        expect(publish.status, publish.stderr).toBe(0);
        expect(r.gcloudCalls().some(call => call.includes('gs://test-bucket/devindex/users.jsonl'))).toBe(true)
    });

    test('a drop against the run\'s start refuses to publish, whatever the seed says', () => {
        const r = runner();

        r.write('users.jsonl', USERS(50));
        r.write('hydrated-run.txt', JSON.stringify({run: '77-1', users: 100}));

        const publish = r.run('buildScripts/publishWorkingSet.mjs', [], {
            DEVINDEX_PUBLISH_BUCKET: 'gs://test-bucket/devindex',
            DEVINDEX_TEST_PUBLISHED: JSON.stringify(publishedSet({users: 50}))
        });

        expect(publish.status).toBe(1);
        expect(publish.stderr).toContain('dropped from 100 to 50');
        expect(r.gcloudCalls()).toEqual([])
    });

    test('a run that never hydrated has no baseline and does not publish, even with the seed unreachable', () => {
        const r = runner();

        r.write('users.jsonl', USERS(50));

        const publish = r.run('buildScripts/publishWorkingSet.mjs', [], {DEVINDEX_PUBLISH_BUCKET: 'gs://test-bucket/devindex'});

        expect(publish.status).toBe(1);
        expect(publish.stderr).toContain('no run-start mark');
        expect(r.gcloudCalls()).toEqual([])
    })
});
