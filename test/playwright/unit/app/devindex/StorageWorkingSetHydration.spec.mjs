import {setup} from '../../../setup.mjs';

const appName = 'DevIndexStorageWorkingSetHydrationTest';

setup({
    appConfig: {
        name: appName
    }
});

import {test, expect} from '@playwright/test';
import Neo            from '../../../../../node_modules/neo.mjs/src/Neo.mjs';
import * as core      from '../../../../../node_modules/neo.mjs/src/core/_export.mjs';
import config         from '../../../../../apps/devindex/services/config.mjs';
import Storage        from '../../../../../apps/devindex/services/Storage.mjs';

/**
 * @summary The read side: fetching the published working set, verifying it, and adopting it as one unit.
 *
 * This is the path that decides what the pipeline believes its previous state was. It runs before any
 * collection stage, it overwrites nine local files, and until now nothing tested it.
 *
 * The engine repository still carries `StoragePublishedIndex.spec.mjs`, which pins the SUPERSEDED
 * single-file `publishedIndex` contract — `config.publishedIndex` and `config.paths.indexProvenance`
 * do not exist here. So this is not that spec ported: the properties are its properties, re-derived
 * against the shape that actually runs, where one file became nine and provenance moved into a
 * fetched manifest.
 *
 * ## Why the all-or-nothing property is the one that matters
 *
 * `workingSetMembers()` includes `blocklist`, and `Storage`'s own docblock says why: a user opts out,
 * `addToBlocklist` records it, and if that file is not carried with the set the decision does not
 * survive the run — while the closing comment has already told them they were removed. A half-adopted
 * set is therefore not a stale cache, it is a privacy failure, and `fetchAndAdoptWorkingSet` defends
 * against it by writing nothing until every member has been fetched and verified.
 *
 * That defence is invisible to a test that only checks the happy path, which is what makes it worth
 * pinning: it holds today, it is one early `writeAtomic` away from not holding, and the symptom would
 * be silent.
 */
test.describe('DevIndex Storage — hydrating the published working set', () => {
    // Serial by necessity, not preference. Every case here swaps members on the `Storage` SINGLETON —
    // `globalThis.fetch`, `writeAtomic`, the memoized `hydration` — and the unit config runs
    // `fullyParallel: true`. Under parallel execution one case's `afterEach` restores the real
    // `writeAtomic` while another is still mid-hydration, and the real writer then fires against a
    // gitignored data directory: `ENOENT ... optout-sync.json.tmp`. Observed, not hypothetical — it is
    // what the first run of this file did, and it surfaced in a SYNCHRONOUS case that touches no
    // filesystem at all, which is what makes the cause easy to misread as flake.
    test.describe.configure({mode: 'serial'});

    const MANIFEST_FILE = config.paths.workingSetManifest.slice(config.paths.workingSetManifest.lastIndexOf('/') + 1),

          // Captured at collection time, which is the only moment this file has not already shadowed
          // the singleton — `beforeEach` installs the stub before any test body runs, so a reading
          // taken inside a test would compare the stub against itself and pass regardless.
          PRISTINE_HAS_OWN = Object.hasOwn(Storage, 'writeAtomic'),
          PRISTINE_METHOD  = Storage.writeAtomic;

    let originalFetch, writeAtomicDescriptor, writes;

    test.beforeEach(() => {
        originalFetch = globalThis.fetch;
        writes        = [];

        // The DESCRIPTOR, not the function. `writeAtomic` is inherited from the prototype, so
        // `Storage.writeAtomic.bind(Storage)` followed by an assignment back does not restore
        // anything — it converts an inherited method into an OWN property holding a bound copy with
        // a different identity, and leaves that on the singleton for every later spec in the process.
        // Capturing the descriptor lets teardown put the object back in the state it was found.
        writeAtomicDescriptor = Object.getOwnPropertyDescriptor(Storage, 'writeAtomic') ?? null;

        // Adoption is observed rather than performed: the property under test is WHICH writes happen
        // and whether any happen at all, not what lands on disk. `StorageWriteDirectory.spec.mjs`
        // already owns the real write.
        Storage.writeAtomic = async (localPath, text) => {
            writes.push({localPath, text})
        };

        // `hydrateWorkingSet()` memoizes into `this.hydration`, so a residue from a previous case
        // would make every later case assert against the first case's network.
        delete Storage.hydration
    });

    test.afterEach(() => {
        globalThis.fetch = originalFetch;

        if (writeAtomicDescriptor) {
            Object.defineProperty(Storage, 'writeAtomic', writeAtomicDescriptor)
        } else {
            // There was no own property before, so removing this file's shadow is what restores the
            // inherited method — with its original identity, not an equivalent copy.
            delete Storage.writeAtomic
        }

        delete Storage.hydration
    });

    /**
     * Serves the network per URL. Returns the recorded requests so a case can assert the CALL —
     * which URLs were built and in what shape — rather than only the outcome.
     *
     * @param {Object}   options
     * @param {Object}   [options.manifest]  body for the manifest request; `null` serves a 404
     * @param {Function} [options.member]    `({file}) => ({ok, status, text})` for each member
     * @returns {Object[]} recorded `{url}` entries
     */
    const stubNetwork = ({manifest = null, member = () => ({ok: true, status: 200, text: 'x'})} = {}) => {
        const calls = [];

        globalThis.fetch = async (url, init) => {
            calls.push({url, init});

            const file = url.slice(url.lastIndexOf('/') + 1);

            if (file === MANIFEST_FILE) {
                return manifest === null
                    ? {ok: false, status: 404, text: async () => ''}
                    : {ok: true, status: 200, text: async () => JSON.stringify(manifest)};
            }

            const {ok = true, status = 200, text = 'x', throws} = member({file});

            if (throws) throw new Error(throws);

            return {ok, status, text: async () => text}
        };

        return calls
    };

    test('every member is fetched from the single declared base URL, never a reassembled one', async () => {
        const calls = stubNetwork();

        await Storage.hydrateWorkingSet();

        const {baseUrl} = config.publishedWorkingSet,
              memberCalls = calls.filter(({url}) => !url.endsWith(MANIFEST_FILE));

        expect(memberCalls.length, 'one request per working-set member').toBe(Storage.workingSetMembers().length);

        memberCalls.forEach(({url}) => {
            expect(url.startsWith(baseUrl), `built from the declared base URL: ${url}`).toBe(true);
            // A reassembled host is the failure this guards: the base is declared once, and every
            // member URL must be that literal plus a basename, with nothing between them.
            expect(url.slice(baseUrl.length).includes('/'), `no path segment injected: ${url}`).toBe(false)
        })
    });

    test('the blocklist travels with the set — an opt-out that is not carried does not survive the run', () => {
        const keys = Storage.workingSetMembers().map(({key}) => key);

        // Named individually rather than by count: the regression this guards is a member being
        // dropped because it is small, and a count assertion passes as long as SOMETHING replaces it.
        ['blocklist', 'optoutSync', 'optinSync', 'allowlist', 'users', 'tracker', 'visited', 'threshold', 'failed']
            .forEach(key => expect(keys, `${key} is part of the working set`).toContain(key))
    });

    test('a non-2xx on any member adopts NOTHING — not even the members already fetched', async () => {
        stubNetwork({member: ({file}) => file.startsWith('visited') ? {ok: false, status: 503} : {text: 'ok'}});

        await Storage.hydrateWorkingSet();

        expect(writes, 'a rejected set leaves every local file untouched').toEqual([])
    });

    test('a member that throws adopts NOTHING, and the failure names the file', async () => {
        const warnings = [];
        const originalWarn = console.warn, originalError = console.error;

        console.warn = (...args) => warnings.push(args.join(' '));
        console.error = (...args) => warnings.push(args.join(' '));

        try {
            stubNetwork({member: ({file}) => file.startsWith('tracker') ? {throws: 'ECONNRESET'} : {text: 'ok'}});

            await Storage.hydrateWorkingSet();

            expect(writes, 'a transport failure leaves every local file untouched').toEqual([]);
            expect(warnings.join('\n'), 'the retreat is audible and names the file')
                .toContain('tracker')
        } finally {
            console.warn = originalWarn;
            console.error = originalError
        }
    });

    test('a digest mismatch adopts NOTHING, even though every fetch succeeded', async () => {
        const members = Storage.workingSetMembers(),
              digests = {};

        // Every member matches except one, so the ONLY thing failing the set is the comparison —
        // not a transport error, not a missing file.
        members.forEach(({key}) => {digests[key] = Storage.digestOf('ok')});
        digests[members[0].key] = 'deadbeefdeadbeefdeadbeef';

        stubNetwork({manifest: {digests}, member: () => ({text: 'ok'})});

        await Storage.hydrateWorkingSet();

        expect(writes, 'a set that fails verification is not adopted in part').toEqual([])
    });

    test('a manifest whose digests all match IS adopted, so the mismatch case above is not vacuous', async () => {
        const digests = {};

        Storage.workingSetMembers().forEach(({key}) => {digests[key] = Storage.digestOf('ok')});

        stubNetwork({manifest: {digests}, member: () => ({text: 'ok'})});

        await Storage.hydrateWorkingSet();

        expect(writes.length, 'a verified set adopts every member').toBe(Storage.workingSetMembers().length)
    });

    test('absence of a manifest is not mismatch — the set is adopted, and the warning says it is unverified', async () => {
        const warnings = [];
        const originalWarn = console.warn;

        console.warn = (...args) => warnings.push(args.join(' '));

        try {
            stubNetwork({manifest: null, member: () => ({text: 'ok'})});

            await Storage.hydrateWorkingSet();

            expect(writes.length, 'a deployment with nothing published still hydrates')
                .toBe(Storage.workingSetMembers().length);
            expect(warnings.join('\n'), 'and it says so, loudly, rather than adopting silently')
                .toContain('UNVERIFIED')
        } finally {
            console.warn = originalWarn
        }
    });

    test('this file leaves the Storage singleton exactly as it found it', async () => {
        // The isolation itself, asserted rather than assumed. Every case here shadows a method on a
        // module singleton, and the failure mode is silent: a teardown that assigns an equivalent
        // function back still leaves an OWN property where an inherited one was, which the next spec
        // in the process inherits. This case runs the full teardown path and checks the object, not
        // the behaviour — equivalent call behaviour is exactly what hid the problem.
        stubNetwork();
        await Storage.hydrateWorkingSet();

        // Mirror exactly what afterEach does, so the assertion covers the real restore path rather
        // than a re-implementation of it.
        writeAtomicDescriptor
            ? Object.defineProperty(Storage, 'writeAtomic', writeAtomicDescriptor)
            : delete Storage.writeAtomic;

        expect(Object.hasOwn(Storage, 'writeAtomic'), 'ownership is restored, not merely re-assigned')
            .toBe(PRISTINE_HAS_OWN);
        expect(Storage.writeAtomic, 'the ORIGINAL method identity is restored, not an equivalent copy')
            .toBe(PRISTINE_METHOD)
    });

    test('hydration runs once per process, however many callers ask for it', async () => {
        const calls = stubNetwork();

        await Promise.all([
            Storage.hydrateWorkingSet(),
            Storage.hydrateWorkingSet(),
            Storage.hydrateWorkingSet()
        ]);

        const expected = Storage.workingSetMembers().length + 1; // members + the manifest

        expect(calls.length, 'three callers, one network pass').toBe(expected)
    });
});
