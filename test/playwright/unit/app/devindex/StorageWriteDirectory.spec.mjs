import {setup} from '../../../setup.mjs';

const appName = 'DevIndexStorageWriteDirectoryTest';

setup({
    appConfig: {
        name: appName
    }
});

import {test, expect} from '@playwright/test';
import fs             from 'fs/promises';
import os             from 'os';
import path           from 'path';
import Neo            from '../../../../../node_modules/neo.mjs/src/Neo.mjs';
import * as core      from '../../../../../node_modules/neo.mjs/src/core/_export.mjs';
import config         from '../../../../../apps/devindex/services/config.mjs';
import Storage        from '../../../../../apps/devindex/services/Storage.mjs';

/**
 * @summary A write must survive the data directory not existing at all.
 *
 * This is a regression corpus for a shipped production failure, not a hypothetical. Every file under
 * `apps/devindex/resources/data/` is gitignored, and git cannot express an empty directory — so a
 * fresh checkout has no such directory, and the very first scheduled run died in `ensureFiles` with
 * `ENOENT` on `users.jsonl.tmp` before a single collection stage executed (run 32276538403).
 *
 * The tests write into a scratch directory that is deliberately absent, because that is the only
 * state that discriminates: a developer machine always has the directory (`devindex:pull-data`
 * creates it), and the run that "verified" this path two hours before the failure used a tree where
 * seven still-tracked files were holding the directory open. Both are green against the defect.
 */
test.describe('DevIndex Storage writes into a directory that does not exist yet', () => {
    let scratchRoot;

    test.beforeEach(async () => {
        // `mkdtemp` gives a root that EXISTS; every target below sits one or two levels beneath it,
        // so the missing segment is the thing under test rather than the whole tree.
        scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'devindex-storage-'))
    });

    test.afterEach(async () => {
        await fs.rm(scratchRoot, {recursive: true, force: true})
    });

    test('writeAtomic creates the missing parent directory', async () => {
        const target = path.join(scratchRoot, 'resources', 'data', 'users.jsonl');

        await Storage.writeAtomic(target, '{"l":"someone"}');

        expect(await fs.readFile(target, 'utf-8')).toBe('{"l":"someone"}')
    });

    test('writeJson reaches disk through the same guarantee', async () => {
        // The production call chain that actually failed: `ensureFiles` -> `writeJson` -> the write.
        // The target is outside `config.paths` on purpose, so no working-set manifest is re-stamped.
        const target = path.join(scratchRoot, 'nested', 'threshold.json');

        await Storage.writeJson(target, {tc: 1234});

        expect(JSON.parse(await fs.readFile(target, 'utf-8'))).toEqual({tc: 1234})
    });

    test('a completed write leaves no temp file behind', async () => {
        const target = path.join(scratchRoot, 'nested', 'tracker.json');

        await Storage.writeJson(target, {});

        await expect(fs.access(`${target}.tmp`)).rejects.toThrow()
    })
});

/**
 * @summary The empty file `ensureFiles` creates must not read as a usable index.
 *
 * These two cases are the reason the directory fix could not ship alone. `ensureFiles` writes
 * `users.jsonl` as a zero-byte file at construction; `readJson` answers an empty JSONL with `[]`;
 * and `[]` is truthy. Repairing the `ENOENT` therefore converted a loud crash into the silent
 * truncation the fail-closed guard exists to prevent — a run enriching 200 users would publish an
 * index of 200 and drop 49,800 contributors with every log line green.
 */
test.describe('DevIndex Storage refuses an empty index when hydration failed', () => {
    let originalHydrate, originalUsersPath, scratchRoot;

    test.beforeEach(async () => {
        scratchRoot       = await fs.mkdtemp(path.join(os.tmpdir(), 'devindex-empty-'));
        originalHydrate   = Storage.hydrateWorkingSet;
        originalUsersPath = config.paths.users;

        // Hydration that fetched nothing is the state under test — a rejected working set leaves the
        // local copy exactly as `ensureFiles` left it, which is the empty file.
        Storage.hydrateWorkingSet = async () => {};
        config.paths.users        = path.join(scratchRoot, 'users.jsonl')
    });

    test.afterEach(async () => {
        Storage.hydrateWorkingSet = originalHydrate;
        config.paths.users        = originalUsersPath;
        delete process.env.DEVINDEX_ALLOW_EMPTY_INDEX;
        await fs.rm(scratchRoot, {recursive: true, force: true})
    });

    test('throws rather than returning the empty file ensureFiles created', async () => {
        // Written with plain `fs` rather than `writeJson`: an empty JSONL is byte-for-byte what
        // `ensureFiles` leaves behind, and going through `writeJson` would additionally re-stamp the
        // repository's real working-set manifest from every parallel worker at once.
        await fs.writeFile(config.paths.users, '', 'utf-8');

        expect((await fs.readFile(config.paths.users, 'utf-8')).length).toBe(0);
        await expect(Storage.getUsers()).rejects.toThrow(/no prior index/)
    });

    test('DEVINDEX_ALLOW_EMPTY_INDEX is still the door for a first-ever run', async () => {
        // Written with plain `fs` rather than `writeJson`: an empty JSONL is byte-for-byte what
        // `ensureFiles` leaves behind, and going through `writeJson` would additionally re-stamp the
        // repository's real working-set manifest from every parallel worker at once.
        await fs.writeFile(config.paths.users, '', 'utf-8');
        process.env.DEVINDEX_ALLOW_EMPTY_INDEX = '1';

        expect(await Storage.getUsers()).toEqual([])
    })
});
