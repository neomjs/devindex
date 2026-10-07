import {createHash}                   from 'crypto';
import fs                             from 'fs';
import path                           from 'path';
import {spawnSync}                    from 'child_process';
import {fileURLToPath, pathToFileURL} from 'url';

// The directory the learn view's `contentPath` names, relative to the site root
const LEARN = 'learn';

/**
 * @summary Where the site serves the contributor index, relative to its root: the path the app fetches, and the
 * one a developer's `devindex:pull-data` reads from the deployed site.
 * @type {String}
 */
export const SITE_DATA = 'apps/devindex/resources/data/';

/**
 * @summary The builds the site ships, each whole in its own `dist/<env>/`, and the app's entry in each, relative to
 * the site root. The site root's entry is production's as well.
 * @type {Object<String, String>}
 */
export const ENTRIES = Object.freeze({
    'dist/development': 'dist/development/apps/devindex/',
    'dist/production' : 'dist/production/apps/devindex/'
});

const HASH_LINKS = `<script>
document.addEventListener('click', function(event) {
    let {target} = event;
    while (target && target.tagName !== 'A') target = target.parentElement;
    if (target?.getAttribute('href')?.startsWith('#')) {
        event.preventDefault();
        window.location.hash = target.getAttribute('href');
    }
});
</script>`;

/**
 * @summary Assembles the GitHub Pages site from a workspace after `build-all`: each build in {@link ENTRIES}, with
 * production's entry also at the site root.
 *
 * A project site lives under a mount (`/devindex/`), and the origin root above it belongs to another site, so every
 * relative URL must stay inside the mount. The page and the workers resolve `basePath` against different bases —
 * the page against its own location, a worker against its script — and a build's entry sits two levels below its
 * workers. Served at an origin root, a `basePath` that climbs past the root is clamped there, so the build works;
 * under a mount it leaves the site. Every entry therefore sets `<base>` to its build's directory, where the workers
 * are served from, and that build's `neo-config.json` sits there: `basePath: '../../'` then names the mount from both
 * sides, where the contributor index and the guides sit once for every build. `<base>` also re-targets `#` links, so
 * a click handler keeps hash routes on the page, as the engine portal's root entry does.
 *
 * The configs also set `isGitHubPages`, which the `pages` deployment sets for every site it builds. It keeps the
 * development-only Neural Link client off a public page, where it can only fail to reach a local bridge.
 *
 * The contributor index and every build are required: a green build of an empty grid, or of a site missing a build
 * the Portal links, is not a deploy. The index ships once, at {@link SITE_DATA}: a build's own copy of the app's
 * `resources/data/` is never copied.
 * @param {Object} options
 * @param {String} options.root       The workspace root, after `build-all`
 * @param {String} options.dataFile   The pulled `users.jsonl`
 * @param {String} options.out        The site directory to create; replaced when it exists
 * @param {String} options.publicBase The mount the site is served at, with its trailing slash
 * @param {Object} options.receipt    Provenance written to `deploy-receipt.json`, e.g. commit and data source
 * @returns {Object} The receipt as written, with `publicBase`, `contentBase`, `entries`, `dataRecords` and
 * `dataDigest` added
 */
export function assembleSite({root, dataFile, out, publicBase, receipt}) {
    // Without the slash, URL resolution drops the mount's last segment and every base in the receipt leaves the site
    if (!publicBase?.endsWith('/')) {
        throw new Error(`the public base \`${publicBase}\` must end with a slash`)
    }

    const
        data    = fs.existsSync(dataFile) ? fs.readFileSync(dataFile) : null,
        records = data ? data.toString('utf-8').split('\n').filter(line => line.trim()).length : 0,
        read    = (...file) => fs.readFileSync(path.join(root, ...file), 'utf-8'),
        missing = [...Object.values(ENTRIES).map(entry => `${entry}index.html`), LEARN, 'resources/images'].filter(file => !fs.existsSync(path.join(root, file)));

    if (!records) {
        throw new Error(`${dataFile} is missing or empty: an empty contributor grid is not a deploy`)
    }

    if (missing.length) {
        throw new Error(`the workspace has no ${missing.join(', ')}: run build-all before assembling the site`)
    }

    fs.rmSync(out, {force: true, recursive: true});

    for (const file of [...Object.keys(ENTRIES), LEARN, 'resources/images']) {
        const ownIndex = path.join(root, file, SITE_DATA);

        fs.cpSync(path.join(root, file), path.join(out, file), {filter: src => !`${src}${path.sep}`.startsWith(ownIndex), recursive: true})
    }

    fs.mkdirSync(path.join(out, SITE_DATA), {recursive: true});
    fs.writeFileSync(path.join(out, SITE_DATA, 'users.jsonl'), data);

    for (const [build, entry] of Object.entries(ENTRIES)) {
        const config = JSON.parse(read(entry, 'neo-config.json'));

        fs.writeFileSync(path.join(out, build, 'neo-config.json'), JSON.stringify({...config, basePath: '../../', isGitHubPages: true, workerBasePath: './'}));
        fs.writeFileSync(path.join(out, entry, 'index.html'), entryPage(read(entry, 'index.html'), '../../'))
    }

    fs.writeFileSync(path.join(out, 'index.html'), entryPage(read(ENTRIES['dist/production'], 'index.html'), './dist/production/'));

    const written = {
        ...receipt,
        contentBase: new URL(`${LEARN}/`, publicBase).href,
        dataDigest : createHash('sha256').update(data).digest('hex'),
        dataRecords: records,
        entries    : Object.fromEntries(Object.entries(ENTRIES).map(([build, entry]) => [build, new URL(entry, publicBase).href])),
        publicBase
    };

    fs.writeFileSync(path.join(out, 'deploy-receipt.json'), JSON.stringify(written, null, 4));

    return written
}

/**
 * @summary Turns a build's app entry, which expects to sit in `dist/<env>/apps/devindex/`, into a page whose base is
 * that build's directory. Every rewrite must match: a changed build shape fails the assembly instead of shipping a
 * page that loads nothing.
 * @param {String} html
 * @param {String} base The build's directory, relative to where the page is served
 * @returns {String}
 */
export function entryPage(html, base) {
    return [
        ['<head>',                               `<head><base href="${base}">`],
        ['src="../../src/MicroLoader.mjs"',      'src="src/MicroLoader.mjs"'],
        ['href="./resources/images/',            'href="apps/devindex/resources/images/'],
        ['</body>',                              `${HASH_LINKS}</body>`]
    ].reduce((page, [from, to]) => {
        if (!page.includes(from)) {
            throw new Error(`the build's app entry has no \`${from}\`: its shape changed`)
        }

        return page.replace(from, to)
    }, html)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    // The config module is a Neo class, so the class system loads first — and only here, not for importers
    await import('../node_modules/neo.mjs/src/Neo.mjs');
    await import('../node_modules/neo.mjs/src/core/_export.mjs');

    const
        root              = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        {default: config} = await import('../services/config.mjs'),
        dataFile          = config.paths.users,
        receipt           = assembleSite({
            dataFile,
            out       : path.join(root, process.argv[2] || '_site'),
            publicBase: config.publicSite,
            root,
            receipt   : {
                commit         : process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf-8'}).stdout.trim(),
                // The workflow's data job names the publish it verified; a local assembly has no such record
                dataPublishedAt: process.env.DEVINDEX_DATA_PUBLISHED_AT || null,
                dataSource     : process.env.DEVINDEX_DATA_SOURCE || 'local',
                neoVersion     : JSON.parse(fs.readFileSync(path.join(root, 'node_modules/neo.mjs/package.json'), 'utf-8')).version
            }
        });

    console.log(`[pages] Site assembled: ${receipt.dataRecords.toLocaleString('en-US')} contributor records, ${Object.keys(receipt.entries).join(' and ')}, neo.mjs ${receipt.neoVersion}, commit ${receipt.commit.slice(0, 10)}.`)
}
