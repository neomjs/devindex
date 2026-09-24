import {createHash}    from 'crypto';
import fs              from 'fs';
import path            from 'path';
import {pathToFileURL} from 'url';

// The store's object names, as `publishWorkingSet.mjs` writes them
const INDEX    = 'users.jsonl',
      MANIFEST = 'working-set-manifest.json';

/**
 * @summary Fetches the published contributor index from the store and verifies it against the store's manifest.
 *
 * This runs in the Pages workflow's `data` job, the only job there that holds a store token. It imports nothing but
 * Node builtins: the publish identity can write the store, and no dependency's code may share a process with that
 * credential. The build job receives the verified file as an artifact.
 *
 * There is no fallback. A store that has published nothing (its manifest answers 404) fails the deploy, the site
 * keeps its last one, and the first publish dispatches the next. Any other answer without a matching digest fails
 * the same way, because an unverified index is exactly what the site must not serve.
 * @param {Object} options
 * @param {String} options.bucket The store, as `gs://<bucket>/<prefix>`
 * @param {String} options.out    The directory to write `users.jsonl` into
 * @param {String} options.token  A short-lived access token for the store
 * @returns {Promise<Object>} `{digest, publishedAt, source}` of the index written
 */
export async function fetchStoreIndex({bucket, out, token}) {
    if (!bucket || !token) {
        throw new Error('the store and a token for it are both required: set DEVINDEX_PUBLISH_BUCKET and DEVINDEX_STORE_TOKEN')
    }

    const
        prefix  = bucket.replace(/^gs:\/\//, '').replace(/\/$/, ''),
        headers = {Authorization: `Bearer ${token}`},
        read    = async file => {
            const response = await fetch(`https://storage.googleapis.com/${prefix}/${file}`, {headers, signal: AbortSignal.timeout(120000)});

            if (response.status === 404 && file === MANIFEST) {
                throw new Error(`gs://${prefix}/ has published nothing yet, so there is no index to deploy. The site keeps its last deploy, and the first publish dispatches the next one.`)
            }

            if (!response.ok) {
                throw new Error(`gs://${prefix}/${file} answered HTTP ${response.status}`)
            }

            return response.text()
        },
        manifest = JSON.parse(await read(MANIFEST)),
        expected = manifest?.digests?.users;

    if (!expected) {
        throw new Error(`the store's ${MANIFEST} carries no digest for ${INDEX}, so the index cannot be verified`)
    }

    const
        index  = await read(INDEX),
        digest = createHash('sha256').update(index, 'utf-8').digest('hex');

    if (digest !== expected) {
        throw new Error(`${INDEX} does not match the store's manifest (recorded ${expected.slice(0, 12)}, fetched ${digest.slice(0, 12)})`)
    }

    fs.mkdirSync(out, {recursive: true});
    fs.writeFileSync(path.join(out, INDEX), index);

    return {digest, publishedAt: manifest.publishedAt ?? null, source: `gs://${prefix}/${INDEX}`}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const {DEVINDEX_PUBLISH_BUCKET: bucket, DEVINDEX_STORE_TOKEN: token, GITHUB_OUTPUT} = process.env;

    try {
        const {digest, publishedAt, source} = await fetchStoreIndex({bucket, out: process.argv[2] || '_data', token});

        GITHUB_OUTPUT && fs.appendFileSync(GITHUB_OUTPUT, `digest=${digest}\npublished-at=${publishedAt}\nsource=${source}\n`);
        console.log(`[store] ${source}, published ${publishedAt}, verified ${digest.slice(0, 12)}.`)
    } catch (error) {
        console.error(`[store] ${error.message}`);
        process.exit(1)
    }
}
