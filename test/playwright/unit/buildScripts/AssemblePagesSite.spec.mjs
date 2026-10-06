import {test, expect}                      from '@playwright/test';
import fs                                  from 'fs';
import os                                  from 'os';
import path                                from 'path';
import {ENTRIES, assembleSite, entryPage}  from '../../../../buildScripts/assemblePagesSite.mjs';

const ENTRY = '<!doctype html><html><head><meta charset="UTF-8"><link rel="icon" href="./resources/images/neo_logo_favicon.svg"></head><body><script src="../../src/MicroLoader.mjs" type="module"></script></body></html>';

/**
 * @summary A minimal workspace after `build-all`, as `assembleSite` reads it.
 * @param {String|null} users The contributor index, or `null` for none
 * @returns {Object} The `assembleSite` options, pointing into a fresh temp directory
 */
function fixture(users) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devindex-pages-'));

    for (const entry of Object.values(ENTRIES)) {
        fs.mkdirSync(path.join(root, entry), {recursive: true});
        fs.writeFileSync(path.join(root, entry, 'index.html'), ENTRY);
        fs.writeFileSync(path.join(root, entry, 'neo-config.json'), JSON.stringify({appPath: 'apps/devindex/app.mjs', basePath: '../../../../', mainPath: '../main.js', workerBasePath: '../../'}));
    }

    fs.mkdirSync(path.join(root, 'learn'));
    fs.writeFileSync(path.join(root, 'learn/tree.json'), '{"data":[]}');
    fs.mkdirSync(path.join(root, 'resources/images'), {recursive: true});
    fs.writeFileSync(path.join(root, 'resources/images/logo.svg'), '<svg/>');

    users !== null && fs.writeFileSync(path.join(root, 'users.jsonl'), users);

    return {
        dataFile  : path.join(root, 'users.jsonl'),
        out       : path.join(root, '_site'),
        publicBase: 'https://example.test/devindex/',
        receipt   : {commit: 'abc123'},
        root
    }
}

/**
 * The Pages site's assembly: every build's entry reaches the mount from its own directory, production's entry also
 * serves the site root, and a site without contributors or without a build is refused before anything is written.
 */
test.describe('buildScripts/assemblePagesSite', () => {
    for (const [label, users] of [['missing', null], ['empty', ''], ['blank lines only', '\n\n']]) {
        test(`a ${label} contributor index refuses the site and writes nothing`, () => {
            const options = fixture(users);

            expect(() => assembleSite(options)).toThrow(/missing or empty/);
            expect(fs.existsSync(options.out)).toBe(false)
        })
    }

    test('every entry serves the app from its build\'s directory, and the receipt names the data and entries it shipped', () => {
        const
            options = fixture('{"l":"a"}\n{"l":"b"}\n'),
            receipt = assembleSite(options),
            {out}   = options,
            page    = file => fs.readFileSync(path.join(out, file), 'utf-8'),
            root    = page('index.html');

        expect(root).toContain('<head><base href="./dist/production/">');
        expect(root).toContain('src="src/MicroLoader.mjs"');
        expect(root).toContain('href="apps/devindex/resources/images/neo_logo_favicon.svg"');
        expect(root).toContain('window.location.hash = target.getAttribute(\'href\')');

        for (const [build, entry] of Object.entries(ENTRIES)) {
            const config = JSON.parse(page(`${build}/neo-config.json`));

            expect(page(`${entry}index.html`)).toContain('<head><base href="../../">');
            expect(config).toMatchObject({appPath: 'apps/devindex/app.mjs', basePath: '../../', isGitHubPages: true, mainPath: '../main.js', workerBasePath: './'});

            // The page's base is the build's directory, where its workers run: `basePath` names the mount from both
            expect(new URL(config.basePath, new URL(`${build}/`, receipt.publicBase)).href).toBe(receipt.publicBase);
            expect(receipt.entries[build]).toBe(new URL(entry, receipt.publicBase).href)
        }

        expect(page('apps/devindex/resources/data/users.jsonl')).toBe('{"l":"a"}\n{"l":"b"}\n');
        expect(fs.existsSync(path.join(out, 'learn/tree.json'))).toBe(true);
        expect(fs.existsSync(path.join(out, 'resources/images/logo.svg'))).toBe(true);

        expect(receipt).toMatchObject({commit: 'abc123', contentBase: 'https://example.test/devindex/learn/', dataRecords: 2, publicBase: 'https://example.test/devindex/'});
        expect(Object.keys(receipt.entries)).toEqual(['dist/development', 'dist/production']);
        expect(receipt.dataDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.parse(page('deploy-receipt.json'))).toEqual(receipt)
    });

    test('a workspace missing a build refuses the site before anything is written', () => {
        const options = fixture('{"l":"a"}\n');

        fs.rmSync(path.join(options.root, 'dist/development'), {recursive: true});

        expect(() => assembleSite(options)).toThrow(/no dist\/development\/apps\/devindex\/index\.html/);
        expect(fs.existsSync(options.out)).toBe(false)
    });

    test('a public base without its trailing slash is refused before anything is written', () => {
        const options = {...fixture('{"l":"a"}\n'), publicBase: 'https://example.test/devindex'};

        expect(() => assembleSite(options)).toThrow(/must end with a slash/);
        expect(fs.existsSync(options.out)).toBe(false)
    });

    test('a build entry of another shape fails instead of shipping a page that loads nothing', () => {
        expect(() => entryPage(ENTRY.replace('../../src/MicroLoader.mjs', '../src/MicroLoader.mjs'), '../../')).toThrow(/shape changed/)
    })
});
