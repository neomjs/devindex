import {createHash}                   from 'crypto';
import fs                             from 'fs';
import path                           from 'path';
import {spawnSync}                    from 'child_process';
import {fileURLToPath, pathToFileURL} from 'url';

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
 * @summary Assembles the GitHub Pages site from a production build, with the app's entry at the site root.
 *
 * A project site lives under a mount (`/devindex/`), and the origin root above it belongs to another site, so every
 * relative URL must stay inside the mount. The page and the workers resolve `basePath` against different bases —
 * the page against its own location, a worker against its script — so the root `index.html` sets `<base>` to
 * `dist/production/`, the directory the workers are served from, and the site's `neo-config.json` sits there:
 * `basePath: '../../'` then names the mount from both sides. `<base>` also re-targets `#` links, so a click handler
 * keeps hash routes on the page, as the engine portal's root entry does.
 *
 * The contributor index is required: a green build of an empty grid is not a deploy.
 * @param {Object} options
 * @param {String} options.build     The production build directory (`dist/production`)
 * @param {String} options.dataFile  The pulled `users.jsonl`
 * @param {String} options.learnDir  The guides the learn view reads
 * @param {String} options.imagesDir The workspace images the app references
 * @param {String} options.out       The site directory to create; replaced when it exists
 * @param {Object} options.receipt   Provenance written to `deploy-receipt.json`, e.g. commit and data source
 * @returns {Object} The receipt as written, with `dataRecords` and `dataDigest` added
 */
export function assembleSite({build, dataFile, learnDir, imagesDir, out, receipt}) {
    const
        appEntry = path.join(build, 'apps/devindex'),
        data     = fs.existsSync(dataFile) ? fs.readFileSync(dataFile) : null,
        records  = data ? data.toString('utf-8').split('\n').filter(line => line.trim()).length : 0;

    if (!records) {
        throw new Error(`${dataFile} is missing or empty: an empty contributor grid is not a deploy`)
    }

    fs.rmSync(out, {force: true, recursive: true});

    fs.cpSync(build,     path.join(out, 'dist/production'), {recursive: true});
    fs.cpSync(learnDir,  path.join(out, 'learn'),           {recursive: true});
    fs.cpSync(imagesDir, path.join(out, 'resources/images'), {recursive: true});

    fs.mkdirSync(path.join(out, 'apps/devindex/resources/data'), {recursive: true});
    fs.writeFileSync(path.join(out, 'apps/devindex/resources/data/users.jsonl'), data);

    const config = JSON.parse(fs.readFileSync(path.join(appEntry, 'neo-config.json'), 'utf-8'));

    fs.writeFileSync(path.join(out, 'dist/production/neo-config.json'), JSON.stringify({...config, basePath: '../../', workerBasePath: './'}));
    fs.writeFileSync(path.join(out, 'index.html'), rootEntry(fs.readFileSync(path.join(appEntry, 'index.html'), 'utf-8')));

    const written = {...receipt, dataDigest: createHash('sha256').update(data).digest('hex'), dataRecords: records};

    fs.writeFileSync(path.join(out, 'deploy-receipt.json'), JSON.stringify(written, null, 4));

    return written
}

/**
 * @summary Turns the build's app entry, which expects to sit in `dist/production/apps/devindex/`, into the site root's.
 * Every rewrite must match: a changed build shape fails the assembly instead of shipping a page that loads nothing.
 * @param {String} html
 * @returns {String}
 */
export function rootEntry(html) {
    return [
        ['<head>',                               '<head><base href="./dist/production/">'],
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
        {default: config} = await import('../apps/devindex/services/config.mjs'),
        dataFile          = config.paths.users,
        receipt           = assembleSite({
            build    : path.join(root, 'dist/production'),
            dataFile,
            imagesDir: path.join(root, 'resources/images'),
            learnDir : path.join(root, 'learn'),
            out      : path.join(root, process.argv[2] || '_site'),
            receipt  : {
                commit    : process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf-8'}).stdout.trim(),
                dataSource: `${config.publishedWorkingSet.baseUrl}${path.basename(dataFile)}`,
                neoVersion: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/neo.mjs/package.json'), 'utf-8')).version,
                publicBase: 'https://neomjs.github.io/devindex/'
            }
        });

    console.log(`[pages] Site assembled: ${receipt.dataRecords.toLocaleString('en-US')} contributor records, neo.mjs ${receipt.neoVersion}, commit ${receipt.commit.slice(0, 10)}.`)
}
