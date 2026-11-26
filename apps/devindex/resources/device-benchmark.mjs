/**
 * @summary Opt-in (`?bench=1`) Main-thread benchmark HUD for Desktop Playwright (`60Hz` / `120Hz`) and physical iPhone Mobile Safari.
 * Measures `50k` stream load, `n=20` 2D diagonal scroll TVS (verifying both vertical row and horizontal column-window arrival),
 * sustained 60-step sweep + real `GridDragScroll` diagonal drag+fling (requiring 2D per-axis travel and tracking per-`rAF` blank frames),
 * warm-up-excluded `50k` column re-sorts (multi-row + `aria-sort` witness), and warm-up-excluded `50k` structural rank-filter toggles,
 * evaluated with Fieller's ratio `95% CI` and the exact Welch `10%` relative threshold contrast (`0.9μA − μB`).
 */

const SERIES_STORAGE_KEY        = '__devindex_bench_series_v3';
const EXPECTED_FULL_STREAM_ROWS = 50000;

const T_CRIT_95_TABLE = [
    null,
    12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.3060, 2.2622, 2.2281,
    2.2010,  2.1788, 2.1604, 2.1448, 2.1314, 2.1199, 2.1098, 2.1009, 2.0930, 2.0860,
    2.0796,  2.0739, 2.0687, 2.0639, 2.0595, 2.0555, 2.0518, 2.0484, 2.0452, 2.0423
];

/**
 * Two-sided 95% Student-t critical value (`t_{0.975, df}`) supporting fractional Welch–Satterthwaite `df`.
 * Uses exact tabulated quantiles for integer `df = 1..30` with `1/df` harmonic interpolation on fractional `df`,
 * and the 3-term Cornish–Fisher normal-quantile expansion for `df > 30` (maximum approximation error `< 1e-4`).
 */
const tCrit95 = (df) => {
    if (!Number.isFinite(df) || df <= 1) return T_CRIT_95_TABLE[1];
    if (df <= 30) {
        const lo = Math.floor(df);
        const hi = Math.ceil(df);
        if (lo === hi) return T_CRIT_95_TABLE[lo];
        const w = (1 / df - 1 / hi) / (1 / lo - 1 / hi);
        return T_CRIT_95_TABLE[hi] + w * (T_CRIT_95_TABLE[lo] - T_CRIT_95_TABLE[hi]);
    }
    const z = 1.959963984540054;
    return z +
        (z ** 3 + z) / (4 * df) +
        (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) +
        (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3);
};

const stats = (arr) => {
    const clean = (arr || []).filter(x => typeof x === 'number' && Number.isFinite(x));
    if (!clean.length) {
        return { n: 0, mean: 0, meanUnrounded: 0, sd: 0, ci95Half: 0, p50: 0, p95: 0, p99: 0, max: 0, min: 0, raw: [] };
    }
    const sorted = [...clean].sort((a, b) => a - b);
    const n      = sorted.length;
    const mean   = clean.reduce((s, x) => s + x, 0) / n;
    const sd     = n > 1 ? Math.sqrt(clean.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
    const ci95   = n > 1 ? tCrit95(n - 1) * (sd / Math.sqrt(n)) : 0;
    const pct    = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
    const p50    = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

    return {
        n,
        mean         : +mean.toFixed(2),
        meanUnrounded: mean,
        sd           : +sd.toFixed(2),
        ci95Half     : +ci95.toFixed(2),
        p50          : +p50.toFixed(2),
        p95          : +pct(95).toFixed(2),
        p99          : +pct(99).toFixed(2),
        max          : +sorted[n - 1].toFixed(2),
        min          : +sorted[0].toFixed(2),
        raw          : clean.map(x => +Number(x).toFixed(2))
    };
};

/**
 * Evaluates `(1 - μB / μA) * 100%` using Fieller's ratio confidence interval paired with the exact
 * Welch linear threshold contrast `Δ_θ = (1 - θ)μA − μB` (`θ = 0.10` => `0.9μA − μB > 0`),
 * using Welch–Satterthwaite degrees of freedom on `(1 - θ)² vA + vB` AND enforcing the pre-registered
 * minimum qualifying sample size (`>= 10` per arm for means, `>= 20` per arm where a tail metric decides).
 */
const evaluateRelativeThreshold = (baseArr, armArr, thresholdFrac = 0.10, opts = {}) => {
    const a = (baseArr || []).filter(x => typeof x === 'number' && Number.isFinite(x));
    const b = (armArr  || []).filter(x => typeof x === 'number' && Number.isFinite(x));
    if (a.length < 2 || b.length < 2) return null;

    const nA               = a.length;
    const nB               = b.length;
    const minSamplesPerArm = opts.isTailMetric ? 20 : (opts.minSamplesPerArm ?? 10);
    const sampleCountMet   = nA >= minSamplesPerArm && nB >= minSamplesPerArm;
    const meanA            = a.reduce((s, x) => s + x, 0) / nA;
    const meanB            = b.reduce((s, x) => s + x, 0) / nB;
    if (meanA <= 0) return null;

    const varA = a.reduce((s, x) => s + (x - meanA) ** 2, 0) / (nA - 1);
    const varB = b.reduce((s, x) => s + (x - meanB) ** 2, 0) / (nB - 1);
    const vA   = varA / nA;
    const vB   = varB / nB;

    const c              = 1 - thresholdFrac;
    const contrastEst    = c * meanA - meanB;
    const vContrastA     = (c ** 2) * vA;
    const seContrast     = Math.sqrt(vContrastA + vB);
    const denomContrast  = (vContrastA ** 2) / (nA - 1) + (vB ** 2) / (nB - 1);
    const dfContrast     = denomContrast > 0 ? ((vContrastA + vB) ** 2) / denomContrast : (nA + nB - 2);
    const t              = tCrit95(dfContrast);
    const contrastLow    = contrastEst - t * seContrast;
    const contrastHi     = contrastEst + t * seContrast;
    const passesContrast = seContrast === 0 ? contrastEst > 0 : contrastLow > 0;
    const passes         = sampleCountMet && passesContrast;

    const pct = ((meanA - meanB) / meanA) * 100;
    let ciLow = null;
    let ciHi  = null;

    // Fieller's theorem for r = μB / μA: (meanB - r * meanA)^2 <= t^2 * (vB + r^2 * vA)
    const aq = (meanA ** 2) - (t ** 2) * vA;
    const cq = (meanB ** 2) - (t ** 2) * vB;
    if (aq > 0) {
        const discSq = Math.max(0, (meanA * meanB) ** 2 - aq * cq);
        const root   = Math.sqrt(discSq);
        const rLo    = (meanA * meanB - root) / aq;
        const rHi    = (meanA * meanB + root) / aq;
        ciLow        = +((1 - rHi) * 100).toFixed(2);
        ciHi         = +((1 - rLo) * 100).toFixed(2);
    }

    return {
        nA,
        nB,
        minSamplesPerArm,
        sampleCountMet,
        passesContrast,
        pct            : +pct.toFixed(2),
        ciLow,
        ciHi,
        df             : +dfContrast.toFixed(2),
        contrastEst    : +contrastEst.toFixed(2),
        contrastCiLow  : +contrastLow.toFixed(2),
        contrastCiHi   : +contrastHi.toFixed(2),
        passesThreshold: passes
    };
};

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function createLongTaskTracker() {
    const supported = typeof PerformanceObserver === 'function' &&
        Array.isArray(PerformanceObserver.supportedEntryTypes) &&
        PerformanceObserver.supportedEntryTypes.includes('longtask');

    if (!supported) {
        return {
            stop() {
                return { supported: false, count: null, maxMs: null, totalMs: null };
            }
        };
    }

    const durations = [];
    let obs         = null;
    try {
        obs = new PerformanceObserver((list) => {
            if (!obs) return;
            for (const entry of list.getEntries()) {
                if (typeof entry.duration === 'number' && Number.isFinite(entry.duration)) {
                    durations.push(entry.duration);
                }
            }
        });
        obs.observe({ type: 'longtask', buffered: false });
    } catch {
        return {
            isActive: () => false,
            stop() {
                return { supported: false, count: null, maxMs: null, totalMs: null };
            }
        };
    }

    return {
        isActive: () => Boolean(obs),
        stop() {
            const current = obs;
            obs = null;
            try { current?.disconnect(); } catch { /* ignore */ }
            return {
                supported: true,
                count    : durations.length,
                maxMs    : durations.length ? +Math.max(...durations).toFixed(2) : 0,
                totalMs  : +durations.reduce((s, d) => s + d, 0).toFixed(2)
            };
        }
    };
}

function ensureProbeInstalled() {
    const manager = globalThis.Neo?.worker?.Manager;
    if (!manager) return null;

    for (const entry of Object.values(manager.workers || {})) {
        const target = entry?.worker?.port || entry?.worker;
        if (target && !target.__devindexInboundWrapped) {
            target.addEventListener('message', (event) => {
                const state = manager.__devindexProbeState;
                if (!state) return;
                state.inboundMessages++;
                const data    = event?.data;
                const payload = data?.action === 'reply' ? data.data : data;
                const isDom   = data?.action === 'updateVdom' ||
                    (data?.action === 'reply' && Boolean(payload?.updateVdom || payload?.autoMount));
                if (isDom) {
                    state.domUpdateFlights++;
                    const deltas  = data?.action === 'updateVdom' ? data.deltas : payload?.deltas;
                    const hasMeta = Boolean((data?.action === 'updateVdom' ? data.meta : payload?.meta) &&
                        Object.keys((data?.action === 'updateVdom' ? data.meta : payload?.meta) || {}).length > 0);
                    const deltaCount = Array.isArray(deltas) ? deltas.length : 0;
                    if (deltaCount > 0 || hasMeta) {
                        state.nonEmptyDomFlights++;
                        manager.__devindexGlobalNonEmptyFlights = (manager.__devindexGlobalNonEmptyFlights || 0) + 1;
                    }
                    state.totalDeltas += deltaCount;
                }
                if (payload?.vnodes || payload?.vnode) state.vnodeRelayMessages++;
            });
            target.__devindexInboundWrapped = true;
        }
    }

    if (!manager.__devindexSendWrapped) {
        const origSend = manager.sendMessage.bind(manager);
        manager.__devindexProbeState = null;
        manager.sendMessage = function(dest, opts, transfer) {
            const state = manager.__devindexProbeState;
            if (state) {
                state.outboundMessages++;
                if (opts?.data?.vnodes || opts?.data?.vnode) {
                    state.vnodeRelayMessages++;
                }
            }
            return origSend(dest, opts, transfer);
        };
        manager.__devindexSendWrapped = true;
    }

    return manager;
}

function startWorkerProbe() {
    const manager = ensureProbeInstalled();
    if (!manager) return;
    manager.__devindexProbeState = {
        startTime         : performance.now(),
        inboundMessages   : 0,
        outboundMessages  : 0,
        domUpdateFlights  : 0,
        nonEmptyDomFlights: 0,
        totalDeltas       : 0,
        vnodeRelayMessages: 0
    };
}

function stopWorkerProbe() {
    const manager = ensureProbeInstalled();
    const state   = manager?.__devindexProbeState;
    if (manager) manager.__devindexProbeState = null;
    if (!state) {
        return {
            elapsedMs              : 0,
            inboundMessages        : 0,
            outboundMessages       : 0,
            totalMainWorkerMessages: 0,
            domUpdateFlights       : 0,
            nonEmptyDomFlights     : 0,
            flightsPerSec          : 0,
            nonEmptyFlightsPerSec  : 0,
            totalDeltas            : 0,
            vnodeRelayMessages     : 0
        };
    }
    const elapsedMs = Math.max(1, performance.now() - state.startTime);
    return {
        elapsedMs              : +elapsedMs.toFixed(2),
        inboundMessages        : state.inboundMessages,
        outboundMessages       : state.outboundMessages,
        totalMainWorkerMessages: state.inboundMessages + state.outboundMessages,
        domUpdateFlights       : state.domUpdateFlights,
        nonEmptyDomFlights     : state.nonEmptyDomFlights,
        flightsPerSec          : +(state.domUpdateFlights / (elapsedMs / 1000)).toFixed(2),
        nonEmptyFlightsPerSec  : +(state.nonEmptyDomFlights / (elapsedMs / 1000)).toFixed(2),
        totalDeltas            : state.totalDeltas,
        vnodeRelayMessages     : state.vnodeRelayMessages
    };
}

/**
 * @summary Fast per-`rAF` viewport coverage check detecting vertical or horizontal blank frames
 * where all `.neo-grid-row` or `.neo-grid-cell` nodes sit outside `.neo-grid-view`'s visible viewport rect.
 */
function sampleViewportCoverage(vScroller, gridBody) {
    if (!vScroller || !gridBody) {
        return { isBlank: false, visibleRows: 0, visibleCells: 0 };
    }
    const viewRect = vScroller.getBoundingClientRect();
    if (viewRect.width <= 0 || viewRect.height <= 0) {
        return { isBlank: false, visibleRows: 0, visibleCells: 0 };
    }
    const topEdge    = viewRect.top + 2;
    const bottomEdge = viewRect.bottom - 2;
    const leftEdge   = viewRect.left + 2;
    const rightEdge  = viewRect.right - 2;

    const rows      = gridBody.children;
    let visibleRows = 0;
    let probeRow    = null;

    for (let i = 0, len = rows.length; i < len; i++) {
        const row = rows[i];
        if (!row.classList?.contains('neo-grid-row')) continue;
        const r = row.getBoundingClientRect();
        if (r.height > 0 && r.bottom > topEdge && r.top < bottomEdge) {
            visibleRows++;
            if (!probeRow) probeRow = row;
        }
    }

    if (visibleRows === 0 || !probeRow) {
        return { isBlank: true, visibleRows: 0, visibleCells: 0 };
    }

    const cells      = probeRow.querySelectorAll('.neo-grid-cell');
    let visibleCells = 0;
    for (let j = 0, clen = cells.length; j < clen; j++) {
        const cr = cells[j].getBoundingClientRect();
        if (cr.width > 0 && cr.right > leftEdge && cr.left < rightEdge) {
            visibleCells++;
        }
    }

    return {
        isBlank: visibleCells === 0,
        visibleRows,
        visibleCells
    };
}

function createFrameAndBlankTracker(vScroller, gridBody) {
    const frameDeltas   = [];
    let blankFrames     = 0;
    let blankMs         = 0;
    let curBlankStreak  = 0;
    let maxBlankStreak  = 0;
    let minVisibleRows  = Infinity;
    let minVisibleCells = Infinity;
    let active          = true;
    let lastNow         = performance.now();
    globalThis.__devindexActiveTrackers = (globalThis.__devindexActiveTrackers || 0) + 1;

    function tick(now) {
        if (!active) return;
        const dt = now - lastNow;
        lastNow  = now;
        frameDeltas.push(dt);

        const cov = sampleViewportCoverage(vScroller, gridBody);
        if (cov.visibleRows < minVisibleRows) minVisibleRows = cov.visibleRows;
        if (cov.visibleCells < minVisibleCells) minVisibleCells = cov.visibleCells;

        if (cov.isBlank) {
            blankFrames++;
            blankMs += dt;
            curBlankStreak += dt;
            if (curBlankStreak > maxBlankStreak) maxBlankStreak = curBlankStreak;
        } else {
            curBlankStreak = 0;
        }

        requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);

    return {
        isActive: () => active,
        stop() {
            if (!active && !frameDeltas.length) {
                return {
                    frames: 0, fps: 0, frameP50Ms: 0, frameP95Ms: 0, frameP99Ms: 0, maxRafMs: 0, longFrames50: 0,
                    blankFrames: 0, blankMs: 0, maxBlankStreakMs: 0, minVisibleRows: 0, minVisibleCells: 0
                };
            }
            if (active) {
                active = false;
                globalThis.__devindexActiveTrackers = Math.max(0, (globalThis.__devindexActiveTrackers || 1) - 1);
            }
            const st     = stats(frameDeltas);
            const totalS = frameDeltas.reduce((a, b) => a + b, 0) / 1000;
            return {
                frames          : frameDeltas.length,
                fps             : totalS > 0 ? +(frameDeltas.length / totalS).toFixed(1) : 0,
                frameP50Ms      : st.p50,
                frameP95Ms      : st.p95,
                frameP99Ms      : st.p99,
                maxRafMs        : st.max,
                longFrames50    : frameDeltas.filter(d => d > 50).length,
                blankFrames,
                blankMs         : +blankMs.toFixed(2),
                maxBlankStreakMs: +maxBlankStreak.toFixed(2),
                minVisibleRows  : Number.isFinite(minVisibleRows) ? minVisibleRows : 0,
                minVisibleCells : Number.isFinite(minVisibleCells) ? minVisibleCells : 0
            };
        }
    };
}

/**
 * Verifies that BOTH vertical (`data-row-id === rowId` inside `.neo-grid-view`) AND horizontal
 * (`[targetLeft, targetLeft + clientWidth]` column pool mounted and visible across left & right interior bands)
 * rendering have completed for a 2D scroll hop.
 */
function is2dHopRendered({ rowId, targetLeft, maxLeft, vScroller, hScroller, gridBody }) {
    if (!vScroller || !gridBody) return false;
    const row = gridBody.querySelector(`.neo-grid-row[data-row-id="${rowId}"]`);
    if (!row) return false;

    const vr = vScroller.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (vr.width <= 0 || vr.height <= 0 || rr.height <= 0) return false;
    if (rr.bottom <= vr.top + 2 || rr.top >= vr.bottom - 2) return false;

    const cells = row.querySelectorAll('.neo-grid-cell');
    if (!cells.length) return false;

    if (maxLeft <= 0 || !hScroller) {
        return true;
    }

    if (Math.abs(hScroller.scrollLeft - targetLeft) > 4) return false;

    const clientW = hScroller.clientWidth || vr.width;
    const winLo   = targetLeft;
    const winHi   = targetLeft + clientW;
    const cBand   = Math.min(180, Math.max(48, clientW * 0.38));
    const vBand   = Math.min(180, Math.max(48, vr.width * 0.38));

    let hasTargetVisibleLeft  = false;
    let hasTargetVisibleRight = false;

    for (let i = 0, len = cells.length; i < len; i++) {
        const cell   = cells[i];
        const styleL = Number.parseFloat(cell.style?.left);
        const cellW  = Number.parseFloat(cell.style?.width) || cell.offsetWidth || 0;
        if (!Number.isFinite(styleL) || cellW <= 0) continue;

        const styleR = styleL + cellW;
        // Cell must logically belong to the target horizontal column window [targetLeft, targetLeft + clientWidth]
        if (styleR <= winLo + 2 || styleL >= winHi - 2) continue;

        const cr = cell.getBoundingClientRect();
        if (cr.width <= 0 || cr.bottom <= vr.top + 2 || cr.top >= vr.bottom - 2) continue;

        // Same-cell visual alignment guard: reject buffered target cells that are still offscreen prior to scroll sync
        const visualRelLeft   = cr.left - vr.left;
        const expectedRelLeft = styleL - targetLeft;
        if (Math.abs(visualRelLeft - expectedRelLeft) > 16) continue;

        if (styleL <= winLo + cBand && cr.left <= vr.left + vBand && cr.right > vr.left + 4) {
            hasTargetVisibleLeft = true;
        }
        if (styleR >= winHi - cBand && cr.right >= vr.right - vBand && cr.left < vr.right - 4) {
            hasTargetVisibleRight = true;
        }
    }

    return hasTargetVisibleLeft && hasTargetVisibleRight;
}

/**
 * Multi-row viewport signature across all mounted `.neo-grid-row` elements so re-sorts and rank-filters
 * complete accurately even when row 0 (`first record`) remains the same while subsequent rows reorder.
 */
function getMountedRowsSignature(gridBody) {
    if (!gridBody) return '';
    const rows = Array.from(gridBody.querySelectorAll('.neo-grid-row'));
    if (!rows.length) return '';
    rows.sort((a, b) => Number(a.dataset.rowId || 0) - Number(b.dataset.rowId || 0));
    return rows.map((row) => {
        const id    = row.dataset.rowId ?? '';
        const recId = row.dataset.recordId ?? '';
        const login = row.querySelector('.neo-grid-cell[data-field="login"]')?.textContent?.trim() || '';
        const rank  = row.querySelector('.neo-grid-cell[data-field="rank"]')?.textContent?.trim() || '';
        const total = row.querySelector('.neo-grid-cell[data-field="totalContributions"]')?.textContent?.trim() || '';
        const ratio = row.querySelector('.neo-grid-cell[data-field="commitsRatio"]')?.textContent?.trim() || '';
        return `${id}:${recId}:${login}:${rank}:${total}:${ratio}`;
    }).join('|');
}

function getHeaderSortDirection(headerBtn) {
    if (!headerBtn || headerBtn.classList.contains('neo-sort-hidden')) return 'none';
    const aria = headerBtn.getAttribute('aria-sort') || headerBtn.closest('[role="columnheader"]')?.getAttribute('aria-sort');
    if (aria === 'ascending' || aria === 'descending') return aria;
    if (headerBtn.classList.contains('neo-sort-asc'))  return 'ascending';
    if (headerBtn.classList.contains('neo-sort-desc')) return 'descending';
    return 'none';
}

function getGlobalNonEmptyFlights() {
    const manager = ensureProbeInstalled();
    return manager?.__devindexGlobalNonEmptyFlights || 0;
}

function readStreamRowCount() {
    const gridEl = document.querySelector('[role="grid"]');
    const rawAttr = gridEl?.getAttribute('aria-rowcount');
    if (rawAttr !== null && rawAttr !== undefined && rawAttr !== '') {
        const ariaRows = Number(rawAttr);
        if (Number.isFinite(ariaRows) && ariaRows > 0) {
            return Math.max(0, ariaRows - 1);
        }
    }
    const statsText = document.querySelector('.devindex-stats-container')?.textContent || '';
    const match     = statsText.match(/Visible Rows:\s*([\d.,'’\s\u00A0\u202F_]+)/i);
    if (match) {
        const digits = match[1].replace(/\D+/g, '');
        if (digits.length > 0) {
            const parsed = Number(digits);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return 0;
}

function measureProbe(name, action, condition, optsOrTimeout = 30000) {
    const opts               = typeof optsOrTimeout === 'number' ? { timeout: optsOrTimeout } : (optsOrTimeout || {});
    const timeout            = opts.timeout ?? 30000;
    const quiescentCondition = typeof opts.quiescentCondition === 'function' ? opts.quiescentCondition : null;

    return new Promise((resolve, reject) => {
        const frameDeltas      = [];
        let lastFrame          = performance.now();
        let rafActive          = true;
        let settled            = false;
        let candidateTime      = null;
        let candidateFlights   = 0;
        let quiescentCheckBusy = false;

        function tick(now) {
            if (!rafActive) return;
            frameDeltas.push(now - lastFrame);
            lastFrame = now;
            requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);

        const cleanup = () => {
            rafActive = false;
            observer.disconnect();
            clearTimeout(timer);
        };

        const finish = (endTime) => {
            if (settled) return;
            settled    = true;
            const tail = endTime - lastFrame;
            if (tail > 0) frameDeltas.push(tail);
            cleanup();
            resolve({
                tvsMs        : +(Math.max(0, endTime - startTime)).toFixed(2),
                maxRafDeltaMs: +(frameDeltas.length ? Math.max(...frameDeltas) : 0).toFixed(2),
                longFrames50 : frameDeltas.filter(d => d > 50).length,
                frameDeltas
            });
        };

        const scheduleQuiescentVerify = () => {
            if (settled || quiescentCheckBusy || !quiescentCondition) return;
            quiescentCheckBusy = true;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    quiescentCheckBusy = false;
                    if (settled) return;
                    try {
                        if (condition()) {
                            finish(performance.now());
                            return;
                        }
                        if (!quiescentCondition()) {
                            candidateTime = null;
                            return;
                        }
                        const curFlights = getGlobalNonEmptyFlights();
                        if (curFlights > candidateFlights) {
                            candidateTime    = performance.now();
                            candidateFlights = curFlights;
                            scheduleQuiescentVerify();
                            return;
                        }
                        finish(candidateTime ?? performance.now());
                    } catch (err) {
                        settled = true;
                        cleanup();
                        reject(err);
                    }
                });
            });
        };

        const checkProgress = () => {
            if (settled) return;
            if (condition()) {
                finish(performance.now());
                return;
            }
            if (quiescentCondition) {
                if (quiescentCondition()) {
                    if (candidateTime === null) {
                        candidateTime    = performance.now();
                        candidateFlights = getGlobalNonEmptyFlights();
                    }
                    scheduleQuiescentVerify();
                } else {
                    candidateTime = null;
                }
            }
        };

        const observer = new MutationObserver(() => {
            try {
                checkProgress();
            } catch (err) {
                settled = true;
                cleanup();
                reject(err);
            }
        });
        observer.observe(document.body, { attributes: true, childList: true, subtree: true });

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(`Benchmark step timed out: ${name}`));
        }, timeout);

        const startTime = performance.now();
        lastFrame       = startTime;

        try {
            action();
            checkProgress();
        } catch (err) {
            settled = true;
            cleanup();
            reject(err);
        }
    });
}

function getTopology() {
    const isArmC        = Boolean(globalThis.__NEO_BENCH_ARM_C || globalThis.location?.pathname?.startsWith('/arm-c/'));
    const useVdomWorker = Boolean(globalThis.Neo?.config?.useVdomWorker);
    const hasVdomWorker = Boolean(
        globalThis.Neo?.worker?.Manager?.getWorker?.('vdom') ||
        globalThis.Neo?.worker?.Manager?.workers?.vdom?.worker
    );
    const armKey     = isArmC ? 'C' : (useVdomWorker ? 'A' : 'B');
    const buildLabel = globalThis.__NEO_BENCH_BUILD_LABEL || (isArmC ? 'v14-arm-c-22218' : 'v14-dev-ab');
    return { armKey, isArmC, buildLabel, useVdomWorker, hasVdomWorker };
}

function dispatchTouchGestureEvent(targetEl, type, cx, cy, isEnd = false) {
    let touchObj = null;
    if (typeof Touch === 'function') {
        try {
            touchObj = new Touch({
                identifier: 1,
                target    : targetEl,
                clientX   : cx,
                clientY   : cy,
                pageX     : cx,
                pageY     : cy,
                screenX   : cx,
                screenY   : cy,
                radiusX   : 8,
                radiusY   : 8,
                force     : isEnd ? 0 : 1
            });
        } catch {
            touchObj = null;
        }
    }

    if (touchObj && typeof TouchEvent === 'function') {
        try {
            const activeList = isEnd ? [] : [touchObj];
            const ev = new TouchEvent(type, {
                bubbles       : true,
                cancelable    : true,
                composed      : true,
                touches       : activeList,
                targetTouches : activeList,
                changedTouches: [touchObj]
            });
            return targetEl.dispatchEvent(ev);
        } catch {
            // Fall through to synthetic Event wrapper below
        }
    }

    const fallbackTouch = { clientX: cx, clientY: cy, pageX: cx, pageY: cy, screenX: cx, screenY: cy, identifier: 1, target: targetEl };
    const ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
    Object.defineProperties(ev, {
        touches       : { value: isEnd ? [] : [fallbackTouch] },
        targetTouches : { value: isEnd ? [] : [fallbackTouch] },
        changedTouches: { value: [fallbackTouch] }
    });
    return targetEl.dispatchEvent(ev);
}

/**
 * @summary Drives real `Neo.main.addon.GridDragScroll` along the active input path (`touchstart`/`touchmove`/`touchend`
 * when `Neo.config.hasTouchEvents === true`, else `mousedown`/`mousemove`/`mouseup`) while requiring 2D per-axis travel
 * when horizontal scroll extent exists and guaranteeing probe/tracker cleanup on error.
 */
async function runGridDragScrollStrokes(vScroller, hScroller, gridBody) {
    const useTouch  = Boolean(globalThis.Neo?.config?.hasTouchEvents);
    const inputMode = useTouch ? 'touch' : 'mouse';
    const rect      = vScroller.getBoundingClientRect();
    const startX    = Math.round(rect.left + Math.min(rect.width * 0.72, rect.width - 24));
    const startY    = Math.round(rect.top + Math.min(rect.height * 0.72, rect.height - 24));

    const maxLeft = Math.max(0, (hScroller?.scrollWidth || 0) - (hScroller?.clientWidth || 0));
    const dxStep  = -Math.max(18, Math.min(48, Math.round(maxLeft / 28) || 28));
    const dyStep  = -165;

    vScroller.scrollTop = 200;
    if (hScroller) hScroller.scrollLeft = 0;
    await sleep(160);

    const beforeTop  = vScroller.scrollTop;
    const beforeLeft = hScroller ? hScroller.scrollLeft : 0;

    startWorkerProbe();
    const tracker       = createFrameAndBlankTracker(vScroller, gridBody);
    let deliveredMoves  = 0;
    let totalTravelTop  = 0;
    let totalTravelLeft = 0;
    let peakTop         = beforeTop;
    let peakLeft        = beforeLeft;

    let frameSummary;
    let workers;

    try {
        const runSingleStroke = async (dirSign) => {
            let cx = dirSign > 0 ? startX : Math.round(rect.left + Math.max(24, rect.width * 0.28));
            let cy = dirSign > 0 ? startY : Math.round(rect.top + Math.max(24, rect.height * 0.28));
            const targetEl  = gridBody.querySelector('.neo-grid-row') || gridBody;
            const strokeTop = vScroller.scrollTop;
            const strokeLft = hScroller ? hScroller.scrollLeft : 0;

            if (useTouch) {
                dispatchTouchGestureEvent(targetEl, 'touchstart', cx, cy, false);
            } else {
                targetEl.dispatchEvent(new MouseEvent('mousedown', {
                    bubbles   : true,
                    cancelable: true,
                    composed  : true,
                    button    : 0,
                    buttons   : 1,
                    clientX   : cx,
                    clientY   : cy
                }));
            }

            await sleep(115);

            for (let step = 0; step < 12; step++) {
                cx += dirSign * dxStep;
                cy += dirSign * dyStep;
                if (useTouch) {
                    dispatchTouchGestureEvent(targetEl, 'touchmove', cx, cy, false);
                } else {
                    document.dispatchEvent(new MouseEvent('mousemove', {
                        bubbles   : true,
                        cancelable: true,
                        composed  : true,
                        button    : 0,
                        buttons   : 1,
                        clientX   : cx,
                        clientY   : cy
                    }));
                }
                deliveredMoves++;
                await sleep(16);
            }

            if (useTouch) {
                dispatchTouchGestureEvent(targetEl, 'touchend', cx, cy, true);
            } else {
                document.dispatchEvent(new MouseEvent('mouseup', {
                    bubbles   : true,
                    cancelable: true,
                    composed  : true,
                    button    : 0,
                    buttons   : 0,
                    clientX   : cx,
                    clientY   : cy
                }));
            }

            const tWait0    = performance.now();
            let stableCount = 0;
            let prevTop     = vScroller.scrollTop;
            let prevLeft    = hScroller ? hScroller.scrollLeft : 0;

            while (performance.now() - tWait0 < 3500) {
                await sleep(32);
                const curTop    = vScroller.scrollTop;
                const curLeft   = hScroller ? hScroller.scrollLeft : 0;
                const addonBusy = Boolean(globalThis.Neo?.main?.addon?.GridDragScroll?.activeDrag);
                if (!addonBusy && Math.abs(curTop - prevTop) < 0.5 && Math.abs(curLeft - prevLeft) < 0.5) {
                    stableCount++;
                    if (stableCount >= 2) break;
                } else {
                    stableCount = 0;
                }
                prevTop  = curTop;
                prevLeft = curLeft;
            }

            totalTravelTop  += Math.abs(vScroller.scrollTop - strokeTop);
            totalTravelLeft += Math.abs((hScroller ? hScroller.scrollLeft : 0) - strokeLft);
        };

        await runSingleStroke(1);
        peakTop  = vScroller.scrollTop;
        peakLeft = hScroller ? hScroller.scrollLeft : 0;
        await runSingleStroke(-1);
    } finally {
        frameSummary = tracker.stop();
        workers      = stopWorkerProbe();
    }
    const peakScrollDeltaTop  = Math.round(Math.abs(peakTop - beforeTop));
    const peakScrollDeltaLeft = Math.round(Math.abs(peakLeft - beforeLeft));
    const expectsHorizontal   = maxLeft >= 40;
    const hasVerticalTravel   = peakScrollDeltaTop >= 50;
    const hasHorizontalTravel = !expectsHorizontal || peakScrollDeltaLeft >= 20;
    const available           = hasVerticalTravel && hasHorizontalTravel;

    if (!available) {
        const unavailableReason = !hasVerticalTravel && !hasHorizontalTravel
            ? 'zero-travel'
            : (!hasVerticalTravel ? 'zero-vertical-travel' : 'zero-horizontal-travel');
        return {
            available: false,
            unavailableReason,
            inputMode,
            expectsHorizontal,
            deliveredMoves,
            frames          : frameSummary.frames,
            fps             : null,
            frameP50Ms      : null,
            frameP95Ms      : null,
            frameP99Ms      : null,
            maxRafMs        : null,
            longFrames50    : null,
            blankFrames     : null,
            blankMs         : null,
            maxBlankStreakMs: null,
            minVisibleRows  : frameSummary.minVisibleRows,
            minVisibleCells : frameSummary.minVisibleCells,
            peakScrollDeltaTop,
            peakScrollDeltaLeft,
            totalTravelTop  : Math.round(totalTravelTop),
            totalTravelLeft : Math.round(totalTravelLeft),
            workers
        };
    }

    return {
        available        : true,
        unavailableReason: null,
        inputMode,
        expectsHorizontal,
        deliveredMoves,
        ...frameSummary,
        peakScrollDeltaTop,
        peakScrollDeltaLeft,
        totalTravelTop : Math.round(totalTravelTop),
        totalTravelLeft: Math.round(totalTravelLeft),
        workers
    };
}

function clickDrawerToggle() {
    const btns   = Array.from(document.querySelectorAll('button'));
    const toggle = btns.find(b => b.querySelector('.fa-bars, .fa-sliders')) ||
                   document.querySelector('.neo-header-toolbar button:last-of-type');
    if (toggle) toggle.click();
}

async function applyBufferPresetAndPrimeSearchTab(bufferRows, bufferCols) {
    const controls     = document.querySelector('.devindex-controls-container');
    const wasCollapsed = controls && !controls.classList.contains('neo-expanded');

    if (wasCollapsed) {
        clickDrawerToggle();
        await sleep(260);
    }

    const tabs        = Array.from(document.querySelectorAll('.neo-tab-header-button'));
    const settingsTab = tabs.find(b => b.textContent.includes('Settings'));
    if (settingsTab) {
        settingsTab.click();
        await sleep(180);
    }

    const selectCombo = (labelText, itemText) => new Promise((resolve, reject) => {
        const label = Array.from(document.querySelectorAll('label')).find(l => l.textContent.trim() === labelText);
        if (!label) return reject(new Error(`Label "${labelText}" not found`));
        const combo = label.closest('.neo-combobox');
        const input = combo?.querySelector('input');
        if (input && input.value?.trim() === String(itemText)) {
            return resolve();
        }
        const trigger = combo?.querySelector('.fa-caret-down');
        if (!trigger) return reject(new Error(`Trigger "${labelText}" not found`));
        const timer = setTimeout(() => {
            obs.disconnect();
            reject(new Error(`Combo "${labelText}"="${itemText}" timed out`));
        }, 8000);
        const obs = new MutationObserver(() => {
            const picker = document.getElementById(`${combo.id}__picker`);
            if (picker && picker.getBoundingClientRect().height > 0) {
                const li = Array.from(picker.querySelectorAll('li')).find(el => el.textContent.trim() === String(itemText));
                if (li) {
                    clearTimeout(timer);
                    obs.disconnect();
                    li.click();
                    resolve();
                }
            }
        });
        obs.observe(document.body, { attributes: true, childList: true, subtree: true });
        trigger.click();
    });

    await selectCombo('Buffer Row Range', String(bufferRows));
    await sleep(140);
    await selectCombo('Buffer Column Range', String(bufferCols));
    await sleep(180);

    // Prime Search tab so Hireable Only / Hide Commit Ratio > 90% checkboxes remain mounted when collapsed
    const searchTab = Array.from(document.querySelectorAll('.neo-tab-header-button')).find(b => b.textContent.includes('Search'));
    if (searchTab) {
        searchTab.click();
        await sleep(160);
    }

    if (wasCollapsed && controls?.classList.contains('neo-expanded')) {
        clickDrawerToggle();
        await sleep(260);
    }
}

function findFilterCheckboxLabel(valueLabelText) {
    const labels = Array.from(document.querySelectorAll('.devindex-controls-container label, .devindex-controls-container .neo-checkbox-value-label'));
    const match  = labels.find(el => el.textContent.trim() === valueLabelText);
    if (!match) throw new Error(`Filter checkbox "${valueLabelText}" not found`);
    const checkbox = match.closest('.neo-checkbox');
    return checkbox?.querySelector('.neo-checkbox-input, input[type="checkbox"]') || match;
}

function copyTextWithFallback(text) {
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackExecCopy(text));
    }
    return Promise.resolve(fallbackExecCopy(text));
}

function fallbackExecCopy(text) {
    const ta = document.createElement('textarea');
    ta.value     = text;
    ta.className = 'devindex-bench-sr-only';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch {
        ok = false;
    }
    ta.remove();
    return ok;
}

function buildArmUrl(targetArm, preset) {
    const u        = new URL(globalThis.location.href);
    const basePath = u.pathname.replace(/^\/arm-c(?=\/)/, '');
    u.pathname     = targetArm === 'C' ? `/arm-c${basePath}` : basePath;
    u.searchParams.set('bench', '1');
    u.searchParams.set('useVdomWorker', targetArm === 'B' ? 'false' : 'true');
    if (preset) u.searchParams.set('preset', preset);
    u.searchParams.delete('autorunSeries');
    u.searchParams.delete('seriesSlot');
    return u.toString();
}

function formatSeriesMarkdown(series) {
    const allA        = series.results.filter(r => (r.planArm || r.topology?.armKey) === 'A');
    const allB        = series.results.filter(r => (r.planArm || r.topology?.armKey) === 'B');
    const runsA       = allA.filter(r => r.sampleValid !== false && r.scroll20Hops);
    const runsB       = allB.filter(r => r.sampleValid !== false && r.scroll20Hops);
    const validFlingA = runsA.filter(r => r.gridDragFling?.available);
    const validFlingB = runsB.filter(r => r.gridDragFling?.available);
    const sampleMeta  = runsA[0] || runsB[0] || series.results.find(r => r.device) || {};
    const flagged     = series.results
        .filter(r => r.sampleValid === false)
        .map(r => `#${(r.planSlot ?? 0) + 1}(${r.planArm || r.topology?.armKey || '?'}:${(r.invalidReasons || ['invalid']).join('+')})`);

    const fmtMetric = (label, arrA, arrB, gateOpts = null) => {
        if (!arrA.length || !arrB.length) {
            return `| ${label} | \`unavailable (${arrA.length}/${allA.length})\` | \`unavailable (${arrB.length}/${allB.length})\` | n/a |`;
        }
        const stA = stats(arrA);
        const stB = stats(arrB);
        const ev  = evaluateRelativeThreshold(arrA, arrB, 0.10, gateOpts || { minSamplesPerArm: 10 });
        if (!ev) {
            return `| ${label} | \`${stA.mean} ± ${stA.sd}\` (med \`${stA.p50}\`, p99 \`${stA.p99}\`, max \`${stA.max}\`) | \`${stB.mean} ± ${stB.sd}\` (med \`${stB.p50}\`, p99 \`${stB.p99}\`, max \`${stB.max}\`) | n/a (\`n=${stA.n},${stB.n}\`) |`;
        }
        const fiellerStr = ev.ciLow !== null ? `\`[${ev.ciLow}%, ${ev.ciHi}%]\`` : `\`[unbounded]\``;
        let gateStr      = ` (\`df=${ev.df}\`)`;
        if (gateOpts) {
            const verdict = !ev.sampleCountMet
                ? `INCONCLUSIVE (\`n=${stA.n},${stB.n} < ${ev.minSamplesPerArm}/arm\`)`
                : (ev.passesThreshold ? 'PASS' : 'FAIL');
            gateStr = ` · \`0.9μA−μB\` LB \`${ev.contrastCiLow >= 0 ? '+' : ''}${ev.contrastCiLow} ms\` (**${verdict}**, \`df=${ev.df}\`)`;
        }
        return `| ${label} | \`${stA.mean} ± ${stA.sd}\` (med \`${stA.p50}\`, p99 \`${stA.p99}\`, max \`${stA.max}\`) | \`${stB.mean} ± ${stB.sd}\` (med \`${stB.p50}\`, p99 \`${stB.p99}\`, max \`${stB.max}\`) | **\`${ev.pct >= 0 ? '+' : ''}${ev.pct}%\`** ${fiellerStr}${gateStr} |`;
    };

    const sweepBlankA = runsA.reduce((s, r) => s + (r.sustainedSweep60?.blankFrames || 0), 0);
    const sweepBlankB = runsB.reduce((s, r) => s + (r.sustainedSweep60?.blankFrames || 0), 0);
    const flingBlankA = validFlingA.reduce((s, r) => s + (r.gridDragFling?.blankFrames || 0), 0);
    const flingBlankB = validFlingB.reduce((s, r) => s + (r.gridDragFling?.blankFrames || 0), 0);
    const hid         = series.results.reduce((s, r) => s + (r.visibility?.hiddenEvents || 0), 0);
    const ltSupported = Boolean(runsA[0]?.longTasks?.supported || runsB[0]?.longTasks?.supported);
    const ltLine      = ltSupported
        ? `Suite Arm A=\`[${runsA.map(r => `${r.longTasks?.count ?? 0}/${r.longTasks?.maxMs ?? 0}ms`).join(', ')}]\` · Suite Arm B=\`[${runsB.map(r => `${r.longTasks?.count ?? 0}/${r.longTasks?.maxMs ?? 0}ms`).join(', ')}]\` · Stream Arm A=\`[${runsA.map(r => `${r.initialStream?.longTasks?.count ?? 0}/${r.initialStream?.longTasks?.maxMs ?? 0}ms`).join(', ')}]\` · Stream Arm B=\`[${runsB.map(r => `${r.initialStream?.longTasks?.count ?? 0}/${r.initialStream?.longTasks?.maxMs ?? 0}ms`).join(', ')}]\``
        : `PerformanceObserver('longtask') unsupported in this browser engine (use per-run rAF >50ms spikes & maxRAF below)`;

    return [
        `### DevIndex Counter-Balanced \`AB/BA\` Fresh-Navigation Series (Qualifying \`n=${runsA.length}/${allA.length}\` A, \`n=${runsB.length}/${allB.length}\` B · Preset \`${series.preset}\`)`,
        `- **Device:** \`${sampleMeta.device?.viewport || 'n/a'}\` @ \`${sampleMeta.device?.dpr || 'n/a'}x\` · Grid=\`${sampleMeta.device?.gridViewport || 'n/a'}\` · Canvases=\`${sampleMeta.buffer?.mountedCanvases ?? 'n/a'}\` · DOM=\`${sampleMeta.buffer?.mountedDomNodes ?? 'n/a'}\` · HiddenEvents=\`${hid}\``,
        `- **Qualifying Sample Gate:** Arm A=\`${runsA.length}/${allA.length}\` · Arm B=\`${runsB.length}/${allB.length}\` · Flagged/Excluded=\`${flagged.length ? flagged.join(', ') : 'none'}\` (Decision rule requires \`>= 10/arm\` for means, \`>= 20/arm\` where a tail metric decides)`,
        `- **Valid 2D Fling Pages (${sampleMeta.gridDragFling?.inputMode || 'auto'}):** Arm A=\`${validFlingA.length}/${runsA.length}\` · Arm B=\`${validFlingB.length}/${runsB.length}\` (blank frames — DragFling: A=\`${validFlingA.length ? flingBlankA : 'n/a'}\`, B=\`${validFlingB.length ? flingBlankB : 'n/a'}\`; 60-Step Sweep: A=\`${sweepBlankA}\`, B=\`${sweepBlankB}\`)`,
        ``,
        `| Metric (Qualifying Pages) | Arm A (\`VDom=true\`) | Arm B (\`VDom=false\`) | \`B vs A\` Fieller \`95% CI\` & \`>=10%\` Contrast |`,
        `|---|---|---|---|`,
        fmtMetric('50k Stream-In Wall (ms)', runsA.map(r => r.initialStream.streamWallMs), runsB.map(r => r.initialStream.streamWallMs), null),
        fmtMetric('50k Stream-In Frame p99 (ms)', runsA.map(r => r.initialStream.frameP99Ms), runsB.map(r => r.initialStream.frameP99Ms), null),
        fmtMetric('20-Hop 2D Scroll Mean TVS (ms)', runsA.map(r => r.scroll20Hops.tvs.meanUnrounded ?? r.scroll20Hops.tvs.mean), runsB.map(r => r.scroll20Hops.tvs.meanUnrounded ?? r.scroll20Hops.tvs.mean), { minSamplesPerArm: 10 }),
        fmtMetric('20-Hop 2D Scroll p95 TVS (ms)', runsA.map(r => r.scroll20Hops.tvs.p95), runsB.map(r => r.scroll20Hops.tvs.p95), { isTailMetric: true, minSamplesPerArm: 20 }),
        fmtMetric('20-Hop 2D Scroll p99 TVS (ms)', runsA.map(r => r.scroll20Hops.tvs.p99), runsB.map(r => r.scroll20Hops.tvs.p99), null),
        fmtMetric('60-Step Sweep Frame p95 (ms)', runsA.map(r => r.sustainedSweep60.frameP95Ms), runsB.map(r => r.sustainedSweep60.frameP95Ms), null),
        fmtMetric('60-Step Sweep Frame p99 (ms)', runsA.map(r => r.sustainedSweep60.frameP99Ms), runsB.map(r => r.sustainedSweep60.frameP99Ms), null),
        fmtMetric('GridDragScroll Fling Frame p95 (ms)', validFlingA.map(r => r.gridDragFling.frameP95Ms), validFlingB.map(r => r.gridDragFling.frameP95Ms), { isTailMetric: true, minSamplesPerArm: 20 }),
        fmtMetric('GridDragScroll Fling Frame p99 (ms)', validFlingA.map(r => r.gridDragFling.frameP99Ms), validFlingB.map(r => r.gridDragFling.frameP99Ms), null),
        fmtMetric('GridDragScroll Blank Time (ms)', validFlingA.map(r => r.gridDragFling.blankMs), validFlingB.map(r => r.gridDragFling.blankMs), null),
        fmtMetric('50k Warm Re-Sort Mean TVS (ms)', runsA.map(r => r.sort50k.tvs.meanUnrounded ?? r.sort50k.tvs.mean), runsB.map(r => r.sort50k.tvs.meanUnrounded ?? r.sort50k.tvs.mean), { minSamplesPerArm: 10 }),
        fmtMetric('50k Warm Rank-Filter Mean TVS (ms)', runsA.map(r => r.filter50k.tvs.meanUnrounded ?? r.filter50k.tvs.mean), runsB.map(r => r.filter50k.tvs.meanUnrounded ?? r.filter50k.tvs.mean), { minSamplesPerArm: 10 }),
        ``,
        `- **Raw Stream Wall / p95 / p99 / maxRAF / spikes>50ms A:** \`[${runsA.map(r => `${r.initialStream.streamWallMs}/${r.initialStream.frameP95Ms}/${r.initialStream.frameP99Ms}/${r.initialStream.maxRafMs}/${r.initialStream.longFrames50}`).join(', ')}]\``,
        `- **Raw Stream Wall / p95 / p99 / maxRAF / spikes>50ms B:** \`[${runsB.map(r => `${r.initialStream.streamWallMs}/${r.initialStream.frameP95Ms}/${r.initialStream.frameP99Ms}/${r.initialStream.maxRafMs}/${r.initialStream.longFrames50}`).join(', ')}]\``,
        `- **Raw Scroll p95 / p99 / maxRAF / spikes>50ms A:** \`[${runsA.map(r => `${r.scroll20Hops.tvs.p95}/${r.scroll20Hops.tvs.p99}/${r.scroll20Hops.maxRafMs}/${r.scroll20Hops.longFrames50}`).join(', ')}]\``,
        `- **Raw Scroll p95 / p99 / maxRAF / spikes>50ms B:** \`[${runsB.map(r => `${r.scroll20Hops.tvs.p95}/${r.scroll20Hops.tvs.p99}/${r.scroll20Hops.maxRafMs}/${r.scroll20Hops.longFrames50}`).join(', ')}]\``,
        `- **Raw 60-Step Sweep p95 / p99 / maxRAF / spikes>50ms / blankMs A:** \`[${runsA.map(r => `${r.sustainedSweep60.frameP95Ms}/${r.sustainedSweep60.frameP99Ms}/${r.sustainedSweep60.maxRafMs}/${r.sustainedSweep60.longFrames50}/${r.sustainedSweep60.blankMs}`).join(', ')}]\``,
        `- **Raw 60-Step Sweep p95 / p99 / maxRAF / spikes>50ms / blankMs B:** \`[${runsB.map(r => `${r.sustainedSweep60.frameP95Ms}/${r.sustainedSweep60.frameP99Ms}/${r.sustainedSweep60.maxRafMs}/${r.sustainedSweep60.longFrames50}/${r.sustainedSweep60.blankMs}`).join(', ')}]\``,
        `- **Raw Sort Mean / p99 / maxRAF / spikes>50ms A:** \`[${runsA.map(r => `${r.sort50k.tvs.mean}/${r.sort50k.tvs.p99}/${r.sort50k.maxRafMs}/${r.sort50k.longFrames50 ?? 0}`).join(', ')}]\``,
        `- **Raw Sort Mean / p99 / maxRAF / spikes>50ms B:** \`[${runsB.map(r => `${r.sort50k.tvs.mean}/${r.sort50k.tvs.p99}/${r.sort50k.maxRafMs}/${r.sort50k.longFrames50 ?? 0}`).join(', ')}]\``,
        `- **Raw Rank-Filter Mean / p99 / maxRAF / spikes>50ms A:** \`[${runsA.map(r => `${r.filter50k.tvs.mean}/${r.filter50k.tvs.p99}/${r.filter50k.maxRafMs}/${r.filter50k.longFrames50 ?? 0}`).join(', ')}]\``,
        `- **Raw Rank-Filter Mean / p99 / maxRAF / spikes>50ms B:** \`[${runsB.map(r => `${r.filter50k.tvs.mean}/${r.filter50k.tvs.p99}/${r.filter50k.maxRafMs}/${r.filter50k.longFrames50 ?? 0}`).join(', ')}]\``,
        `- **Raw DragFling p95 / p99 / maxRAF / spikes>50ms / blankMs (valid) A:** \`[${validFlingA.map(r => `${r.gridDragFling.frameP95Ms}/${r.gridDragFling.frameP99Ms}/${r.gridDragFling.maxRafMs}/${r.gridDragFling.longFrames50}/${r.gridDragFling.blankMs}`).join(', ')}]\``,
        `- **Raw DragFling p95 / p99 / maxRAF / spikes>50ms / blankMs (valid) B:** \`[${validFlingB.map(r => `${r.gridDragFling.frameP95Ms}/${r.gridDragFling.frameP99Ms}/${r.gridDragFling.maxRafMs}/${r.gridDragFling.longFrames50}/${r.gridDragFling.blankMs}`).join(', ')}]\``,
        `- **Raw DragFling Travel (Top×Left px) A / B:** \`[${runsA.map(r => `${r.gridDragFling.peakScrollDeltaTop}x${r.gridDragFling.peakScrollDeltaLeft}`).join(', ')}]\` / \`[${runsB.map(r => `${r.gridDragFling.peakScrollDeltaTop}x${r.gridDragFling.peakScrollDeltaLeft}`).join(', ')}]\``,
        `- **LongTask (>50ms) Count/Max:** ${ltLine}`,
        ``,
        `*Inference note: Relative gain \`95% CI\` uses Fieller's ratio interval paired with the exact Welch linear threshold contrast \`Δ_10% = 0.9μA − μB > 0\` (\`Welch–Satterthwaite df\`; \`t_{0.975,df}\` from exact \`df=1..30\` table with \`1/df\` harmonic interpolation and 3-term Cornish–Fisher expansion for \`df > 30\`, max error \`< 1e-4\`; \`PASS\` gated on \`>= 10\` qualifying pages/arm for means and \`>= 20\`/arm where a tail metric decides).*`
    ].join('\n');
}

async function initDeviceBenchmarkHud() {
    const cssHref = new URL('./device-benchmark.css', import.meta.url).href;
    const link    = document.createElement('link');
    link.rel      = 'stylesheet';
    link.href     = cssHref;
    document.head.appendChild(link);

    let visibilityHiddenEvents = 0;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') visibilityHiddenEvents++;
    });

    while (!document.querySelector('[role="grid"]') || !globalThis.Neo?.worker?.Manager) {
        await sleep(50);
    }

    const searchParams = new URLSearchParams(globalThis.location.search);
    const defaultPairs = Math.max(2, Number(searchParams.get('pairs')) || 10);
    const urlPreset    = ['1x1', '5x5', '25x15'].includes(searchParams.get('preset')) ? searchParams.get('preset') : '1x1';
    const initialTopo  = getTopology();
    const badgeClass   = initialTopo.armKey === 'C' ? 'is-arm-c' : (initialTopo.armKey === 'B' ? 'is-two-thread' : '');
    const badgeLabel   = initialTopo.armKey === 'C'
        ? `Arm C (#22218 · vdom=${initialTopo.hasVdomWorker})`
        : `Arm ${initialTopo.armKey} (useVdomWorker=${initialTopo.useVdomWorker} · vdom=${initialTopo.hasVdomWorker})`;

    const hud = document.createElement('section');
    hud.className = 'devindex-bench-hud';
    hud.innerHTML = `
        <div class="devindex-bench-header">
            <span class="devindex-bench-badge ${badgeClass}" id="devindex-bench-arm">${badgeLabel}</span>
            <div class="devindex-bench-links">
                <a class="devindex-bench-link" href="${buildArmUrl('A', urlPreset)}">Arm A</a>
                <a class="devindex-bench-link" href="${buildArmUrl('B', urlPreset)}">Arm B</a>
                <a class="devindex-bench-link" id="devindex-bench-link-c" href="${buildArmUrl('C', urlPreset)}" hidden>Arm C</a>
                <button class="devindex-bench-btn" id="devindex-bench-collapse" type="button">–</button>
            </div>
        </div>
        <div class="devindex-bench-body">
            <div class="devindex-bench-status" id="devindex-bench-status">Measuring initial 50,000-record stream...</div>
            <div class="devindex-bench-controls">
                <select class="devindex-bench-select" id="devindex-bench-preset" aria-label="Buffer preset" title="Grid buffer range preset">
                    <option value="1x1" ${urlPreset === '1x1' ? 'selected' : ''}>1×1 (Primary)</option>
                    <option value="5x5" ${urlPreset === '5x5' ? 'selected' : ''}>5×5 (Medium)</option>
                    <option value="25x15" ${urlPreset === '25x15' ? 'selected' : ''}>25×15 (Stress)</option>
                </select>
                <button class="devindex-bench-btn is-primary" id="devindex-bench-run" type="button" disabled>Run Page</button>
                <button class="devindex-bench-btn is-accent" id="devindex-bench-series" type="button" disabled>${defaultPairs * 2}p AB/BA</button>
                <button class="devindex-bench-btn" id="devindex-bench-copy" type="button" disabled>Copy</button>
            </div>
            <pre class="devindex-bench-output" id="devindex-bench-output" hidden></pre>
        </div>
    `;
    document.body.appendChild(hud);

    const statusEl    = hud.querySelector('#devindex-bench-status');
    const runBtn      = hud.querySelector('#devindex-bench-run');
    const seriesBtn   = hud.querySelector('#devindex-bench-series');
    const copyBtn     = hud.querySelector('#devindex-bench-copy');
    const presetEl    = hud.querySelector('#devindex-bench-preset');
    const outputEl    = hud.querySelector('#devindex-bench-output');
    const collapseBtn = hud.querySelector('#devindex-bench-collapse');
    const armCLink    = hud.querySelector('#devindex-bench-link-c');

    fetch('/arm-c/dist/production/apps/devindex/index.html', { method: 'HEAD' })
        .then(r => { if (r.ok) armCLink.hidden = false; })
        .catch(() => {});

    collapseBtn.addEventListener('click', () => {
        const collapsed = hud.classList.toggle('is-collapsed');
        collapseBtn.textContent = collapsed ? '+' : '–';
    });

    // Measure initial 50k stream-in automatically with guaranteed cleanup and manual-stop detection
    const streamT0        = performance.now();
    const streamFrames    = [];
    let lastStreamRaf     = streamT0;
    let streamActive      = true;
    let streamAborted     = false;
    let streamTimedOut    = false;
    const streamLongTasks = createLongTaskTracker();
    const onStopClick     = (ev) => {
        if (ev.target?.closest?.('.devindex-stop-stream-button')) {
            streamAborted = true;
        }
    };
    document.addEventListener('click', onStopClick, true);
    startWorkerProbe();

    function trackStreamRaf(now) {
        if (!streamActive) return;
        streamFrames.push(now - lastStreamRaf);
        lastStreamRaf = now;
        requestAnimationFrame(trackStreamRaf);
    }
    requestAnimationFrame(trackStreamRaf);

    let streamWorkers;
    let streamLtSummary;
    try {
        while (true) {
            const stopBtn    = document.querySelector('.devindex-stop-stream-button');
            const curRows    = readStreamRowCount();
            const stopHidden = !stopBtn || stopBtn.offsetParent === null || stopBtn.classList.contains('neo-hidden') || stopBtn.hidden || stopBtn.style.display === 'none';
            if (curRows > 0 && stopHidden) {
                break;
            }
            if (performance.now() - streamT0 > 90000) {
                streamTimedOut = true;
                break;
            }
            await sleep(80);
        }
    } finally {
        streamActive = false;
        document.removeEventListener('click', onStopClick, true);
        streamWorkers   = stopWorkerProbe();
        streamLtSummary = streamLongTasks.stop();
    }

    const streamWallMs    = +(performance.now() - streamT0).toFixed(2);
    const streamFrameSt   = stats(streamFrames);
    const streamRows      = readStreamRowCount();
    const streamCompleted = !streamTimedOut && !streamAborted && streamRows >= EXPECTED_FULL_STREAM_ROWS;

    const initialStreamSummary = {
        completed         : streamCompleted,
        aborted           : streamAborted,
        timedOut          : streamTimedOut,
        expectedRows      : EXPECTED_FULL_STREAM_ROWS,
        streamWallMs,
        rows              : streamRows,
        frameP95Ms        : streamFrameSt.p95,
        frameP99Ms        : streamFrameSt.p99,
        maxRafMs          : streamFrameSt.max,
        longFrames50      : streamFrames.filter(d => d > 50).length,
        longTasks         : streamLtSummary,
        flightsPerSec     : streamWorkers.flightsPerSec,
        nonEmptyDomFlights: streamWorkers.nonEmptyDomFlights,
        vnodeRelays       : streamWorkers.vnodeRelayMessages
    };

    statusEl.textContent = `Ready (${streamRows} rows in ${streamWallMs}ms · frame p95 ${streamFrameSt.p95}ms · relays ${streamWorkers.vnodeRelayMessages}). Tap Run Page or ${defaultPairs * 2}p AB/BA.`;
    runBtn.disabled    = false;
    seriesBtn.disabled = false;

    let lastMarkdown = '';
    let lastResult   = null;
    let pageRunCount = 0;

    async function runBenchmarkSuite(opts = {}) {
        const chosenPreset             = opts.preset || presetEl.value || '1x1';
        const [presetRows, presetCols] = chosenPreset.split('x').map(Number);
        const bufferRows               = opts.bufferRows ?? presetRows;
        const bufferCols               = opts.bufferCols ?? presetCols;
        const resolvedPreset           = `${bufferRows}x${bufferCols}`;

        runBtn.disabled         = true;
        seriesBtn.disabled      = true;
        copyBtn.disabled        = true;
        hud.classList.add('is-collapsed');
        collapseBtn.textContent = '+';

        const suiteLongTasks = createLongTaskTracker();
        let activeTracker    = null;

        try {
            const liveRowsBeforeSuite = readStreamRowCount();
            if ((!initialStreamSummary.completed || liveRowsBeforeSuite < EXPECTED_FULL_STREAM_ROWS) && !opts.allowIncompleteStream) {
                throw new Error(`Incomplete 50k stream (${liveRowsBeforeSuite}/${EXPECTED_FULL_STREAM_ROWS} rows, completed=${initialStreamSummary.completed})`);
            }

            statusEl.textContent = `Applying Buffer ${bufferRows}×${bufferCols}...`;
            await applyBufferPresetAndPrimeSearchTab(bufferRows, bufferCols);

            const vScroller = document.querySelector('.neo-grid-view');
            const hScroller = document.querySelector('.neo-grid-horizontal-scrollbar');
            const gridBody  = document.querySelector('.neo-grid-body');
            const gridRole  = document.querySelector('[role="grid"]');
            const rowHeight = 50;
            const viewRect  = vScroller.getBoundingClientRect();

            vScroller.scrollTop = 40 * rowHeight;
            if (hScroller) hScroller.scrollLeft = Math.min(400, Math.max(0, hScroller.scrollWidth - hScroller.clientWidth));
            await sleep(250);

            const mountedRows     = gridBody.querySelectorAll('.neo-grid-row').length;
            const mountedCells    = gridBody.querySelectorAll('.neo-grid-cell').length;
            const mountedCanvases = gridBody.querySelectorAll('canvas').length;
            const mountedDomNodes = gridBody.querySelectorAll('*').length;

            // 1. n = 20 Discrete Render-Gated 2D Diagonal Scroll Hops (verifying both vertical row & target horizontal column window)
            const maxLeft = Math.max(0, (hScroller?.scrollWidth || 0) - (hScroller?.clientWidth || 0));
            const hops20  = [
                { rowId: 1000,  leftFrac: 0.15 },
                { rowId: 3500,  leftFrac: 0.35 },
                { rowId: 6000,  leftFrac: 0.55 },
                { rowId: 9000,  leftFrac: 0.75 },
                { rowId: 12000, leftFrac: 0.95 },
                { rowId: 16000, leftFrac: 0.70 },
                { rowId: 20000, leftFrac: 0.45 },
                { rowId: 24000, leftFrac: 0.20 },
                { rowId: 28000, leftFrac: 0.00 },
                { rowId: 32000, leftFrac: 0.30 },
                { rowId: 36000, leftFrac: 0.60 },
                { rowId: 40000, leftFrac: 0.85 },
                { rowId: 44000, leftFrac: 1.00 },
                { rowId: 47000, leftFrac: 0.65 },
                { rowId: 41000, leftFrac: 0.35 },
                { rowId: 33000, leftFrac: 0.10 },
                { rowId: 25000, leftFrac: 0.50 },
                { rowId: 17000, leftFrac: 0.80 },
                { rowId: 8000,  leftFrac: 0.40 },
                { rowId: 40,    leftFrac: 0.00 }
            ];

            const hopTvs       = [];
            const hopMaxRaf    = [];
            const allHopFrames = [];
            let scroll20Workers;

            startWorkerProbe();
            try {
                for (let i = 0; i < hops20.length; i++) {
                    const hop        = hops20[i];
                    const targetTop  = hop.rowId * rowHeight;
                    const targetLeft = Math.round(maxLeft * hop.leftFrac);
                    const probe      = await measureProbe(`hop-${i + 1}`, () => {
                        vScroller.scrollTop = targetTop;
                        if (hScroller) hScroller.scrollLeft = targetLeft;
                    }, () => is2dHopRendered({
                        rowId: hop.rowId,
                        targetLeft,
                        maxLeft,
                        vScroller,
                        hScroller,
                        gridBody
                    }));
                    hopTvs.push(probe.tvsMs);
                    hopMaxRaf.push(probe.maxRafDeltaMs);
                    allHopFrames.push(...probe.frameDeltas);
                    await sleep(30);
                }
            } finally {
                scroll20Workers = stopWorkerProbe();
            }

            // 2. Sustained 60-step Continuous 2D Scroll Sweep (with per-rAF blank-frame detector)
            let sweepSummary;
            let sweepWorkers;
            startWorkerProbe();
            activeTracker = createFrameAndBlankTracker(vScroller, gridBody);
            try {
                for (let s = 1; s <= 60; s++) {
                    const frac = s <= 30 ? (s / 30) : ((60 - s) / 30);
                    vScroller.scrollTop = Math.round(frac * 25000 * rowHeight);
                    if (hScroller) hScroller.scrollLeft = Math.round(frac * maxLeft);
                    await sleep(20);
                }
                await sleep(100);
            } finally {
                sweepSummary  = activeTracker.stop();
                activeTracker = null;
                sweepWorkers  = stopWorkerProbe();
            }

            // 3. Real GridDragScroll Diagonal Drag + Kinetic Fling (requiring 2D travel when maxLeft >= 40)
            const gridDragFling = opts.skipDragFling === true
                ? { available: false, unavailableReason: 'skipped', inputMode: 'none', expectsHorizontal: maxLeft >= 40, deliveredMoves: 0, fps: null, frameP50Ms: null, frameP95Ms: null, frameP99Ms: null, maxRafMs: null, longFrames50: null, blankFrames: null, blankMs: null, maxBlankStreakMs: null, minVisibleRows: 0, minVisibleCells: 0, peakScrollDeltaTop: 0, peakScrollDeltaLeft: 0, totalTravelTop: 0, totalTravelLeft: 0, workers: stopWorkerProbe() }
                : await runGridDragScrollStrokes(vScroller, hScroller, gridBody);

            vScroller.scrollTop = 0;
            if (hScroller) hScroller.scrollLeft = 0;
            await sleep(200);

            // 4. 50,000-Record Column Re-Sorts (1 untimed warm-up sort per column excluded; multi-row + aria-sort witness)
            if (hScroller && window.innerWidth < 600) {
                hScroller.scrollLeft = 220;
                await sleep(150);
            }

            const getHeaderBtn = (txt) => {
                const btn = Array.from(document.querySelectorAll('.neo-grid-header-button')).find(b => b.textContent.trim() === txt);
                if (!btn) throw new Error(`Header "${txt}" not found`);
                return btn;
            };

            const runSortStep = async (stepName, headerText) => {
                if (hScroller && window.innerWidth < 600) {
                    hScroller.scrollLeft = 220;
                    await sleep(60);
                }
                const headerBtn   = getHeaderBtn(headerText);
                const prevSortDir = getHeaderSortDirection(headerBtn);
                const prevRowsSig = getMountedRowsSignature(gridBody);
                const isHeaderDone = () => {
                    const curSortDir = getHeaderSortDirection(headerBtn);
                    const maskBusy   = Boolean(document.querySelector('.neo-load-mask:not(.neo-hidden)'));
                    return !maskBusy && curSortDir !== 'none' && curSortDir !== prevSortDir;
                };
                return measureProbe(stepName, () => {
                    headerBtn.click();
                }, () => {
                    const curRowsSig = getMountedRowsSignature(gridBody);
                    return isHeaderDone() && Boolean(curRowsSig) && curRowsSig !== prevRowsSig;
                }, {
                    quiescentCondition: isHeaderDone
                });
            };

            const warmupTargets = ['Commits %', 'Total'];
            const warmupTvs     = [];
            for (let w = 0; w < warmupTargets.length; w++) {
                const warmProbe = await runSortStep(`warmup-sort-${w + 1}`, warmupTargets[w]);
                warmupTvs.push(warmProbe.tvsMs);
                await sleep(60);
            }

            const sortTvs          = [];
            const sortMaxRaf       = [];
            let sortLongFrames50   = 0;
            const sortTargets      = ['Commits %', 'Total', 'Commits %', 'Total', 'Commits %', 'Total'];
            let sortWorkers;

            startWorkerProbe();
            try {
                for (let i = 0; i < sortTargets.length; i++) {
                    const probe = await runSortStep(`sort-${i + 1}`, sortTargets[i]);
                    sortTvs.push(probe.tvsMs);
                    sortMaxRaf.push(probe.maxRafDeltaMs);
                    sortLongFrames50 += (probe.longFrames50 || 0);
                    await sleep(60);
                }
            } finally {
                sortWorkers = stopWorkerProbe();
            }
            if (hScroller) hScroller.scrollLeft = 0;
            await sleep(120);

            // 5. 50,000-Record Structural Rank-Filter Toggles (1 untimed warm-up cycle excluded; 4 timed toggles)
            const runFilterToggle = async (stepName, checkboxLabelText) => {
                const inputEl     = findFilterCheckboxLabel(checkboxLabelText);
                const prevCount   = Number(gridRole?.getAttribute('aria-rowcount') || 0);
                const prevRowsSig = getMountedRowsSignature(gridBody);
                const isCountDone = () => {
                    const curCount = Number(gridRole?.getAttribute('aria-rowcount') || 0);
                    const maskBusy = Boolean(document.querySelector('.neo-load-mask:not(.neo-hidden)'));
                    return !maskBusy && curCount > 0 && curCount !== prevCount;
                };
                return measureProbe(stepName, () => {
                    inputEl.click();
                }, () => {
                    const curSig = getMountedRowsSignature(gridBody);
                    return isCountDone() && Boolean(curSig) && curSig !== prevRowsSig;
                }, {
                    quiescentCondition: isCountDone
                });
            };

            const filterWarmupTvs = [];
            for (let fw = 0; fw < 2; fw++) {
                const wp = await runFilterToggle(`warmup-filter-${fw + 1}`, 'Hireable Only');
                filterWarmupTvs.push(wp.tvsMs);
                await sleep(60);
            }

            const filterTvs        = [];
            const filterMaxRaf     = [];
            let filterLongFrames50 = 0;
            const filterTargets    = ['Hireable Only', 'Hireable Only', 'Hide Commit Ratio > 90%', 'Hide Commit Ratio > 90%'];
            let filterWorkers;

            startWorkerProbe();
            try {
                for (let f = 0; f < filterTargets.length; f++) {
                    const fp = await runFilterToggle(`filter-${f + 1}`, filterTargets[f]);
                    filterTvs.push(fp.tvsMs);
                    filterMaxRaf.push(fp.maxRafDeltaMs);
                    filterLongFrames50 += (fp.longFrames50 || 0);
                    await sleep(60);
                }
            } finally {
                filterWorkers = stopWorkerProbe();
            }

            const longTaskSummary = suiteLongTasks.stop();
            const topo            = getTopology();
            const hopStats        = stats(hopTvs);
            const hopFrameSt      = stats(allHopFrames);
            const sortStats       = stats(sortTvs);
            const filterStats     = stats(filterTvs);
            pageRunCount++;

            lastResult = {
                timestamp  : new Date().toISOString(),
                preset     : resolvedPreset,
                runIndexInDocument: pageRunCount,
                topology   : topo,
                visibility : {
                    state       : document.visibilityState,
                    hiddenEvents: visibilityHiddenEvents
                },
                device: {
                    viewport           : `${window.innerWidth}x${window.innerHeight}`,
                    gridViewport       : `${Math.round(viewRect.width)}x${Math.round(viewRect.height)}`,
                    dpr                : window.devicePixelRatio,
                    hardwareConcurrency: navigator.hardwareConcurrency || null,
                    userAgent          : navigator.userAgent
                },
                buffer       : { bufferRows, bufferCols, mountedRows, mountedCells, mountedCanvases, mountedDomNodes },
                longTasks    : longTaskSummary,
                initialStream: initialStreamSummary,
                scroll20Hops : {
                    tvs         : hopStats,
                    frameP95Ms  : hopFrameSt.p95,
                    frameP99Ms  : hopFrameSt.p99,
                    maxRafMs    : +(Math.max(...hopMaxRaf)).toFixed(2),
                    longFrames50: allHopFrames.filter(d => d > 50).length,
                    workers     : scroll20Workers
                },
                sustainedSweep60: {
                    ...sweepSummary,
                    workers: sweepWorkers
                },
                gridDragFling,
                sort50k: {
                    warmupTvs,
                    tvs         : sortStats,
                    maxRafMs    : +(Math.max(...sortMaxRaf)).toFixed(2),
                    longFrames50: sortLongFrames50,
                    workers     : sortWorkers
                },
                filter50k: {
                    warmupTvs   : filterWarmupTvs,
                    tvs         : filterStats,
                    maxRafMs    : +(Math.max(...filterMaxRaf)).toFixed(2),
                    longFrames50: filterLongFrames50,
                    workers     : filterWorkers
                }
            };

            const ltText = longTaskSummary.supported
                ? `count \`${longTaskSummary.count}\`, max \`${longTaskSummary.maxMs} ms\``
                : `unsupported in engine (see rAF \`>50ms\` counts)`;

            lastMarkdown = [
                `### DevIndex Benchmark — \`Arm ${topo.armKey}\` (\`build=${topo.buildLabel}\`, \`useVdomWorker=${topo.useVdomWorker}\`, \`vdom=${topo.hasVdomWorker}\`, \`preset=${resolvedPreset}\`)`,
                `- **Device:** \`${lastResult.device.viewport}\` (grid \`${lastResult.device.gridViewport}\`) @ \`${lastResult.device.dpr}x\` · cores=\`${lastResult.device.hardwareConcurrency}\` · Buffer=\`${bufferRows}x${bufferCols}\` (\`${mountedRows}\` rows, \`${mountedCells}\` cells, \`${mountedCanvases}\` canvases, \`${mountedDomNodes}\` DOM nodes) · hiddenEvents=\`${visibilityHiddenEvents}\` · LongTasks: ${ltText}`,
                `- **50k Stream-In (complete=${initialStreamSummary.completed}):** \`${initialStreamSummary.streamWallMs} ms\` · frame p95 \`${initialStreamSummary.frameP95Ms} ms\` · p99 \`${initialStreamSummary.frameP99Ms} ms\` · maxRAF \`${initialStreamSummary.maxRafMs} ms\` · spikes>50ms \`${initialStreamSummary.longFrames50}\` · nonEmptyFlights \`${initialStreamSummary.nonEmptyDomFlights}\` · vnodeRelays \`${initialStreamSummary.vnodeRelays}\``,
                `- **2D Scroll (n=20 2D-verified hops):** mean \`${hopStats.mean} ± ${hopStats.sd} ms\` (95% CI \`±${hopStats.ci95Half}\`) · p50 \`${hopStats.p50} ms\` · **p95 \`${hopStats.p95} ms\`** · **p99 \`${hopStats.p99} ms\`** · max \`${hopStats.max} ms\` · maxRAF \`${lastResult.scroll20Hops.maxRafMs} ms\` · spikes>50ms \`${lastResult.scroll20Hops.longFrames50}\` · nonEmptyFlights \`${scroll20Workers.nonEmptyDomFlights}\` · relays \`${scroll20Workers.vnodeRelayMessages}\``,
                `  - raw hops: \`[${hopStats.raw.join(', ')}]\``,
                `- **Sustained 60-Step Sweep:** FPS \`${sweepSummary.fps}\` · frame p50 \`${sweepSummary.frameP50Ms} ms\` · **frame p95 \`${sweepSummary.frameP95Ms} ms\`** · **p99 \`${sweepSummary.frameP99Ms} ms\`** · maxRAF \`${sweepSummary.maxRafMs} ms\` · spikes>50ms \`${sweepSummary.longFrames50}\` · **blankFrames \`${sweepSummary.blankFrames}\` (\`${sweepSummary.blankMs} ms\`, maxStreak \`${sweepSummary.maxBlankStreakMs} ms\`)** · nonEmptyFlights \`${sweepWorkers.nonEmptyDomFlights}\``,
                gridDragFling.available
                    ? `- **GridDragScroll 2D Fling (${gridDragFling.inputMode}):** FPS \`${gridDragFling.fps}\` · **frame p95 \`${gridDragFling.frameP95Ms} ms\`** · **p99 \`${gridDragFling.frameP99Ms} ms\`** · maxRAF \`${gridDragFling.maxRafMs} ms\` · spikes>50ms \`${gridDragFling.longFrames50}\` · **blankFrames \`${gridDragFling.blankFrames}\` (\`${gridDragFling.blankMs} ms\`, maxStreak \`${gridDragFling.maxBlankStreakMs} ms\`)** · moved \`${gridDragFling.peakScrollDeltaTop}px × ${gridDragFling.peakScrollDeltaLeft}px\` (total \`${gridDragFling.totalTravelTop}px × ${gridDragFling.totalTravelLeft}px\`, moves \`${gridDragFling.deliveredMoves}\`) · nonEmptyFlights \`${gridDragFling.workers.nonEmptyDomFlights}\` · relays \`${gridDragFling.workers.vnodeRelayMessages}\``
                    : `- **GridDragScroll 2D Fling (${gridDragFling.inputMode}):** \`UNAVAILABLE (${gridDragFling.unavailableReason}: moved ${gridDragFling.peakScrollDeltaTop}px × ${gridDragFling.peakScrollDeltaLeft}px)\` — excluded from fling aggregates; run manual visual swipe for canvas/blanking`,
                `- **50k Re-Sort (n=6 warm, 1/col warm-up excluded):** mean \`${sortStats.mean} ± ${sortStats.sd} ms\` (95% CI \`±${sortStats.ci95Half}\`) · p50 \`${sortStats.p50} ms\` · p95 \`${sortStats.p95} ms\` · p99 \`${sortStats.p99} ms\` · max \`${sortStats.max} ms\` · maxRAF \`${lastResult.sort50k.maxRafMs} ms\``,
                `  - raw sorts: \`[${sortStats.raw.join(', ')}]\` (excluded warm-up: \`[${warmupTvs.join(', ')}]\`)`,
                `- **50k Rank-Filter (n=4 warm toggles, 1 cycle warm-up excluded):** mean \`${filterStats.mean} ± ${filterStats.sd} ms\` (95% CI \`±${filterStats.ci95Half}\`) · p50 \`${filterStats.p50} ms\` · p95 \`${filterStats.p95} ms\` · p99 \`${filterStats.p99} ms\` · max \`${filterStats.max} ms\` · maxRAF \`${lastResult.filter50k.maxRafMs} ms\` · nonEmptyFlights \`${filterWorkers.nonEmptyDomFlights}\``,
                `  - raw rank-filters: \`[${filterStats.raw.join(', ')}]\` (excluded warm-up: \`[${filterWarmupTvs.join(', ')}]\`)`
            ].join('\n');

            hud.classList.remove('is-collapsed');
            collapseBtn.textContent = '–';
            outputEl.hidden         = false;
            outputEl.textContent    = lastMarkdown;
            const flingStatus = gridDragFling.available
                ? `DragFling(${gridDragFling.inputMode}) moved=${gridDragFling.peakScrollDeltaTop}x${gridDragFling.peakScrollDeltaLeft}px blank=${gridDragFling.blankFrames}`
                : `DragFling(${gridDragFling.inputMode})=UNAVAILABLE(${gridDragFling.unavailableReason})`;
            statusEl.textContent = `Done! Grid=${lastResult.device.gridViewport}, Scroll p95=${hopStats.p95}ms, ${flingStatus}, Sort=${sortStats.mean}ms, Filter=${filterStats.mean}ms.`;
            copyBtn.disabled     = false;
            return lastResult;
        } catch (err) {
            activeTracker?.stop();
            suiteLongTasks.stop();
            stopWorkerProbe();
            hud.classList.remove('is-collapsed');
            collapseBtn.textContent = '–';
            statusEl.textContent    = `Error: ${err?.message || err}`;
            throw err;
        } finally {
            activeTracker?.stop();
            suiteLongTasks.stop();
            stopWorkerProbe();
            runBtn.disabled    = false;
            seriesBtn.disabled = false;
        }
    }

    async function continueSeriesIfActive() {
        let series = null;
        try {
            series = JSON.parse(sessionStorage.getItem(SERIES_STORAGE_KEY) || 'null');
        } catch {
            series = null;
        }
        if (!series?.active || !Array.isArray(series.plan)) return;

        const idx = series.results.length;
        if (idx >= series.plan.length) {
            series.active = false;
            sessionStorage.setItem(SERIES_STORAGE_KEY, JSON.stringify(series));
            lastMarkdown         = formatSeriesMarkdown(series);
            outputEl.hidden      = false;
            outputEl.textContent = lastMarkdown;
            copyBtn.disabled     = false;
            statusEl.textContent = `Completed ${series.plan.length}-page AB/BA series! Tap Copy.`;
            return;
        }

        const expectedArm = series.plan[idx];
        const urlSlotRaw  = searchParams.get('seriesSlot');
        const urlSlot     = urlSlotRaw !== null ? Number(urlSlotRaw) : null;

        // Require a fresh navigation bound to the exact expected series slot and arm
        if (urlSlot !== idx || initialTopo.armKey !== expectedArm || pageRunCount > 0) {
            const nextUrl = new URL(buildArmUrl(expectedArm, series.preset));
            nextUrl.searchParams.set('autorunSeries', '1');
            nextUrl.searchParams.set('seriesSlot', String(idx));
            globalThis.location.assign(nextUrl.toString());
            return;
        }

        statusEl.textContent = `Running fresh AB/BA page ${idx + 1}/${series.plan.length} (Arm ${expectedArm})...`;
        const invalidReasons = [];
        const workerExpected = expectedArm !== 'B';
        let pageRes          = null;
        let suiteErr         = null;

        if (!initialStreamSummary.completed || (initialStreamSummary.rows || 0) < EXPECTED_FULL_STREAM_ROWS) {
            invalidReasons.push('incomplete-stream');
        } else {
            try {
                pageRes = await runBenchmarkSuite({ preset: series.preset });
            } catch (err) {
                suiteErr = err;
                invalidReasons.push('suite-rejected');
            }
        }

        if (!pageRes) {
            pageRes = {
                timestamp         : new Date().toISOString(),
                preset            : series.preset,
                runIndexInDocument: pageRunCount || 1,
                topology          : getTopology(),
                visibility        : {
                    state       : document.visibilityState,
                    hiddenEvents: visibilityHiddenEvents
                },
                initialStream: initialStreamSummary,
                error        : suiteErr ? String(suiteErr.message || suiteErr) : 'incomplete-stream'
            };
        }

        if (pageRes.topology.armKey !== expectedArm || pageRes.topology.useVdomWorker !== workerExpected || pageRes.topology.hasVdomWorker !== workerExpected) {
            invalidReasons.push('topology-mismatch');
        }
        if (pageRes.preset !== series.preset) {
            invalidReasons.push('preset-mismatch');
        }
        if (!pageRes.initialStream?.completed || (pageRes.initialStream?.rows || 0) < EXPECTED_FULL_STREAM_ROWS) {
            if (!invalidReasons.includes('incomplete-stream')) invalidReasons.push('incomplete-stream');
        }
        if ((pageRes.visibility?.hiddenEvents || 0) > 0 || pageRes.visibility?.state !== 'visible') {
            invalidReasons.push('page-hidden');
        }
        if (pageRes.runIndexInDocument !== 1) {
            invalidReasons.push('reused-document');
        }

        pageRes.planSlot       = idx;
        pageRes.planArm        = expectedArm;
        pageRes.sampleValid    = invalidReasons.length === 0 && Boolean(pageRes.scroll20Hops);
        pageRes.invalidReasons = invalidReasons;
        series.results.push(pageRes);

        if (series.results.length >= series.plan.length) {
            series.active = false;
            sessionStorage.setItem(SERIES_STORAGE_KEY, JSON.stringify(series));
            lastMarkdown         = formatSeriesMarkdown(series);
            outputEl.hidden      = false;
            outputEl.textContent = lastMarkdown;
            copyBtn.disabled     = false;
            const qualCount = series.results.filter(r => r.sampleValid !== false).length;
            statusEl.textContent = `Completed ${series.plan.length}-page AB/BA series (${qualCount}/${series.plan.length} qualifying)! Tap Copy.`;
            return;
        }

        sessionStorage.setItem(SERIES_STORAGE_KEY, JSON.stringify(series));
        const nextIdx = series.results.length;
        const nextArm = series.plan[nextIdx];
        statusEl.textContent = `Saved ${nextIdx}/${series.plan.length}; fresh navigation to Arm ${nextArm}...`;
        await sleep(220);
        const nextUrl = new URL(buildArmUrl(nextArm, series.preset));
        nextUrl.searchParams.set('autorunSeries', '1');
        nextUrl.searchParams.set('seriesSlot', String(nextIdx));
        globalThis.location.assign(nextUrl.toString());
    }

    runBtn.addEventListener('click', () => {
        sessionStorage.removeItem(SERIES_STORAGE_KEY);
        runBenchmarkSuite().catch(console.error);
    });

    seriesBtn.addEventListener('click', () => {
        const pairs  = defaultPairs;
        const preset = presetEl.value || '1x1';
        const plan   = [];
        for (let p = 0; p < pairs; p++) {
            plan.push(...(p % 2 === 0 ? ['A', 'B'] : ['B', 'A']));
        }
        const series = {
            active  : true,
            seriesId: Date.now().toString(36),
            preset,
            plan,
            results : []
        };
        sessionStorage.setItem(SERIES_STORAGE_KEY, JSON.stringify(series));
        // Always navigate fresh for sample 1 so prior Run Page state in the current document is never reused
        const nextUrl = new URL(buildArmUrl(plan[0], preset));
        nextUrl.searchParams.set('autorunSeries', '1');
        nextUrl.searchParams.set('seriesSlot', '0');
        globalThis.location.assign(nextUrl.toString());
    });

    copyBtn.addEventListener('click', async () => {
        if (!lastMarkdown) return;
        const ok = await copyTextWithFallback(lastMarkdown);
        copyBtn.textContent = ok ? 'Copied!' : 'Select Below';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
    });

    globalThis.__devindexBenchmark = {
        getTopology,
        evaluateRelativeThreshold,
        is2dHopRendered,
        getMountedRowsSignature,
        getHeaderSortDirection,
        readStreamRowCount,
        measureProbe,
        createLongTaskTracker,
        createFrameAndBlankTracker,
        runGridDragScrollStrokes,
        formatSeriesMarkdown,
        getInitialStreamSummary: () => initialStreamSummary,
        getLastResult          : () => lastResult,
        getLastMarkdown        : () => lastMarkdown,
        run                    : runBenchmarkSuite
    };

    if (searchParams.get('autorunSeries') === '1') {
        continueSeriesIfActive().catch(console.error);
    }
}

initDeviceBenchmarkHud().catch(err => console.error('[DevIndex Benchmark HUD]', err));
