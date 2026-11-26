/**
 * @summary Opt-in (`?bench=1`) Main-thread benchmark HUD for Desktop Playwright (`60Hz` / `120Hz`) and physical iPhone Mobile Safari.
 * Measures `50k` stream load, `n=20` 2D diagonal scroll TVS, sustained 60-step sweep + real `GridDragScroll` diagonal drag+fling
 * with per-`rAF` viewport blank-frame detection (`visibleRows === 0 || visibleCells === 0`), and warm-up-excluded `50k` re-sorts.
 */

const SERIES_STORAGE_KEY = '__devindex_bench_series_v2';

const stats = (arr) => {
    if (!arr?.length) {
        return { n: 0, mean: 0, sd: 0, ci95Half: 0, p50: 0, p95: 0, p99: 0, max: 0, min: 0, raw: [] };
    }
    const sorted = [...arr].sort((a, b) => a - b);
    const n      = sorted.length;
    const mean   = arr.reduce((s, x) => s + x, 0) / n;
    const sd     = n > 1 ? Math.sqrt(arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
    const tCrit  = n >= 30 ? 1.96 : n >= 20 ? 2.093 : n >= 10 ? 2.262 : 2.776;
    const ci95   = n > 1 ? tCrit * (sd / Math.sqrt(n)) : 0;
    const pct    = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
    const p50    = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

    return {
        n,
        mean    : +mean.toFixed(2),
        sd      : +sd.toFixed(2),
        ci95Half: +ci95.toFixed(2),
        p50     : +p50.toFixed(2),
        p95     : +pct(95).toFixed(2),
        p99     : +pct(99).toFixed(2),
        max     : +sorted[n - 1].toFixed(2),
        min     : +sorted[0].toFixed(2),
        raw     : arr.map(x => +Number(x).toFixed(2))
    };
};

const welchGainPct = (baseArr, armArr) => {
    if (!baseArr?.length || !armArr?.length) return null;
    const a    = stats(baseArr);
    const b    = stats(armArr);
    if (!a.mean) return null;
    const diff = a.mean - b.mean;
    const se   = Math.sqrt((a.sd ** 2) / Math.max(1, a.n) + (b.sd ** 2) / Math.max(1, b.n));
    const df   = Math.max(2, Math.min(a.n, b.n) - 1);
    const t    = df >= 20 ? 2.086 : df >= 9 ? 2.262 : 2.571;
    const pct  = (diff / a.mean) * 100;
    const half = ((t * se) / a.mean) * 100;
    return {
        pct  : +pct.toFixed(2),
        ciLow: +(pct - half).toFixed(2),
        ciHi : +(pct + half).toFixed(2)
    };
};

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

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
 * @summary Fast per-`rAF` viewport coverage check (`~25-35` rect reads max) detecting vertical or horizontal blank frames
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
        stop() {
            active = false;
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

function measureProbe(name, action, condition, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const frameDeltas = [];
        let lastFrame     = performance.now();
        let rafActive     = true;

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
            const tail = endTime - lastFrame;
            if (tail > 0) frameDeltas.push(tail);
            cleanup();
            resolve({
                tvsMs        : +(endTime - startTime).toFixed(2),
                maxRafDeltaMs: +(frameDeltas.length ? Math.max(...frameDeltas) : 0).toFixed(2),
                longFrames50 : frameDeltas.filter(d => d > 50).length,
                frameDeltas
            });
        };

        const observer = new MutationObserver(() => {
            try {
                if (condition()) finish(performance.now());
            } catch (err) {
                cleanup();
                reject(err);
            }
        });
        observer.observe(document.body, { attributes: true, childList: true, subtree: true });

        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Benchmark step timed out: ${name}`));
        }, timeout);

        const startTime = performance.now();
        lastFrame       = startTime;

        try {
            action();
            if (condition()) finish(performance.now());
        } catch (err) {
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
    const armKey        = isArmC ? 'C' : (useVdomWorker ? 'A' : 'B');
    const buildLabel    = globalThis.__NEO_BENCH_BUILD_LABEL || (isArmC ? 'v14-arm-c-22218' : 'v14-dev-ab');
    return { armKey, isArmC, buildLabel, useVdomWorker, hasVdomWorker };
}

/**
 * @summary Drives real `Neo.main.addon.GridDragScroll` (`mousedown` -> `115ms` hold -> diagonal `mousemove` strokes -> `mouseup`
 * kinetic `autoScroll` decay) while recording per-`rAF` viewport blanking and worker delta flights.
 */
async function runGridDragScrollStrokes(vScroller, hScroller, gridBody) {
    const rect   = vScroller.getBoundingClientRect();
    const startX = Math.round(rect.left + Math.min(rect.width * 0.72, rect.width - 24));
    const startY = Math.round(rect.top + Math.min(rect.height * 0.72, rect.height - 24));

    const maxLeft = Math.max(0, (hScroller?.scrollWidth || 0) - (hScroller?.clientWidth || 0));
    const dxStep  = -Math.max(18, Math.min(48, Math.round(maxLeft / 28) || 28));
    const dyStep  = -165;

    vScroller.scrollTop = 200;
    if (hScroller) hScroller.scrollLeft = 0;
    await sleep(160);

    const beforeTop  = vScroller.scrollTop;
    const beforeLeft = hScroller ? hScroller.scrollLeft : 0;

    startWorkerProbe();
    const tracker = createFrameAndBlankTracker(vScroller, gridBody);

    const runSingleStroke = async (dirSign) => {
        let cx = dirSign > 0 ? startX : Math.round(rect.left + Math.max(24, rect.width * 0.28));
        let cy = dirSign > 0 ? startY : Math.round(rect.top + Math.max(24, rect.height * 0.28));
        const targetEl = gridBody.querySelector('.neo-grid-row') || gridBody;

        targetEl.dispatchEvent(new MouseEvent('mousedown', {
            bubbles   : true,
            cancelable: true,
            composed  : true,
            button    : 0,
            buttons   : 1,
            clientX   : cx,
            clientY   : cy
        }));

        // Exceed GridDragScroll's 100ms delay gate before moving
        await sleep(115);

        for (let step = 0; step < 12; step++) {
            cx += dirSign * dxStep;
            cy += dirSign * dyStep;
            document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles   : true,
                cancelable: true,
                composed  : true,
                button    : 0,
                buttons   : 1,
                clientX   : cx,
                clientY   : cy
            }));
            await sleep(16);
        }

        document.dispatchEvent(new MouseEvent('mouseup', {
            bubbles   : true,
            cancelable: true,
            composed  : true,
            button    : 0,
            buttons   : 0,
            clientX   : cx,
            clientY   : cy
        }));

        // Wait for kinetic autoScroll decay to finish
        const tWait0    = performance.now();
        let stableCount = 0;
        let prevTop     = vScroller.scrollTop;
        let prevLeft    = hScroller ? hScroller.scrollLeft : 0;

        while (performance.now() - tWait0 < 3500) {
            await sleep(32);
            const curTop   = vScroller.scrollTop;
            const curLeft  = hScroller ? hScroller.scrollLeft : 0;
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
    };

    // Out-and-back diagonal drag+fling strokes
    await runSingleStroke(1);
    const peakTop  = vScroller.scrollTop;
    const peakLeft = hScroller ? hScroller.scrollLeft : 0;
    await runSingleStroke(-1);

    const frameSummary = tracker.stop();
    const workers      = stopWorkerProbe();

    return {
        ...frameSummary,
        peakScrollDeltaTop : Math.round(Math.abs(peakTop - beforeTop)),
        peakScrollDeltaLeft: Math.round(Math.abs(peakLeft - beforeLeft)),
        workers
    };
}

async function applyBufferPreset(bufferRows, bufferCols) {
    const controls     = document.querySelector('.devindex-controls-container');
    const wasCollapsed = controls && !controls.classList.contains('neo-expanded');

    const clickDrawerToggle = () => {
        const btns   = Array.from(document.querySelectorAll('button'));
        const toggle = btns.find(b => b.querySelector('.fa-bars, .fa-sliders')) ||
                       document.querySelector('.neo-header-toolbar button:last-of-type');
        if (toggle) toggle.click();
    };

    if (wasCollapsed) {
        clickDrawerToggle();
        await sleep(280);
    }

    const tabs        = Array.from(document.querySelectorAll('.neo-tab-header-button'));
    const settingsTab = tabs.find(b => b.textContent.includes('Settings'));
    if (settingsTab) {
        settingsTab.click();
        await sleep(200);
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
    await sleep(150);
    await selectCombo('Buffer Column Range', String(bufferCols));
    await sleep(200);

    // Restore drawer state so mobile & desktop viewports keep the full grid unobstructed
    if (wasCollapsed && controls?.classList.contains('neo-expanded')) {
        clickDrawerToggle();
        await sleep(280);
    }
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
    return u.toString();
}

function formatSeriesMarkdown(series) {
    const runsA = series.results.filter(r => r.topology.armKey === 'A');
    const runsB = series.results.filter(r => r.topology.armKey === 'B');
    const fmtMetric = (label, getter) => {
        const arrA = runsA.map(getter);
        const arrB = runsB.map(getter);
        const stA  = stats(arrA);
        const stB  = stats(arrB);
        const w    = welchGainPct(arrA, arrB);
        return `| ${label} | \`${stA.mean} ± ${stA.sd}\` (med \`${stA.p50}\`, max \`${stA.max}\`) | \`${stB.mean} ± ${stB.sd}\` (med \`${stB.p50}\`, max \`${stB.max}\`) | ${w ? `**\`${w.pct >= 0 ? '+' : ''}${w.pct}%\`** \`[${w.ciLow}%, ${w.ciHi}%]\`` : 'n/a'} |`;
    };
    const blankA = runsA.reduce((s, r) => s + (r.gridDragFling?.blankFrames || 0) + (r.sustainedSweep60?.blankFrames || 0), 0);
    const blankB = runsB.reduce((s, r) => s + (r.gridDragFling?.blankFrames || 0) + (r.sustainedSweep60?.blankFrames || 0), 0);
    const hid    = series.results.reduce((s, r) => s + (r.visibility?.hiddenEvents || 0), 0);

    return [
        `### DevIndex Same-Tab Counter-Balanced \`AB/BA\` Series (\`n=${runsA.length}\` A, \`n=${runsB.length}\` B · Preset \`${series.preset}\`)`,
        `- **Device:** \`${series.results[0]?.device?.viewport}\` @ \`${series.results[0]?.device?.dpr}x\` · Grid=\`${series.results[0]?.device?.gridViewport}\` · Canvases=\`${series.results[0]?.buffer?.mountedCanvases}\` · DOM=\`${series.results[0]?.buffer?.mountedDomNodes}\` · HiddenEvents=\`${hid}\``,
        `- **Total Blank Viewport Frames (Sweep + DragFling):** Arm A=\`${blankA}\` · Arm B=\`${blankB}\``,
        ``,
        `| Metric (Page-Level) | Arm A (\`VDom=true\`) | Arm B (\`VDom=false\`) | \`B vs A\` Welch \`95% CI\` |`,
        `|---|---|---|---|`,
        fmtMetric('50k Stream-In (ms)', r => r.initialStream.streamWallMs),
        fmtMetric('20-Hop Scroll Mean TVS (ms)', r => r.scroll20Hops.tvs.mean),
        fmtMetric('20-Hop Scroll p95 TVS (ms)', r => r.scroll20Hops.tvs.p95),
        fmtMetric('60-Step Sweep Frame p95 (ms)', r => r.sustainedSweep60.frameP95Ms),
        fmtMetric('GridDragScroll Fling Frame p95 (ms)', r => r.gridDragFling.frameP95Ms),
        fmtMetric('GridDragScroll Blank Time (ms)', r => r.gridDragFling.blankMs),
        fmtMetric('50k Warm Re-Sort Mean TVS (ms)', r => r.sort50k.tvs.mean),
        ``,
        `- **Raw Sort Means A:** \`[${runsA.map(r => r.sort50k.tvs.mean).join(', ')}]\``,
        `- **Raw Sort Means B:** \`[${runsB.map(r => r.sort50k.tvs.mean).join(', ')}]\``,
        `- **Raw Scroll p95 A:** \`[${runsA.map(r => r.scroll20Hops.tvs.p95).join(', ')}]\``,
        `- **Raw Scroll p95 B:** \`[${runsB.map(r => r.scroll20Hops.tvs.p95).join(', ')}]\``,
        `- **Raw DragFling BlankMs A / B:** \`[${runsA.map(r => r.gridDragFling.blankMs).join(', ')}]\` / \`[${runsB.map(r => r.gridDragFling.blankMs).join(', ')}]\``
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

    const searchParams  = new URLSearchParams(globalThis.location.search);
    const urlPreset     = ['1x1', '5x5', '25x15'].includes(searchParams.get('preset')) ? searchParams.get('preset') : '1x1';
    const initialTopo   = getTopology();
    const badgeClass    = initialTopo.armKey === 'C' ? 'is-arm-c' : (initialTopo.armKey === 'B' ? 'is-two-thread' : '');
    const badgeLabel    = initialTopo.armKey === 'C'
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
                <select class="devindex-bench-select" id="devindex-bench-preset" aria-label="Buffer preset">
                    <option value="1x1" ${urlPreset === '1x1' ? 'selected' : ''}>Buffer 1×1 (Primary)</option>
                    <option value="5x5" ${urlPreset === '5x5' ? 'selected' : ''}>Buffer 5×5 (Medium)</option>
                    <option value="25x15" ${urlPreset === '25x15' ? 'selected' : ''}>Buffer 25×15 (Stress)</option>
                </select>
                <button class="devindex-bench-btn is-primary" id="devindex-bench-run" type="button" disabled>Run Page</button>
                <button class="devindex-bench-btn is-accent" id="devindex-bench-series" type="button" disabled>10p AB/BA</button>
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

    // Reveal Arm C link automatically when /arm-c/ bundle is mounted on the server
    fetch('/arm-c/dist/production/apps/devindex/index.html', { method: 'HEAD' })
        .then(r => { if (r.ok) armCLink.hidden = false; })
        .catch(() => {});

    collapseBtn.addEventListener('click', () => {
        const collapsed = hud.classList.toggle('is-collapsed');
        collapseBtn.textContent = collapsed ? '+' : '–';
    });

    // Measure initial 50k stream-in automatically
    const streamT0     = performance.now();
    const streamFrames = [];
    let lastStreamRaf  = streamT0;
    let streamActive   = true;
    startWorkerProbe();

    function trackStreamRaf(now) {
        if (!streamActive) return;
        streamFrames.push(now - lastStreamRaf);
        lastStreamRaf = now;
        requestAnimationFrame(trackStreamRaf);
    }
    requestAnimationFrame(trackStreamRaf);

    while (true) {
        const stopBtn = document.querySelector('.devindex-stop-stream-button');
        const rows    = Number(document.querySelector('[role="grid"]')?.getAttribute('aria-rowcount') || 0);
        const hidden  = !stopBtn || stopBtn.offsetParent === null || stopBtn.classList.contains('neo-hidden') || stopBtn.style.display === 'none';
        if (rows >= 45000 && hidden) break;
        if (performance.now() - streamT0 > 90000) break;
        await sleep(80);
    }

    streamActive = false;
    const streamWallMs  = +(performance.now() - streamT0).toFixed(2);
    const streamWorkers = stopWorkerProbe();
    const streamFrameSt = stats(streamFrames);
    const streamRows    = Number(document.querySelector('[role="grid"]')?.getAttribute('aria-rowcount') || 0);

    const initialStreamSummary = {
        streamWallMs,
        rows              : streamRows,
        frameP95Ms        : streamFrameSt.p95,
        maxRafMs          : streamFrameSt.max,
        longFrames50      : streamFrames.filter(d => d > 50).length,
        flightsPerSec     : streamWorkers.flightsPerSec,
        nonEmptyDomFlights: streamWorkers.nonEmptyDomFlights,
        vnodeRelays       : streamWorkers.vnodeRelayMessages
    };

    statusEl.textContent = `Ready (${streamRows} rows in ${streamWallMs}ms · frame p95 ${streamFrameSt.p95}ms · relays ${streamWorkers.vnodeRelayMessages}). Tap Run Page or 10p AB/BA.`;
    runBtn.disabled    = false;
    seriesBtn.disabled = false;

    let lastMarkdown = '';
    let lastResult   = null;

    async function runBenchmarkSuite(opts = {}) {
        const [presetRows, presetCols] = (opts.preset || presetEl.value || '1x1').split('x').map(Number);
        const bufferRows = opts.bufferRows ?? presetRows;
        const bufferCols = opts.bufferCols ?? presetCols;

        runBtn.disabled    = true;
        seriesBtn.disabled = true;
        copyBtn.disabled   = true;
        hud.classList.add('is-collapsed');
        collapseBtn.textContent = '+';

        try {
            statusEl.textContent = `Applying Buffer ${bufferRows}×${bufferCols}...`;
            await applyBufferPreset(bufferRows, bufferCols);

            const vScroller = document.querySelector('.neo-grid-view');
            const hScroller = document.querySelector('.neo-grid-horizontal-scrollbar');
            const gridBody  = document.querySelector('.neo-grid-body');
            const rowHeight = 50;
            const viewRect  = vScroller.getBoundingClientRect();

            vScroller.scrollTop = 40 * rowHeight;
            if (hScroller) hScroller.scrollLeft = Math.min(400, Math.max(0, hScroller.scrollWidth - hScroller.clientWidth));
            await sleep(250);

            const mountedRows     = gridBody.querySelectorAll('.neo-grid-row').length;
            const mountedCells    = gridBody.querySelectorAll('.neo-grid-cell').length;
            const mountedCanvases = gridBody.querySelectorAll('canvas').length;
            const mountedDomNodes = gridBody.querySelectorAll('*').length;

            // 1. n = 20 Discrete Render-Gated 2D Diagonal Scroll Hops
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

            startWorkerProbe();
            for (let i = 0; i < hops20.length; i++) {
                const hop        = hops20[i];
                const targetTop  = hop.rowId * rowHeight;
                const targetLeft = Math.round(maxLeft * hop.leftFrac);
                const probe      = await measureProbe(`hop-${i + 1}`, () => {
                    vScroller.scrollTop = targetTop;
                    if (hScroller) hScroller.scrollLeft = targetLeft;
                }, () => {
                    const row = document.querySelector(`.neo-grid-row[data-row-id="${hop.rowId}"]`);
                    return Boolean(row && row.querySelector('.neo-grid-cell'));
                });
                hopTvs.push(probe.tvsMs);
                hopMaxRaf.push(probe.maxRafDeltaMs);
                allHopFrames.push(...probe.frameDeltas);
                await sleep(30);
            }
            const scroll20Workers = stopWorkerProbe();

            // 2. Sustained 60-step Continuous 2D Scroll Sweep (with per-rAF blank-frame detector)
            startWorkerProbe();
            const sweepTracker = createFrameAndBlankTracker(vScroller, gridBody);

            for (let s = 1; s <= 60; s++) {
                const frac = s <= 30 ? (s / 30) : ((60 - s) / 30);
                vScroller.scrollTop = Math.round(frac * 25000 * rowHeight);
                if (hScroller) hScroller.scrollLeft = Math.round(frac * maxLeft);
                await sleep(20);
            }
            await sleep(100);
            const sweepSummary = sweepTracker.stop();
            const sweepWorkers = stopWorkerProbe();

            // 3. Real GridDragScroll Diagonal Drag + Kinetic Fling (with per-rAF blank-frame detector)
            const gridDragFling = opts.skipDragFling === true
                ? { fps: 0, frameP50Ms: 0, frameP95Ms: 0, frameP99Ms: 0, maxRafMs: 0, longFrames50: 0, blankFrames: 0, blankMs: 0, maxBlankStreakMs: 0, minVisibleRows: 0, minVisibleCells: 0, peakScrollDeltaTop: 0, peakScrollDeltaLeft: 0, workers: stopWorkerProbe() }
                : await runGridDragScrollStrokes(vScroller, hScroller, gridBody);

            vScroller.scrollTop = 0;
            if (hScroller) hScroller.scrollLeft = 0;
            await sleep(200);

            // 4. 50,000-Record Column Re-Sorts (1 untimed warm-up sort per column excluded from timing)
            const getTopLogin = () => {
                const cell = document.querySelector('.neo-grid-row[data-row-id="0"] .neo-grid-cell[data-field="login"]');
                return cell ? cell.textContent.trim() : '';
            };

            if (hScroller && window.innerWidth < 600) {
                hScroller.scrollLeft = 220;
                await sleep(150);
            }

            const clickHeader = (txt) => {
                const btn = Array.from(document.querySelectorAll('.neo-grid-header-button')).find(b => b.textContent.trim() === txt);
                if (!btn) throw new Error(`Header "${txt}" not found`);
                btn.click();
            };

            const warmupTargets = ['Commits %', 'Total'];
            const warmupTvs     = [];
            for (let w = 0; w < warmupTargets.length; w++) {
                if (hScroller && window.innerWidth < 600) {
                    hScroller.scrollLeft = 220;
                    await sleep(60);
                }
                const prevLogin = getTopLogin();
                const warmProbe = await measureProbe(`warmup-sort-${w + 1}`, () => {
                    clickHeader(warmupTargets[w]);
                }, () => {
                    const cur = getTopLogin();
                    return Boolean(cur) && cur !== prevLogin;
                });
                warmupTvs.push(warmProbe.tvsMs);
                await sleep(60);
            }

            const sortTvs     = [];
            const sortMaxRaf  = [];
            const sortTargets = ['Commits %', 'Total', 'Commits %', 'Total', 'Commits %', 'Total'];

            startWorkerProbe();
            for (let i = 0; i < sortTargets.length; i++) {
                if (hScroller && window.innerWidth < 600) {
                    hScroller.scrollLeft = 220;
                    await sleep(60);
                }
                const prevLogin = getTopLogin();
                const probe     = await measureProbe(`sort-${i + 1}`, () => {
                    clickHeader(sortTargets[i]);
                }, () => {
                    const cur = getTopLogin();
                    return Boolean(cur) && cur !== prevLogin;
                });
                sortTvs.push(probe.tvsMs);
                sortMaxRaf.push(probe.maxRafDeltaMs);
                await sleep(60);
            }
            const sortWorkers = stopWorkerProbe();
            if (hScroller) hScroller.scrollLeft = 0;

            const topo       = getTopology();
            const hopStats   = stats(hopTvs);
            const hopFrameSt = stats(allHopFrames);
            const sortStats  = stats(sortTvs);

            lastResult = {
                timestamp : new Date().toISOString(),
                topology  : topo,
                visibility: {
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
                initialStream: initialStreamSummary,
                scroll20Hops : {
                    tvs       : hopStats,
                    frameP95Ms: hopFrameSt.p95,
                    maxRafMs  : +(Math.max(...hopMaxRaf)).toFixed(2),
                    workers   : scroll20Workers
                },
                sustainedSweep60: {
                    ...sweepSummary,
                    workers: sweepWorkers
                },
                gridDragFling,
                sort50k: {
                    warmupTvs,
                    tvs     : sortStats,
                    maxRafMs: +(Math.max(...sortMaxRaf)).toFixed(2),
                    workers : sortWorkers
                }
            };

            lastMarkdown = [
                `### DevIndex Benchmark — \`Arm ${topo.armKey}\` (\`build=${topo.buildLabel}\`, \`useVdomWorker=${topo.useVdomWorker}\`, \`vdom=${topo.hasVdomWorker}\`)`,
                `- **Device:** \`${lastResult.device.viewport}\` (grid \`${lastResult.device.gridViewport}\`) @ \`${lastResult.device.dpr}x\` · cores=\`${lastResult.device.hardwareConcurrency}\` · Buffer=\`${bufferRows}x${bufferCols}\` (\`${mountedRows}\` rows, \`${mountedCells}\` cells, \`${mountedCanvases}\` canvases, \`${mountedDomNodes}\` DOM nodes) · hiddenEvents=\`${visibilityHiddenEvents}\``,
                `- **50k Stream-In:** \`${initialStreamSummary.streamWallMs} ms\` · frame p95 \`${initialStreamSummary.frameP95Ms} ms\` · maxRAF \`${initialStreamSummary.maxRafMs} ms\` · nonEmptyFlights \`${initialStreamSummary.nonEmptyDomFlights}\` · vnodeRelays \`${initialStreamSummary.vnodeRelays}\``,
                `- **2D Scroll (n=20 hops):** mean \`${hopStats.mean} ± ${hopStats.sd} ms\` (95% CI \`±${hopStats.ci95Half}\`) · p50 \`${hopStats.p50} ms\` · **p95 \`${hopStats.p95} ms\`** · p99 \`${hopStats.p99} ms\` · max \`${hopStats.max} ms\` · nonEmptyFlights \`${scroll20Workers.nonEmptyDomFlights}\` · relays \`${scroll20Workers.vnodeRelays}\``,
                `  - raw hops: \`[${hopStats.raw.join(', ')}]\``,
                `- **Sustained 60-Step Sweep:** FPS \`${sweepSummary.fps}\` · frame p50 \`${sweepSummary.frameP50Ms} ms\` · **frame p95 \`${sweepSummary.frameP95Ms} ms\`** · maxRAF \`${sweepSummary.maxRafMs} ms\` · **blankFrames \`${sweepSummary.blankFrames}\` (\`${sweepSummary.blankMs} ms\`, maxStreak \`${sweepSummary.maxBlankStreakMs} ms\`)** · nonEmptyFlights \`${sweepWorkers.nonEmptyDomFlights}\``,
                `- **GridDragScroll 2D Fling:** FPS \`${gridDragFling.fps}\` · **frame p95 \`${gridDragFling.frameP95Ms} ms\`** · maxRAF \`${gridDragFling.maxRafMs} ms\` · **blankFrames \`${gridDragFling.blankFrames}\` (\`${gridDragFling.blankMs} ms\`, maxStreak \`${gridDragFling.maxBlankStreakMs} ms\`)** · moved \`${gridDragFling.peakScrollDeltaTop}px × ${gridDragFling.peakScrollDeltaLeft}px\` · nonEmptyFlights \`${gridDragFling.workers.nonEmptyDomFlights}\``,
                `- **50k Re-Sort (n=6 warm, 1/col warm-up excluded):** mean \`${sortStats.mean} ± ${sortStats.sd} ms\` (95% CI \`±${sortStats.ci95Half}\`) · p50 \`${sortStats.p50} ms\` · p95 \`${sortStats.p95} ms\` · max \`${sortStats.max} ms\` · maxRAF \`${lastResult.sort50k.maxRafMs} ms\``,
                `  - raw sorts: \`[${sortStats.raw.join(', ')}]\` (excluded warm-up: \`[${warmupTvs.join(', ')}]\`)`
            ].join('\n');

            hud.classList.remove('is-collapsed');
            collapseBtn.textContent = '–';
            outputEl.hidden         = false;
            outputEl.textContent    = lastMarkdown;
            statusEl.textContent    = `Done! Grid=${lastResult.device.gridViewport}, Scroll p95=${hopStats.p95}ms, DragFling blank=${gridDragFling.blankFrames} (${gridDragFling.blankMs}ms), Sort=${sortStats.mean}ms.`;
            copyBtn.disabled        = false;
            return lastResult;
        } catch (err) {
            hud.classList.remove('is-collapsed');
            collapseBtn.textContent = '–';
            statusEl.textContent    = `Error: ${err?.message || err}`;
            throw err;
        } finally {
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

        statusEl.textContent = `Running AB/BA page ${idx + 1}/${series.plan.length} (Arm ${initialTopo.armKey})...`;
        const pageRes = await runBenchmarkSuite({ preset: series.preset });
        series.results.push(pageRes);

        if (series.results.length >= series.plan.length) {
            series.active = false;
            sessionStorage.setItem(SERIES_STORAGE_KEY, JSON.stringify(series));
            lastMarkdown         = formatSeriesMarkdown(series);
            outputEl.hidden      = false;
            outputEl.textContent = lastMarkdown;
            copyBtn.disabled     = false;
            statusEl.textContent = `Completed ${series.plan.length}-page AB/BA series! Tap Copy.`;
            return;
        }

        sessionStorage.setItem(SERIES_STORAGE_KEY, JSON.stringify(series));
        const nextArm = series.plan[series.results.length];
        statusEl.textContent = `Saved ${series.results.length}/${series.plan.length}; navigating to Arm ${nextArm}...`;
        await sleep(250);
        const nextUrl = new URL(buildArmUrl(nextArm, series.preset));
        nextUrl.searchParams.set('autorunSeries', '1');
        globalThis.location.assign(nextUrl.toString());
    }

    runBtn.addEventListener('click', () => {
        sessionStorage.removeItem(SERIES_STORAGE_KEY);
        runBenchmarkSuite().catch(console.error);
    });

    seriesBtn.addEventListener('click', async () => {
        const pairs  = Math.max(2, Number(searchParams.get('pairs')) || 5);
        const preset = presetEl.value || '1x1';
        const plan   = [];
        for (let p = 0; p < pairs; p++) {
            plan.push(...(p % 2 === 0 ? ['A', 'B'] : ['B', 'A']));
        }
        const series = { active: true, preset, plan, results: [] };
        sessionStorage.setItem(SERIES_STORAGE_KEY, JSON.stringify(series));
        if (initialTopo.armKey !== plan[0]) {
            const nextUrl = new URL(buildArmUrl(plan[0], preset));
            nextUrl.searchParams.set('autorunSeries', '1');
            globalThis.location.assign(nextUrl.toString());
            return;
        }
        await continueSeriesIfActive();
    });

    copyBtn.addEventListener('click', async () => {
        if (!lastMarkdown) return;
        const ok = await copyTextWithFallback(lastMarkdown);
        copyBtn.textContent = ok ? 'Copied!' : 'Select Below';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
    });

    globalThis.__devindexBenchmark = {
        getTopology,
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
