import {test, expect}             from '@playwright/test';
import fs                         from 'fs';
import os                         from 'os';
import path                       from 'path';
import {assembleSite, rootEntry}  from '../../../../buildScripts/assemblePagesSite.mjs';

const ENTRY = '<!doctype html><html><head><meta charset="UTF-8"><link rel="icon" href="./resources/images/neo_logo_favicon.svg"></head><body><script src="../../src/MicroLoader.mjs" type="module"></script></body></html>';

/**
 * @summary A minimal production build and workspace inputs, as `assembleSite` reads them.
 * @param {String|null} users The contributor index, or `null` for none
 * @returns {Object} The `assembleSite` options, pointing into a fresh temp directory
 */
function fixture(users) {
    const
        dir   = fs.mkdtempSync(path.join(os.tmpdir(), 'devindex-pages-')),
        build = path.join(dir, 'dist/production'),
        entry = path.join(build, 'apps/devindex');

    fs.mkdirSync(entry, {recursive: true});
    fs.writeFileSync(path.join(entry, 'index.html'), ENTRY);
    fs.writeFileSync(path.join(entry, 'neo-config.json'), JSON.stringify({appPath: 'apps/devindex/app.mjs', basePath: '../../../../', mainPath: '../main.js', workerBasePath: '../../'}));
    fs.mkdirSync(path.join(dir, 'learn'));
    fs.writeFileSync(path.join(dir, 'learn/tree.json'), '{"data":[]}');
    fs.mkdirSync(path.join(dir, 'images'));
    fs.writeFileSync(path.join(dir, 'images/logo.svg'), '<svg/>');

    users !== null && fs.writeFileSync(path.join(dir, 'users.jsonl'), users);

    return {
        build,
        dataFile : path.join(dir, 'users.jsonl'),
        imagesDir: path.join(dir, 'images'),
        learnDir : path.join(dir, 'learn'),
        out      : path.join(dir, '_site'),
        receipt  : {commit: 'abc123'}
    }
}

/**
 * The Pages site's assembly: the app entry moves to the site root without leaving the mount, and a site without
 * contributors is refused before anything could be uploaded.
 */
test.describe('buildScripts/assemblePagesSite', () => {
    for (const [label, users] of [['missing', null], ['empty', ''], ['blank lines only', '\n\n']]) {
        test(`a ${label} contributor index refuses the site and writes nothing`, () => {
            const options = fixture(users);

            expect(() => assembleSite(options)).toThrow(/missing or empty/);
            expect(fs.existsSync(options.out)).toBe(false)
        })
    }

    test('the site root serves the app from one base, and the receipt names the data it shipped', () => {
        const
            options = fixture('{"l":"a"}\n{"l":"b"}\n'),
            receipt = assembleSite(options),
            {out}   = options,
            index   = fs.readFileSync(path.join(out, 'index.html'), 'utf-8'),
            config  = JSON.parse(fs.readFileSync(path.join(out, 'dist/production/neo-config.json'), 'utf-8'));

        expect(index).toContain('<head><base href="./dist/production/">');
        expect(index).toContain('src="src/MicroLoader.mjs"');
        expect(index).toContain('href="apps/devindex/resources/images/neo_logo_favicon.svg"');
        expect(index).toContain('window.location.hash = target.getAttribute(\'href\')');

        expect(config).toMatchObject({appPath: 'apps/devindex/app.mjs', basePath: '../../', mainPath: '../main.js', workerBasePath: './'});

        expect(fs.readFileSync(path.join(out, 'apps/devindex/resources/data/users.jsonl'), 'utf-8')).toBe('{"l":"a"}\n{"l":"b"}\n');
        expect(fs.existsSync(path.join(out, 'learn/tree.json'))).toBe(true);
        expect(fs.existsSync(path.join(out, 'resources/images/logo.svg'))).toBe(true);

        expect(receipt).toMatchObject({commit: 'abc123', dataRecords: 2});
        expect(receipt.dataDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.parse(fs.readFileSync(path.join(out, 'deploy-receipt.json'), 'utf-8'))).toEqual(receipt)
    });

    test('a build entry of another shape fails instead of shipping a page that loads nothing', () => {
        expect(() => rootEntry(ENTRY.replace('../../src/MicroLoader.mjs', '../src/MicroLoader.mjs'))).toThrow(/shape changed/)
    })
});
