import { test, expect }         from '@playwright/test';
import { measureJankInBrowser } from '../utils/browser-test-helpers.mjs';

/**
 * @summary Witness that the data stream stops. **It does not benchmark, and it does not scroll.**
 *
 * Measured on the current tree, not inferred — this file is vacuous in two independent ways, and
 * both predate the move to this repository (the same code and the same condition are on the engine's
 * `dev`):
 *
 * 1. **The scroll never happens.** The horizontal case reads `maxScroll` off `.neo-grid-container`,
 *    but that element is not the scroll container — the grid drives horizontal movement through its
 *    own scroll manager and a custom scrollbar, so `scrollWidth - clientWidth` is `0` and the body
 *    returns `{skipped: true, reason: 'Not scrollable'}` before touching anything. Verified at every
 *    viewport, Mobile through Desktop.
 * 2. **The measurement is commented out.** `measureJankInBrowser` is injected into the page and never
 *    invoked; the callback returns a literal instead.
 *
 * The result was previously published as a `benchmark-native-horizontal` annotation. A skip constant
 * carried under a benchmark type is worse than no benchmark: it reads as a datum in the report and
 * cannot move, so nothing about it can ever fail.
 *
 * Left dormant rather than repaired here. Re-pointing the scroll target and re-enabling the
 * instrument is a behaviour change, and shipping one inside a repository migration would hide it
 * under a move. The `beforeEach` stream-stop assertions are real and still run, which is what this
 * file honestly is today.
 */

const viewports = [
    { name: 'Mobile',  width: 375,  height: 667 },
    { name: 'Laptop',  width: 1366, height: 768 },
    { name: 'Desktop', width: 1920, height: 1080 }
];

viewports.forEach(({ name, width, height }) => {
    test.describe(`${name} (${width}x${height}): DevIndex Native Scroll Benchmarks`, () => {

        test.use({ viewport: { width, height } });

        test.beforeEach(async ({ page }) => {
            // Inject helpers
            await page.addInitScript({
                content: `
                    window.measureJankInBrowser = ${measureJankInBrowser.toString()};
                `
            });

            await page.goto('/apps/devindex/');

            // 1. Wait for the grid to be visible
            await page.waitForSelector('[role="grid"]', { state: 'visible', timeout: 30000 });

            // 2. Wait for the streaming to start (Stop button visible)
            const stopButton = page.locator('.devindex-stop-stream-button');
            await expect(stopButton).toBeVisible({ timeout: 5000 });

            console.log(`[${name}] Streaming started...`);

            // 3. Wait for the streaming to finish (Stop button hidden)
            await expect(stopButton).toBeHidden({ timeout: 60000 });

            console.log(`[${name}] Streaming finished.`);

            // 4. Wait for the UI to settle (buffer time)
            await page.waitForTimeout(1000);

            // 5. CRITICAL: Disconnect Neo's Mutation Observer to remove test artifact overhead
            await page.evaluate(() => {
                if (Neo.main.DomAccess.documentMutationObserver) {
                    Neo.main.DomAccess.documentMutationObserver.disconnect();
                    console.log('Neo.main.DomAccess.documentMutationObserver disconnected for benchmark.');
                } else {
                    console.warn('Neo.main.DomAccess.documentMutationObserver was not found.');
                }
            });
        });

        test('Horizontal Scroll (Native Smooth)', async ({ page }) => {
            const scrollResult = await page.evaluate(async () => {
                // Horizontal scroll is on the neo-grid-container
                const scrollable = document.querySelector('.neo-grid-container');
                if (!scrollable) throw new Error('Horizontal scroll container not found');

                const maxScroll = scrollable.scrollWidth - scrollable.clientWidth;
                if (maxScroll <= 0) return { skipped: true, reason: 'Not scrollable' };

                const performScroll = async () => {
                    // Trigger native smooth scroll
                    scrollable.scrollTo({
                        left    : maxScroll,
                        behavior: 'smooth'
                    });

                    // Wait for the scroll to complete.
                    // Since 'scrollend' event support is spotty in some environments or might be flaky in tests,
                    // we use a simple polling or fixed timeout.
                    // A full width scroll takes time, let's give it 2.5s matching measurement window.
                    await new Promise(r => setTimeout(r, 2500));

                    // Verify scroll actually happened
                    if (scrollable.scrollLeft < 100) {
                        throw new Error(`Scroll failed! Expected scrollLeft > 100, got ${scrollable.scrollLeft}`);
                    }

                    // Scroll back
                    scrollable.scrollTo({
                        left    : 0,
                        behavior: 'smooth'
                    });

                    await new Promise(r => setTimeout(r, 2500));
                };

                // Measure over 5 seconds (2.5s out, 2.5s back)
                // const measurementPromise = window.measureJankInBrowser(5000);
                await performScroll();
                return { success: true }; // await measurementPromise;
            });

            console.log(`[${name}] Native Horizontal (completion only, no timing):`, scrollResult);

            // Annotated as `witness`, not `benchmark`. `scrollResult` is the constant `{success: true}`
            // while the jank measurement above is dormant, and a constant published under a benchmark
            // type reads as a datum in the report while being incapable of moving.
            test.info().annotations.push({
                type       : 'witness-native-horizontal-scroll-completed',
                description: JSON.stringify({ viewport: name, ...scrollResult })
            });
        });
    });
});
