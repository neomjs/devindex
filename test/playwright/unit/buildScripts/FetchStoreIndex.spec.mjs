import {test, expect}    from '@playwright/test';
import {createHash}      from 'crypto';
import fs                from 'fs';
import os                from 'os';
import path              from 'path';
import {fetchStoreIndex} from '../../../../buildScripts/fetchStoreIndex.mjs';

const INDEX  = '{"l":"a"}\n{"l":"b"}\n',
      DIGEST = createHash('sha256').update(INDEX, 'utf-8').digest('hex'),
      BASE   = 'https://storage.googleapis.com/test-bucket/devindex/';

/**
 * The Pages site's data: the published index reaches the build only verified against the store's manifest, and a
 * store that cannot vouch for it stops the deploy instead of shipping something else.
 */
test.describe('buildScripts/fetchStoreIndex', () => {
    let original, requests;

    /**
     * @summary Serves the store from a map of object name → `{status, body}`; anything unmapped answers 404.
     * @param {Object} objects
     */
    function serve(objects) {
        globalThis.fetch = async (url, options) => {
            requests.push({authorization: options?.headers?.Authorization, url});

            const {body='', status=404} = objects[url.slice(BASE.length)] || {};

            return {ok: status >= 200 && status < 300, status, text: async () => body}
        }
    }

    const options = () => ({bucket: 'gs://test-bucket/devindex', out: fs.mkdtempSync(path.join(os.tmpdir(), 'devindex-store-')), token: 'token-1'});

    test.beforeEach(() => {
        original = globalThis.fetch;
        requests = []
    });

    test.afterEach(() => {
        globalThis.fetch = original
    });

    test('a published index matching the manifest is written, and the result names the publish', async () => {
        serve({
            'users.jsonl'              : {status: 200, body: INDEX},
            'working-set-manifest.json': {status: 200, body: JSON.stringify({digests: {users: DIGEST}, publishedAt: '2026-09-24T15:00:00.000Z'})}
        });

        const opts   = options(),
              result = await fetchStoreIndex(opts);

        expect(result).toEqual({digest: DIGEST, publishedAt: '2026-09-24T15:00:00.000Z', source: 'gs://test-bucket/devindex/users.jsonl'});
        expect(fs.readFileSync(path.join(opts.out, 'users.jsonl'), 'utf-8')).toBe(INDEX);
        expect(requests.every(request => request.authorization === 'Bearer token-1'), 'every read carries the token').toBe(true)
    });

    for (const [label, objects, message] of [
        ['a store that has published nothing', {}, /has published nothing yet/],
        ['a manifest without the index digest', {'working-set-manifest.json': {status: 200, body: '{"digests":{}}'}}, /carries no digest/],
        ['an index that does not match the manifest', {
            'users.jsonl'              : {status: 200, body: INDEX + '{"l":"c"}\n'},
            'working-set-manifest.json': {status: 200, body: JSON.stringify({digests: {users: DIGEST}})}
        }, /does not match the store's manifest/],
        ['a store that fails to answer for the index', {
            'users.jsonl'              : {status: 503},
            'working-set-manifest.json': {status: 200, body: JSON.stringify({digests: {users: DIGEST}})}
        }, /HTTP 503/]
    ]) {
        test(`${label} stops the deploy and writes nothing`, async () => {
            serve(objects);

            const opts = options();

            await expect(fetchStoreIndex(opts)).rejects.toThrow(message);
            expect(fs.existsSync(path.join(opts.out, 'users.jsonl'))).toBe(false)
        })
    }

    test('a missing store or token is refused before any request', async () => {
        serve({});

        await expect(fetchStoreIndex({...options(), token: ''})).rejects.toThrow(/DEVINDEX_STORE_TOKEN/);
        expect(requests).toEqual([])
    })
});
