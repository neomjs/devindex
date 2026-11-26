/**
 * @summary Boots `Neo.Main` from `./neo-config.json` with optional `?useVdomWorker=true|false` arm override
 * and lazy `?bench=1` on-device benchmark HUD loading for Desktop and Mobile Safari comparisons.
 */
fetch('./neo-config.json').then(r => r.json()).then(d => {
    const params    = new URLSearchParams(globalThis.location?.search || ''),
          vdomParam = params.get('useVdomWorker');

    if (vdomParam === 'true') {
        d.useVdomWorker = true;
    } else if (vdomParam === 'false') {
        d.useVdomWorker = false;
    }

    self.Neo = {config: {...d}};

    if (params.get('bench') === '1') {
        import(new URL('./resources/device-benchmark.mjs', globalThis.location.href).href);
    }

    import(d.mainPath);
});
