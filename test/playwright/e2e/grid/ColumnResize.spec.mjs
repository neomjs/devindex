import {test, expect}  from '@playwright/test';
import {readFileSync}  from 'node:fs';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Logins in the order the app ranks them: the data file is sorted, so rank N is line N. Read here,
 * outside the grid, so the expected record of a row never comes from the component under test.
 * @type {String[]}
 */
const LOGIN_BY_RANK = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../apps/devindex/resources/data/users.jsonl'), 'utf-8'
).trim().split('\n').map(line => JSON.parse(line).l);

/**
 * @summary The rows whose `User` cell does not link the login their plain `rank` cell names, a blank
 * cell included.
 * @param {Array<{rank: String, user: String|null}>} rows
 * @param {String[]} loginByRank Logins in rank order: rank N is index N - 1.
 * @returns {Array<{rank: String, user: String|null, expected: String|undefined}>}
 */
function misboundUserCells(rows, loginByRank) {
    return rows
        .map(row => ({...row, expected: loginByRank[Number(row.rank) - 1]}))
        .filter(row => !row.user || row.user !== row.expected)
}

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
         * @summary Reads every row inside the body's visible box: its plain `rank` cell, and the login
         * its `User` component cell links to (`null` when the cell renders none). Rows are not filtered
         * on the User cell, because a blank one must count as a failure, not vanish from the sample.
         * @returns {Promise<Array<{rank: String, user: String|null}>>}
         */
        const rows = () => page.evaluate(() => {
            const view = [...document.querySelectorAll('.neo-grid-view')].at(-1).getBoundingClientRect();

            return [...document.querySelectorAll('.neo-grid-row')]
                .filter(row => {
                    const box = row.getBoundingClientRect();
                    return box.height > 0 && box.top >= view.top && box.bottom <= view.bottom
                })
                .map(row => ({
                    rank: row.querySelector('.neo-grid-cell[data-field="rank"]')?.textContent.trim(),
                    // `login` is the `githubUser` column: a component-backed cell
                    user: row.querySelector('.neo-grid-cell[data-field="login"] .neo-username')?.textContent.trim() || null
                }))
                .filter(row => row.rank)
        });

        const top    = await rows(),
              topMax = Math.max(...top.map(row => Number(row.rank)));

        expect(misboundUserCells(top, LOGIN_BY_RANK), 'the top rows already disagree with the data').toEqual([]);

        await page.locator('.neo-grid-view').last().hover();
        await page.mouse.wheel(0, 4000);

        // Wait until the plain cells show ranks below the first screen: the rows really moved.
        await expect.poll(async () => (await rows()).filter(row => Number(row.rank) > topMax).length, {timeout: 10000})
            .toBeGreaterThan(5);

        const scrolled = (await rows()).filter(row => Number(row.rank) > topMax);

        expect(misboundUserCells(scrolled, LOGIN_BY_RANK), 'component cells show another row\'s record').toEqual([])
    })
});

/**
 * The scroll arm's oracle on fixed rows, so the arm cannot pass by accepting the wrong thing: a
 * correct binding passes, and both a swapped binding and a blank cell fail.
 */
test.describe('DevIndex User-cell oracle', () => {
    const logins = ['ada', 'grace', 'euclid', 'emmy'],
          rows   = [{rank: '2', user: 'grace'}, {rank: '3', user: 'euclid'}, {rank: '4', user: 'emmy'}];

    test('a correct binding passes', () => {
        expect(misboundUserCells(rows, logins)).toEqual([])
    });

    test('a swapped binding fails on both rows', () => {
        const swapped = [{rank: '2', user: 'euclid'}, {rank: '3', user: 'grace'}, rows[2]];

        expect(misboundUserCells(swapped, logins).map(row => row.rank)).toEqual(['2', '3'])
    });

    test('a blank User cell fails instead of leaving the sample', () => {
        const blank = [rows[0], {rank: '3', user: null}, rows[2]];

        expect(misboundUserCells(blank, logins)).toEqual([{rank: '3', user: null, expected: 'euclid'}])
    })
});
