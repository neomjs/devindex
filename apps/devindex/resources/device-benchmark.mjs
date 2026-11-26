/**
 * @summary Opt-in (`?bench=1`) Main-thread benchmark HUD for Desktop Playwright and physical iPhone Mobile Safari.
 * Measures `50k` stream load, `n=20` 2D diagonal scroll TVS + frame p95/maxRAF, sustained scroll FPS, and `50k` sort/rank-filter ops.
 */

const stats = (arr) => {
    if (!arr?.length) {
        return { n: 0, mean: 0, sd: 0, ci95Half: 0, p50: 0, p95: 0, p99: 0, max: 0, min: 0, raw: [] };
    }
    const sorted = [...arr].sort((a, b) => a - b);
    const n      = arr.length;
    const mean   = arr.reduce((s, x) => s + x, 0) / n;
    const sd     = n > 1 ? Math.sqrt(arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
    const tCrit  = n >= 30 ? 1.96 : n >= 20 ? 2.093 : 2.262;
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
                    const deltas = data?.action === 'updateVdom' ? data.deltas : payload?.deltas;
                    if (Array.isArray(deltas)) state.totalDeltas += deltas.length;
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
        totalDeltas       : 0,
        vnodeRelayMessages: 0
    };
}

function stopWorkerProbe() {
    const manager = ensureProbeInstalled();
    const state   = manager?.__devindexProbeState;
    if (manager) manager.__devindexProbeState = null;
    if (!state) {
        return { elapsedMs: 0, totalMainWorkerMessages: 0, domUpdateFlights: 0, flightsPerSec: 0, totalDeltas: 0, vnodeRelayMessages: 0 };
    }
    const elapsedMs = Math.max(1, performance.now() - state.startTime);
    return {
        elapsedMs              : +elapsedMs.toFixed(2),
        inboundMessages        : state.inboundMessages,
        outboundMessages       : state.outboundMessages,
        totalMainWorkerMessages: state.inboundMessages + state.outboundMessages,
        domUpdateFlights       : state.domUpdateFlights,
        flightsPerSec          : +(state.domUpdateFlights / (elapsedMs / 1000)).toFixed(2),
        totalDeltas            : state.totalDeltas,
        vnodeRelayMessages     : state.vnodeRelayMessages
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
    const useVdomWorker = Boolean(globalThis.Neo?.config?.useVdomWorker);
    const hasVdomWorker = Boolean(
        globalThis.Neo?.worker?.Manager?.getWorker?.('vdom') ||
        globalThis.Neo?.worker?.Manager?.workers?.vdom?.worker
    );
    return { useVdomWorker, hasVdomWorker };
}

async function applyBufferPreset(bufferRows, bufferCols) {
    const controls      = document.querySelector('.devindex-controls-container');
    const wasCollapsed  = controls && !controls.classList.contains('neo-expanded');

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

    // Restore drawer state so mobile viewports keep the full grid unobstructed during scrolling
    if (wasCollapsed && controls?.classList.contains('neo-expanded')) {
        clickDrawerToggle();
        await sleep(260);
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

async function initDeviceBenchmarkHud() {
    const cssHref = new URL('./device-benchmark.css', import.meta.url).href;
    const link    = document.createElement('link');
    link.rel      = 'stylesheet';
    link.href     = cssHref;
    document.head.appendChild(link);

    while (!document.querySelector('[role="grid"]') || !globalThis.Neo?.worker?.Manager) {
        await sleep(50);
    }

    const initialTopo = getTopology();
    const otherArmUrl = new URL(globalThis.location.href);
    otherArmUrl.searchParams.set('bench', '1');
    otherArmUrl.searchParams.set('useVdomWorker', String(!initialTopo.useVdomWorker));

    const hud = document.createElement('section');
    hud.className = 'devindex-bench-hud';
    hud.innerHTML = `
        <div class="devindex-bench-header">
            <span class="devindex-bench-badge ${initialTopo.useVdomWorker ? '' : 'is-two-thread'}" id="devindex-bench-arm">
                useVdomWorker=${initialTopo.useVdomWorker} (vdom=${initialTopo.hasVdomWorker})
            </span>
            <div>
                <a class="devindex-bench-link" href="${otherArmUrl.toString()}" target="_blank" rel="noopener">Open ${!initialTopo.useVdomWorker} tab</a>
                <button class="devindex-bench-btn" id="devindex-bench-collapse" type="button">–</button>
            </div>
        </div>
        <div class="devindex-bench-body">
            <div class="devindex-bench-status" id="devindex-bench-status">Measuring initial 50,000-record stream...</div>
            <div class="devindex-bench-controls">
                <select class="devindex-bench-select" id="devindex-bench-preset" aria-label="Buffer preset">
                    <option value="1x1">Buffer 1×1 (Default)</option>
                    <option value="5x5" selected>Buffer 5×5 (Medium)</option>
                    <option value="25x15">Buffer 25×15 (Extreme)</option>
                </select>
                <button class="devindex-bench-btn is-primary" id="devindex-bench-run" type="button" disabled>Run Benchmark (n=20)</button>
                <button class="devindex-bench-btn" id="devindex-bench-copy" type="button" disabled>Copy Report</button>
            </div>
            <pre class="devindex-bench-output" id="devindex-bench-output" hidden></pre>
        </div>
    `;
    document.body.appendChild(hud);

    const statusEl   = hud.querySelector('#devindex-bench-status');
    const runBtn     = hud.querySelector('#devindex-bench-run');
    const copyBtn    = hud.querySelector('#devindex-bench-copy');
    const presetEl   = hud.querySelector('#devindex-bench-preset');
    const outputEl   = hud.querySelector('#devindex-bench-output');
    const collapseBtn = hud.querySelector('#devindex-bench-collapse');

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
        rows          : streamRows,
        frameP95Ms    : streamFrameSt.p95,
        maxRafMs      : streamFrameSt.max,
        longFrames50  : streamFrames.filter(d => d > 50).length,
        flightsPerSec : streamWorkers.flightsPerSec,
        vnodeRelays   : streamWorkers.vnodeRelayMessages
    };

    statusEl.textContent = `Ready (${streamRows} rows streamed in ${streamWallMs}ms · frame p95 ${streamFrameSt.p95}ms · relays ${streamWorkers.vnodeRelayMessages}). Tap Run Benchmark.`;
    runBtn.disabled = false;

    let lastMarkdown = '';
    let lastResult   = null;

    async function runBenchmarkSuite(opts = {}) {
        const [presetRows, presetCols] = (opts.preset || presetEl.value || '5x5').split('x').map(Number);
        const bufferRows = opts.bufferRows ?? presetRows;
        const bufferCols = opts.bufferCols ?? presetCols;

        runBtn.disabled  = true;
        copyBtn.disabled = true;
        hud.classList.add('is-collapsed');
        collapseBtn.textContent = '+';

        try {
            statusEl.textContent = `Applying Buffer ${bufferRows}×${bufferCols}...`;
            await applyBufferPreset(bufferRows, bufferCols);

            const vScroller = document.querySelector('.neo-grid-view');
            const hScroller = document.querySelector('.neo-grid-horizontal-scrollbar');
            const gridBody  = document.querySelector('.neo-grid-body');
            const rowHeight = 50;

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

            // 2. Sustained 60-step Continuous 2D Scroll Sweep (Frame p95 / FPS)
            const sweepFrames = [];
            let sweepActive   = true;
            let lastSweepRaf  = performance.now();
            startWorkerProbe();

            function sweepRaf(now) {
                if (!sweepActive) return;
                sweepFrames.push(now - lastSweepRaf);
                lastSweepRaf = now;
                requestAnimationFrame(sweepRaf);
            }
            requestAnimationFrame(sweepRaf);

            for (let s = 1; s <= 60; s++) {
                const frac = s <= 30 ? (s / 30) : ((60 - s) / 30);
                vScroller.scrollTop = Math.round(frac * 25000 * rowHeight);
                if (hScroller) hScroller.scrollLeft = Math.round(frac * maxLeft);
                await sleep(20);
            }
            await sleep(100);
            sweepActive = false;
            const sweepWorkers = stopWorkerProbe();

            vScroller.scrollTop = 0;
            if (hScroller) hScroller.scrollLeft = 0;
            await sleep(200);

            // 3. 50,000-Record Column Re-Sorts (App-worker sort + full view refresh)
            const getTopLogin = () => {
                const cell = document.querySelector('.neo-grid-row[data-row-id="0"] .neo-grid-cell[data-field="login"]');
                return cell ? cell.textContent.trim() : '';
            };

            // Ensure Total & Commits % headers are within viewport even on 390px iPhone screens
            if (hScroller && window.innerWidth < 600) {
                hScroller.scrollLeft = 220;
                await sleep(150);
            }

            const clickHeader = (txt) => {
                const btn = Array.from(document.querySelectorAll('.neo-grid-header-button')).find(b => b.textContent.trim() === txt);
                if (!btn) throw new Error(`Header "${txt}" not found`);
                btn.click();
            };

            const sortTvs    = [];
            const sortMaxRaf = [];
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

            const topo        = getTopology();
            const hopStats    = stats(hopTvs);
            const hopFrameSt  = stats(allHopFrames);
            const sweepSt     = stats(sweepFrames);
            const sortStats   = stats(sortTvs);
            const sweepTotalS = sweepFrames.reduce((a, b) => a + b, 0) / 1000;
            const sweepFps    = sweepTotalS > 0 ? +(sweepFrames.length / sweepTotalS).toFixed(1) : 0;

            lastResult = {
                timestamp          : new Date().toISOString(),
                topology           : topo,
                device             : {
                    viewport           : `${window.innerWidth}x${window.innerHeight}`,
                    dpr                : window.devicePixelRatio,
                    hardwareConcurrency: navigator.hardwareConcurrency || null,
                    userAgent          : navigator.userAgent
                },
                buffer             : { bufferRows, bufferCols, mountedRows, mountedCells, mountedCanvases, mountedDomNodes },
                initialStream      : initialStreamSummary,
                scroll20Hops       : {
                    tvs       : hopStats,
                    frameP95Ms: hopFrameSt.p95,
                    maxRafMs  : +(Math.max(...hopMaxRaf)).toFixed(2),
                    workers   : scroll20Workers
                },
                sustainedSweep60   : {
                    fps         : sweepFps,
                    frameP50Ms  : sweepSt.p50,
                    frameP95Ms  : sweepSt.p95,
                    frameP99Ms  : sweepSt.p99,
                    maxRafMs    : sweepSt.max,
                    longFrames50: sweepFrames.filter(d => d > 50).length,
                    workers     : sweepWorkers
                },
                sort50k            : {
                    tvs     : sortStats,
                    maxRafMs: +(Math.max(...sortMaxRaf)).toFixed(2),
                    workers : sortWorkers
                }
            };

            lastMarkdown = [
                `### DevIndex Benchmark — \`useVdomWorker: ${topo.useVdomWorker}\` (\`vdom=${topo.hasVdomWorker}\`)`,
                `- **Device:** \`${lastResult.device.viewport}\` @ \`${lastResult.device.dpr}x\` · cores=\`${lastResult.device.hardwareConcurrency}\` · Buffer=\`${bufferRows}x${bufferCols}\` (\`${mountedRows}\` rows, \`${mountedCells}\` cells, \`${mountedCanvases}\` canvases, \`${mountedDomNodes}\` DOM nodes)`,
                `- **50k Stream-In:** \`${initialStreamSummary.streamWallMs} ms\` · frame p95 \`${initialStreamSummary.frameP95Ms} ms\` · maxRAF \`${initialStreamSummary.maxRafMs} ms\` · flights/s \`${initialStreamSummary.flightsPerSec}\` · vnodeRelays \`${initialStreamSummary.vnodeRelays}\``,
                `- **2D Scroll (n=20 hops):** mean \`${hopStats.mean} ± ${hopStats.sd} ms\` (95% CI \`±${hopStats.ci95Half}\`) · p50 \`${hopStats.p50} ms\` · **p95 \`${hopStats.p95} ms\`** · p99 \`${hopStats.p99} ms\` · max \`${hopStats.max} ms\` · frame p95 \`${hopFrameSt.p95} ms\` · maxRAF \`${lastResult.scroll20Hops.maxRafMs} ms\` · relays \`${scroll20Workers.vnodeRelays}\``,
                `  - raw hops: \`[${hopStats.raw.join(', ')}]\``,
                `- **Sustained 60-Step Sweep:** FPS \`${sweepFps}\` · frame p50 \`${sweepSt.p50} ms\` · **frame p95 \`${sweepSt.p95} ms\`** · p99 \`${sweepSt.p99} ms\` · maxRAF \`${sweepSt.max} ms\` · longFrames \`${lastResult.sustainedSweep60.longFrames50}\``,
                `- **50k Re-Sort (n=6):** mean \`${sortStats.mean} ± ${sortStats.sd} ms\` · p50 \`${sortStats.p50} ms\` · p95 \`${sortStats.p95} ms\` · max \`${sortStats.max} ms\` · maxRAF \`${lastResult.sort50k.maxRafMs} ms\``
            ].join('\n');

            hud.classList.remove('is-collapsed');
            collapseBtn.textContent = '–';
            outputEl.hidden         = false;
            outputEl.textContent    = lastMarkdown;
            statusEl.textContent    = `Done! Scroll p95=${hopStats.p95}ms (mean=${hopStats.mean}ms), Sweep FPS=${sweepFps} (frame p95=${sweepSt.p95}ms), Sort mean=${sortStats.mean}ms.`;
            copyBtn.disabled        = false;
            return lastResult;
        } catch (err) {
            hud.classList.remove('is-collapsed');
            collapseBtn.textContent = '–';
            statusEl.textContent    = `Error: ${err?.message || err}`;
            throw err;
        } finally {
            runBtn.disabled = false;
        }
    }

    runBtn.addEventListener('click', () => {
        runBenchmarkSuite().catch(console.error);
    });

    copyBtn.addEventListener('click', async () => {
        if (!lastMarkdown) return;
        const ok = await copyTextWithFallback(lastMarkdown);
        copyBtn.textContent = ok ? 'Copied!' : 'Select Below';
        setTimeout(() => { copyBtn.textContent = 'Copy Report'; }, 2000);
    });

    globalThis.__devindexBenchmark = {
        getTopology,
        getInitialStreamSummary: () => initialStreamSummary,
        getLastResult          : () => lastResult,
        getLastMarkdown        : () => lastMarkdown,
        run                    : runBenchmarkSuite
    };
}

initDeviceBenchmarkHud().catch(err => console.error('[DevIndex Benchmark HUD]', err));
