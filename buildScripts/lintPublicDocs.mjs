import fs            from 'node:fs';
import path          from 'node:path';
import process       from 'node:process';
import {fileURLToPath} from 'node:url';

/**
 * @module buildScripts.lintPublicDocs
 * @summary Validates `docs/public-manifest.json` against `learn/tree.json` and enforces public-publish hygiene across
 * every manifest-admitted Markdown guide.
 *
 * Default-deny spoke federation requires two guarantees:
 * 1. **Structural parity:** Every `learn/tree.json` leaf is explicitly listed in `docs/public-manifest.json` at its
 *    canonical `/learn/guides/devindex/<id>` route, and every manifest entry resolves to a real tracked `.md` file
 *    inside `learn/` with no path traversal or duplicate routes.
 * 2. **Content hygiene:** Admitted product guides contain zero real host filesystem paths (`/Users/<name>/`,
 *    `/home/<name>/`, `C:\Users\<name>\`), zero private-repository identifiers (`neomjs/business`,
 *    `neomjs/neo-stage`, `neomjs/neo-pro`), and zero broken relative `.md` links outside fenced code blocks, while
 *    permitting public `@neo-*` maintainer handles used in illustrative examples.
 */

const
    __filename      = fileURLToPath(import.meta.url),
    REPO_ROOT       = path.resolve(path.dirname(__filename), '..'),
    DEFAULT_PREFIX  = '/learn/guides/devindex/',
    EXPECTED_SCHEMA = 'public-manifest.v1',
    EXPECTED_SPOKE  = 'neomjs/devindex',
    // Root-anchored Unix/macOS & Windows user home paths; ignores repo-relative segments like `view/home/MainContainer.mjs`
    // and generic placeholders (`<you>`, `<user>`, `<username>`, `you`, `user`, `username`).
    UNIX_HOST_PATH_RE = /(?:^|[\s`'"(=])(\/(?:Users|home)\/(?![<{]|(?:you|user|username)(?:\/|\b))[A-Za-z0-9._-]+\/[^\s`'")>\]]*)/gm,
    WIN_HOST_PATH_RE  = /(?:^|[\s`'"(=])([A-Za-z]:\\Users\\(?![<{]|(?:you|user|username)(?:\\|\b))[A-Za-z0-9._-]+\\[^\s`'")>\]]*)/gm,
    PRIVATE_REPO_RE   = /\bneomjs\/(?:business|neo-stage|neo-pro)\b/gi,
    MD_LINK_RE        = /\[[^\]]*\]\(([^)#?\s]+\.md)(?:[?#][^)]*)?\)/g,
    FENCE_RE          = /^ {0,3}(`{3,}|~{3,})/;

/**
 * @summary Strips fenced Markdown code blocks while preserving line numbers for diagnostic reporting.
 * @param {String} markdown
 * @returns {String}
 */
export function stripFencedCodeBlocks(markdown) {
    const
        lines = String(markdown).split('\n'),
        out   = [];

    let fence = null;

    for (const rawLine of lines) {
        const
            line  = rawLine.replace(/\r$/, ''),
            match = FENCE_RE.exec(line);

        if (fence) {
            if (match && match[1][0] === fence[0] && match[1].length >= fence.length) {
                fence = null
            }
            out.push('');
            continue
        }

        if (match) {
            fence = match[1];
            out.push('');
            continue
        }

        out.push(line)
    }

    return out.join('\n')
}

/**
 * @summary Computes the 1-based line number for a character offset in a string.
 * @param {String} text
 * @param {Number} index
 * @returns {Number}
 */
function lineAt(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) {
        if (text[i] === '\n') line++
    }
    return line
}

/**
 * @summary Validates `docs/public-manifest.json`, `learn/tree.json`, and all admitted Markdown files under `root`.
 * @param {Object} [options={}]
 * @param {String} [options.root=REPO_ROOT] Repository root directory.
 * @param {String} [options.manifestRelPath='docs/public-manifest.json'] Manifest path relative to `root`.
 * @param {String} [options.routePrefix=DEFAULT_PREFIX] Required canonical URL prefix for routes in this spoke.
 * @param {String} [options.expectedSpoke=EXPECTED_SPOKE] Expected `spoke` identifier in the manifest.
 * @returns {{entryCount: Number, routes: String[]}}
 */
export function lintPublicDocs({
    root            = REPO_ROOT,
    manifestRelPath = 'docs/public-manifest.json',
    routePrefix     = DEFAULT_PREFIX,
    expectedSpoke   = EXPECTED_SPOKE
} = {}) {
    const
        errors       = [],
        manifestPath = path.resolve(root, manifestRelPath);

    if (!fs.existsSync(manifestPath)) {
        throw new Error(`[public-docs] Missing manifest: ${manifestRelPath}`)
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (err) {
        throw new Error(`[public-docs] Invalid JSON in ${manifestRelPath}: ${err.message}`)
    }

    if (manifest?.schema !== EXPECTED_SCHEMA) {
        errors.push(`schema must be "${EXPECTED_SCHEMA}" (got ${JSON.stringify(manifest?.schema)})`)
    }
    if (manifest?.spoke !== expectedSpoke) {
        errors.push(`spoke must be "${expectedSpoke}" (got ${JSON.stringify(manifest?.spoke)})`)
    }
    if (typeof manifest?.treeFile !== 'string' || !manifest.treeFile.trim()) {
        errors.push('treeFile must be a non-empty relative path')
    }
    if (!manifest?.treeMount || typeof manifest.treeMount.id !== 'string' || typeof manifest.treeMount.name !== 'string') {
        errors.push('treeMount must declare string id and name fields')
    }
    if (!Array.isArray(manifest?.entries) || manifest.entries.length === 0) {
        errors.push('entries must be a non-empty array')
    }

    if (errors.length > 0) {
        throw new Error(`[public-docs] ${manifestRelPath} failed header validation:\n  - ${errors.join('\n  - ')}`)
    }

    const treePath = path.resolve(root, manifest.treeFile);
    if (!fs.existsSync(treePath)) {
        throw new Error(`[public-docs] Missing treeFile declared by manifest: ${manifest.treeFile}`)
    }

    const tree = JSON.parse(fs.readFileSync(treePath, 'utf-8'));
    if (!Array.isArray(tree?.data)) {
        throw new Error(`[public-docs] ${manifest.treeFile} must contain a top-level "data" array`)
    }

    const
        learnRoot      = path.resolve(root, 'learn'),
        treeLeafByFile = new Map();

    for (const node of tree.data) {
        if (node.isLeaf !== false) {
            const relFile = `learn/${node.id}.md`;
            treeLeafByFile.set(relFile, node.id)
        }
    }

    const
        seenFiles  = new Set(),
        seenRoutes = new Set();

    for (const [index, entry] of manifest.entries.entries()) {
        const label = `entries[${index}]`;

        if (!entry || typeof entry.file !== 'string' || typeof entry.route !== 'string') {
            errors.push(`${label}: each entry requires string "file" and "route"`);
            continue
        }

        const normalizedFile = path.posix.normalize(entry.file);
        if (normalizedFile !== entry.file || !entry.file.startsWith('learn/') || !entry.file.endsWith('.md') || entry.file.includes('..')) {
            errors.push(`${label}: invalid file path "${entry.file}" (must be normalized "learn/<path>.md")`);
            continue
        }

        if (seenFiles.has(entry.file)) {
            errors.push(`${label}: duplicate file "${entry.file}"`)
        }
        seenFiles.add(entry.file);

        if (!entry.route.startsWith(routePrefix) || entry.route.endsWith('/') || entry.route.endsWith('.md') || entry.route.includes('..')) {
            errors.push(`${label}: invalid route "${entry.route}" (must start with "${routePrefix}" without trailing "/" or ".md")`)
        }

        const expectedId = treeLeafByFile.get(entry.file);
        if (expectedId && entry.route !== `${routePrefix}${expectedId}`) {
            errors.push(`${label}: route "${entry.route}" does not match pre-split tree route "${routePrefix}${expectedId}"`)
        }

        if (seenRoutes.has(entry.route)) {
            errors.push(`${label}: duplicate route "${entry.route}"`)
        }
        seenRoutes.add(entry.route);

        const absFile = path.resolve(root, entry.file);
        if (!absFile.startsWith(learnRoot + path.sep) || !fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
            errors.push(`${label}: missing Markdown file "${entry.file}"`);
            continue
        }

        const
            rawMarkdown = fs.readFileSync(absFile, 'utf-8'),
            proseOnly   = stripFencedCodeBlocks(rawMarkdown);

        for (const [regex, kind] of [
            [UNIX_HOST_PATH_RE, 'host filesystem path'],
            [WIN_HOST_PATH_RE,  'Windows host filesystem path']
        ]) {
            regex.lastIndex = 0;
            for (const match of rawMarkdown.matchAll(regex)) {
                const
                    token = match[1],
                    line  = lineAt(rawMarkdown, match.index + match[0].indexOf(token));
                errors.push(`${entry.file}:${line}: forbidden ${kind} "${token}"`)
            }
        }

        PRIVATE_REPO_RE.lastIndex = 0;
        for (const match of rawMarkdown.matchAll(PRIVATE_REPO_RE)) {
            const line = lineAt(rawMarkdown, match.index);
            errors.push(`${entry.file}:${line}: forbidden private-repository reference "${match[0]}"`)
        }

        MD_LINK_RE.lastIndex = 0;
        for (const match of proseOnly.matchAll(MD_LINK_RE)) {
            const target = match[1];
            if (/^(?:https?:|mailto:)/i.test(target) || target.startsWith('/')) continue;

            const resolvedTarget = path.resolve(path.dirname(absFile), target);
            if (!resolvedTarget.startsWith(learnRoot + path.sep) || !fs.existsSync(resolvedTarget)) {
                const line = lineAt(proseOnly, match.index);
                errors.push(`${entry.file}:${line}: broken relative Markdown link "${target}"`)
            }
        }
    }

    for (const relFile of treeLeafByFile.keys()) {
        if (!seenFiles.has(relFile)) {
            errors.push(`${manifest.treeFile}: leaf "${relFile}" is missing from ${manifestRelPath}`)
        }
    }

    for (const relFile of seenFiles) {
        if (!treeLeafByFile.has(relFile)) {
            errors.push(`${manifestRelPath}: "${relFile}" is not a leaf in ${manifest.treeFile}`)
        }
    }

    if (errors.length > 0) {
        throw new Error(`[public-docs] Validation failed (${errors.length} issue(s)):\n  - ${errors.join('\n  - ')}`)
    }

    return {
        entryCount: manifest.entries.length,
        routes    : [...seenRoutes]
    }
}

const isMainModule = (() => {
    if (!process.argv[1]) return false;
    try {
        return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)
    } catch {
        return path.resolve(process.argv[1]) === __filename
    }
})();

if (isMainModule) {
    try {
        const {entryCount} = lintPublicDocs();
        console.log(`[public-docs] OK — verified ${entryCount} manifest-listed guides against learn/tree.json.`)
    } catch (err) {
        console.error(err.message);
        process.exit(1)
    }
}
