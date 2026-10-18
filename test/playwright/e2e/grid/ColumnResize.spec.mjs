import {test, expect} from '@playwright/test';

/**
 * @summary A column resize must move the body cells with the header, during the drag and on drop.
 *
 * On `neo.mjs@13.1.0` the header followed the gesture and the body cells never did: a pure width
 * change left the mounted column range unchanged, so no config notified and every cell kept the
 * geometry its header had just replaced. The engine's `refreshColumns` and `isMeasuredWidth` fixed
 * that after the 13.1.0 cut, so this app only receives the fix through its `neo.mjs` dependency —
 * which is why the regression arm lives here, where a dependency bump that loses it would show.
 *
 * The scroll arm covers the second half of that release: component-backed cells (`User`, `Impact`,
 * `Top Repo`, `Location`) must render the record of the row they sit in after a scroll, not the
 * record their component first mounted with.
 */
test.describe('Desktop (1920x1080): DevIndex grid column resize', () => {
    test.use({viewport: {width: 1920, height: 1080}});

    // The `rank` column: a plain, non-component column of 60px, the column the original report measured.
    const COLUMN = '2',
          DRAG   = 150;

    test.beforeEach(async ({page}) => {
        await page.goto('/apps/devindex/');
        await page.waitForSelector('[role="grid"]', {state: 'visible', timeout: 30000});

        const stopButton = page.locator('.devindex-stop-stream-button');
        await expect(stopButton).toBeVisible({timeout: 5000});
        await expect(stopButton).toBeHidden({timeout: 60000})
    });

    /**
     * @summary Reads the header width, and the first row's resized cell and its right-hand neighbour.
     * @param {import('@playwright/test').Page} page
     * @returns {Promise<{header: Number, cell: Number, cellLeft: Number, nextLeft: Number}>}
     */
    const measure = page => page.evaluate(column => {
        const header = document.querySelector(`.neo-grid-header-button[aria-colindex="${column}"]`),
              row    = document.querySelector('.neo-grid-row'),
              cell   = row.querySelector(`.neo-grid-cell[aria-colindex="${column}"]`),
              // The next RENDERED cell: a column the app hides at this width renders `display: none`.
              next   = [...row.querySelectorAll('.neo-grid-cell[aria-colindex]')]
                  .find(el => Number(el.getAttribute('aria-colindex')) > Number(column) && el.offsetParent !== null);

        return {
            header  : header.getBoundingClientRect().width,
            cell    : parseFloat(cell.style.width),
            cellLeft: parseFloat(cell.style.left),
            nextLeft: parseFloat(next.style.left)
        }
    }, COLUMN);

    test('the body cells follow a header resize during the drag and on drop', async ({page}) => {
        const before = await measure(page),
              button = page.locator(`.neo-grid-header-button[aria-colindex="${COLUMN}"]`),
              box    = await button.boundingBox(),
              startX = box.x + box.width - 2,
              startY = box.y + box.height / 2;

        expect(before.cell).toBe(before.header);

        // The resize handle is injected on hover. A press without it arms nothing and reorders the
        // column instead, so the gesture starts only once the handle exists.
        await page.mouse.move(startX, startY);
        await expect(page.locator('.neo-resizable').first()).toBeAttached({timeout: 5000});

        await page.mouse.down();
        await page.mouse.move(startX + DRAG, startY, {steps: 15});

        // Mid-drag: the header has taken the new width, and the cells must have taken it with it.
        await expect.poll(async () => (await measure(page)).header, {timeout: 5000})
            .toBeGreaterThan(before.header + DRAG - 10);

        const during = await measure(page);

        expect(during.cell, 'a cell keeps its old width mid-drag').toBeCloseTo(during.header, 0);

        await page.mouse.up();

        await expect.poll(async () => {
            const {header, cell} = await measure(page);
            return Math.abs(header - cell)
        }, {timeout: 5000}).toBeLessThan(1);

        const after = await measure(page);

        expect(after.cell, 'the drop does not keep the new width').toBeGreaterThan(before.cell + DRAG - 10);
        // The following columns settle against the new width: they shift by exactly the width the
        // resized column gained. Measured as a shift, because a component column between the two can
        // render `display: none` in this row while still taking its width.
        expect(after.nextLeft - before.nextLeft).toBeCloseTo(after.cell - before.cell, 0)
    });

    test('component cells show the record of their row after a scroll', async ({page}) => {
        /**
         * @summary Reads each visible row's record id with the text of its `User` component cell.
         * @returns {Promise<Array<{record: String, user: String}>>}
         */
        const rows = () => page.evaluate(() => [...document.querySelectorAll('.neo-grid-row')]
            .map(row => ({
                record: row.querySelector('[data-record-id]')?.dataset.recordId,
                // `login` is the `githubUser` column: a component-backed cell
                user  : row.querySelector('.neo-grid-cell[data-field="login"]')?.textContent.trim()
            }))
            .filter(row => row.record && row.user));

        const top = await rows();

        expect(top.length, 'no rendered User cells to compare').toBeGreaterThan(5);

        const body = page.locator('.neo-grid-view').last();

        await body.hover();
        await page.mouse.wheel(0, 4000);

        // Wait until the rendered rows show records that were not on screen before the scroll.
        await expect.poll(async () => {
            const topRecords = new Set(top.map(row => row.record));
            return (await rows()).filter(row => !topRecords.has(row.record)).length
        }, {timeout: 10000}).toBeGreaterThan(5);

        const topUsers = new Set(top.map(row => row.user)),
              scrolled = (await rows()).filter(row => !top.some(previous => previous.record === row.record));

        // A cell that kept the record its component first mounted with repeats a name from before the
        // scroll on a row that now holds a different record.
        expect(scrolled.filter(row => topUsers.has(row.user)), 'component cells kept their first record').toEqual([])
    })
});
