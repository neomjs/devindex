import {test, expect}  from '@playwright/test';
import fs              from 'fs';
import path            from 'path';
import {fileURLToPath} from 'url';
import {load}          from 'js-yaml';

const
    REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'),
    workflow  = file => load(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', file), 'utf-8')),
    PAGES     = workflow('pages.yml'),
    SYNC      = workflow('data-sync-pipeline.yml'),
    runsNpm   = job => job.steps.some(({run}) => /\bnpm\b/.test(run || ''));

/**
 * The site serves what the store last published: the Pages workflow reads the store in a job that runs no dependency
 * code, and every publish dispatches that workflow. These arms read the workflows themselves, since the property is
 * their shape.
 */
test.describe('Pages deploy — the store read and the publish dispatch', () => {
    test('no job that runs npm can mint a store token', () => {
        Object.entries(PAGES.jobs).forEach(([name, job]) => {
            if (runsNpm(job)) {
                expect(job.permissions?.['id-token'], `${name} runs npm`).toBeUndefined()
            }
        });

        expect(PAGES.jobs.data.permissions['id-token']).toBe('write');
        expect(runsNpm(PAGES.jobs.data), 'the token job runs no dependency code').toBe(false)
    });

    test('the build takes the verified index from the data job, and nothing pulls the public copy', () => {
        const {build, data} = PAGES.jobs,
              upload        = data.steps.find(({uses}) => uses?.startsWith('actions/upload-artifact@')),
              download      = build.steps.find(({uses}) => uses?.startsWith('actions/download-artifact@'));

        expect(build.needs).toBe('data');
        expect(download.with).toEqual({name: upload.with.name, path: 'apps/devindex/resources/data'});
        expect(data.steps.find(({id}) => id === 'fetch').run).toContain('buildScripts/fetchStoreIndex.mjs');
        expect(Object.values(PAGES.jobs).flatMap(({steps}) => steps).some(({run}) => /pull-data/.test(run || ''))).toBe(false)
    });

    test('every publish dispatches the Pages workflow, under the same condition, with the right to', () => {
        const {collect} = SYNC.jobs,
              names     = collect.steps.map(({name}) => name),
              publish   = collect.steps[names.indexOf('Publish the working set')],
              redeploy  = collect.steps[names.indexOf('Publish the working set') + 1];

        expect(collect.permissions.actions).toBe('write');
        expect(redeploy.name).toBe('Redeploy the site');
        expect(redeploy.if).toBe(publish.if);
        expect(redeploy.run).toMatch(/gh workflow run pages\.yml .*--ref dev/)
    })
});
