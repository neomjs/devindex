import {test, expect}                       from '@playwright/test';
import fs                                   from 'node:fs';
import os                                   from 'node:os';
import path                                 from 'node:path';
import {lintPublicDocs, stripFencedCodeBlocks} from '../../../../buildScripts/lintPublicDocs.mjs';

const createdRoots = [];

/**
 * @summary Builds a minimal valid spoke fixture under `os.tmpdir()` for targeted negative/positive lint tests.
 * @param {Object} [overrides={}]
 * @returns {String} Temporary fixture root path
 */
function createFixture({
    guideBody          = '# Spider Engine\n\nSee [Intro](./Intro.md) and `apps/devindex/view/home/MainContainer.mjs` by `@neo-opus-grace`.\n',
    extraTreeLeaf      = false,
    extraManifestEntry = false,
    unlistedDiskFile   = false,
    mountIdOverride    = null,
    routeOverride      = null
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devindex-public-docs-'));
    createdRoots.push(root);

    fs.mkdirSync(path.join(root, 'docs'), {recursive: true});
    fs.mkdirSync(path.join(root, 'learn/data-factory'), {recursive: true});

    fs.writeFileSync(path.join(root, 'learn/data-factory/Intro.md'), '# Intro\n');
    fs.writeFileSync(path.join(root, 'learn/data-factory/Engine.md'), guideBody);

    if (unlistedDiskFile) {
        fs.writeFileSync(path.join(root, 'learn/data-factory/Internal.md'), '# Internal\n')
    }

    const treeData = [
        {name: 'The Data Factory', parentId: null, isLeaf: false, id: 'DataFactory'},
        {name: 'Introduction',     parentId: 'DataFactory',       id: 'data-factory/Intro'},
        {name: 'Spider Engine',    parentId: 'DataFactory',       id: 'data-factory/Engine'}
    ];

    if (extraTreeLeaf) {
        fs.writeFileSync(path.join(root, 'learn/data-factory/Extra.md'), '# Extra\n');
        treeData.push({name: 'Extra', parentId: 'DataFactory', id: 'data-factory/Extra'})
    }

    fs.writeFileSync(path.join(root, 'learn/tree.json'), JSON.stringify({data: treeData}, null, 4));

    const entries = [
        {file: 'learn/data-factory/Intro.md',  route: '/learn/guides/devindex/data-factory/Intro'},
        {file: 'learn/data-factory/Engine.md', route: routeOverride || '/learn/guides/devindex/data-factory/Engine'}
    ];

    if (extraManifestEntry) {
        fs.writeFileSync(path.join(root, 'learn/data-factory/Unlisted.md'), '# Unlisted\n');
        entries.push({file: 'learn/data-factory/Unlisted.md', route: '/learn/guides/devindex/data-factory/Unlisted'})
    }

    fs.writeFileSync(path.join(root, 'docs/public-manifest.json'), JSON.stringify({
        schema   : 'public-manifest.v1',
        spoke    : 'neomjs/devindex',
        treeFile : 'learn/tree.json',
        treeMount: {parentId: 'Guides', id: mountIdOverride || 'guides/devindex', name: 'DevIndex App'},
        entries
    }, null, 4));

    return root
}

test.describe('buildScripts/lintPublicDocs', () => {
    test.afterEach(() => {
        while (createdRoots.length > 0) {
            fs.rmSync(createdRoots.pop(), {recursive: true, force: true})
        }
    });
    test('the live neomjs/devindex manifest admits all 26 guides at their pre-split /learn/guides/devindex/* routes', () => {
        const result = lintPublicDocs();

        expect(result.entryCount).toBe(26);
        expect(result.routes).toContain('/learn/guides/devindex/data-factory/Engine');
        expect(result.routes).toContain('/learn/guides/devindex/Introduction')
    });

    test('passes clean prose containing repo-relative view/home/* paths, /Users/<you>/ placeholders, and public @neo-* handles', () => {
        const root = createFixture({
            guideBody: [
                '# Spider Engine',
                '',
                'Clone into `/Users/<you>/workspace/devindex` and inspect `apps/devindex/view/home/MainContainer.mjs`.',
                'Reviewed by `@neo-gemini-julia` and `@neo-opus-grace`. See [Intro](./Intro.md).'
            ].join('\n')
        });

        expect(lintPublicDocs({root}).entryCount).toBe(2)
    });

    test('rejects real Unix/macOS and Windows host filesystem paths including file:// URLs', () => {
        const unixRoot = createFixture({
            guideBody: '# Leak\n\nLoaded from `/Users/alice/.neo-ai/devindex/learn/Intro.md`.\n'
        });
        expect(() => lintPublicDocs({root: unixRoot})).toThrow(/forbidden host filesystem path "\/Users\/alice\//);

        const fileUrlRoot = createFixture({
            guideBody: '# Leak\n\nScreenshot at `file:///Users/alice/x/shot.png`.\n'
        });
        expect(() => lintPublicDocs({root: fileUrlRoot})).toThrow(/forbidden host filesystem path "\/Users\/alice\/x\/shot\.png"/);

        const winRoot = createFixture({
            guideBody: '# Leak\n\nLoaded from `C:\\Users\\alice\\devindex\\learn\\Intro.md`.\n'
        });
        expect(() => lintPublicDocs({root: winRoot})).toThrow(/forbidden Windows host filesystem path/);

        const winFileUrlRoot = createFixture({
            guideBody: '# Leak\n\nScreenshot at `file:///C:/Users/alice/x/shot.png`.\n'
        });
        expect(() => lintPublicDocs({root: winFileUrlRoot})).toThrow(/forbidden Windows host filesystem path/)
    });

    test('rejects private repository references across business, neo-stage, and neo-pro', () => {
        for (const repo of ['neomjs/business', 'neomjs/neo-stage', 'neomjs/neo-pro']) {
            const root = createFixture({
                guideBody: `# Leak\n\nSee ${repo}#42 for internal notes.\n`
            });
            expect(() => lintPublicDocs({root})).toThrow(/forbidden private-repository reference/)
        }
    });

    test('rejects manifest/tree drift, treeMount.id drift, and non-matching pre-split routes', () => {
        expect(() => lintPublicDocs({root: createFixture({extraTreeLeaf: true})}))
            .toThrow(/leaf "learn\/data-factory\/Extra\.md" is missing/);

        expect(() => lintPublicDocs({root: createFixture({extraManifestEntry: true})}))
            .toThrow(/"learn\/data-factory\/Unlisted\.md" is not a leaf/);

        expect(() => lintPublicDocs({root: createFixture({mountIdOverride: 'guides/other'})}))
            .toThrow(/invalid route/);

        expect(() => lintPublicDocs({root: createFixture({routeOverride: '/learn/devindex/data-factory/Engine'})}))
            .toThrow(/invalid route/);

        expect(() => lintPublicDocs({root: createFixture({routeOverride: '/learn/guides/devindex/WrongSlug'})}))
            .toThrow(/does not match pre-split tree route/)
    });

    test('rejects broken or unpublished relative Markdown links in prose while ignoring fenced and inline code', () => {
        const fencedRoot = createFixture({
            guideBody: '# Spider Engine\n\n```markdown\n[Example](./DoesNotExist.md)\n```\nInline `[Example](./DoesNotExist.md)` stays inert.\n'
        });
        expect(stripFencedCodeBlocks('a\n```js\nb\n```\nc')).toBe('a\n\n\n\nc');
        expect(lintPublicDocs({root: fencedRoot}).entryCount).toBe(2);

        const brokenRoot = createFixture({
            guideBody: '# Spider Engine\n\nSee [Missing](./DoesNotExist.md#top) for details.\n'
        });
        expect(() => lintPublicDocs({root: brokenRoot})).toThrow(/broken relative Markdown link "\.\/DoesNotExist\.md"/);

        const unlistedTargetRoot = createFixture({
            unlistedDiskFile: true,
            guideBody       : '# Spider Engine\n\nSee [Internal](./Internal.md) notes.\n'
        });
        expect(() => lintPublicDocs({root: unlistedTargetRoot})).toThrow(/broken relative Markdown link "\.\/Internal\.md"/)
    })
});
