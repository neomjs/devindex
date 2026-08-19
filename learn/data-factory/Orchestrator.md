# The Orchestrator (CLI & Pipeline)

The DevIndex Data Factory is essentially a collection of specialized micro-services (Spider, Updater, Storage, etc.). To coordinate these services into a cohesive, automated workflow, the system relies on the **Orchestrator** layer.

This layer is comprised of three distinct parts:
1.  **The Entry Point:** `apps/devindex/services/cli.mjs`
2.  **The Command Router:** [`DevIndex.services.Manager`](https://github.com/neomjs/devindex/blob/main/apps/devindex/services/Manager.mjs)
3.  **The Automated Pipeline:** `.github/workflows/data-sync-pipeline.yml`

---

## The Entry Point (`cli.mjs`)

The entry point for the backend services is incredibly minimal, leaning entirely on the native Neo.mjs component lifecycle.

```javascript readonly
import Manager from './Manager.mjs';

async function start() {
    await Manager.ready();
}

start().catch(console.error);
```

Because `Manager` is a Neo.mjs singleton (`Neo.setupClass(Manager)`), simply importing the module triggers its instantiation. The `start()` function then simply awaits the native `Manager.ready()` promise, which resolves when the Manager's asynchronous initialization—including executing the requested CLI command—is complete.

---

## The Command Router (`Manager.mjs`)

The `Manager` service uses the `commander` library to parse command-line arguments and `inquirer` to provide interactive prompts for a robust Developer Experience (DX).

Its primary responsibility is mapping high-level commands to specific service executions.

### Available Commands
*   `update`: Triggers the **Updater** to process a batch of pending users.
*   `add [username]`: Manually adds or forces an update for a specific user.
*   `spider`: Triggers the **Spider** to discover new candidates. Offers interactive strategy selection if run without flags.
*   `cleanup`: Manually triggers the **Data Hygiene** routine.
*   `optin` / `optout`: Processes issue-based and star-based privacy requests.

### The "Pre-Run Cleanup" Pattern
A critical architectural pattern enforced by the Manager is the "Pre-Run Cleanup". Before executing any command that reads or modifies the index (like `spider` or `update`), the Manager automatically triggers `Cleanup.run()`.

```javascript readonly
program
    .command('update')
    .action(async (options) => {
        await Cleanup.run(); // Pre-run hygiene
        await this.runUpdate(options.limit);
    });
```
This guarantees that the services always operate on valid, sorted, and pruned data, preventing dirty data from polluting the discovery or enrichment processes.

### Smart Scheduling
When the `update` command is run, the Manager doesn't just blindly pass the whole queue to the Updater. It implements a smart scheduling algorithm:
1.  It filters out any user who has already been successfully updated *today* (based on the `lastUpdate` timestamp).
2.  It sorts the remaining backlog, prioritizing completely new users (`lastUpdate: null`) and the oldest records first.
3.  It slices the queue to the requested candidate limit. The Updater then applies GraphQL cost admission, so the limit remains a hard ceiling rather than a promise to process every candidate.

---

## The Automated Pipeline (GitHub Actions)

While a developer can run commands manually via the CLI, the DevIndex is designed to be autonomous.
The workflow lives at `.github/workflows/data-sync-pipeline.yml` **in this repository** — it runs the
four collection stages directly as steps, with no intermediate build script.

> **This section used to describe `neomjs/neo`'s pipeline**, including a `buildScripts/dataSyncPipeline.mjs`
> that has never existed here. The collection stages moved into this repository; what follows describes
> what actually ships beside this guide.

```yaml readonly
jobs:
  collect:
    permissions:
      contents: read
      actions: read
    steps:
      - name: Mint Intake installation token
        uses: actions/create-github-app-token@v3
        with:
          owner: neomjs
          repositories: |
            devindex-opt-in
            devindex-opt-out

      - uses: actions/checkout@v6
        with:
          fetch-depth: 1
```

Stages run in a fixed order: **Opt-In → Opt-Out → Spider → Updater**, each carrying the Intake App
token. That token is installed on the two intake repositories and *not* on this one, so it is minted
by naming them explicitly.

### Key Pipeline Concepts

1.  **Privacy-First Execution:** `optin` and `optout` run *before* discovery or enrichment, so a user
    who asked to be removed cannot be indexed by the Spider in the same run that honoured the request.
2.  **Cost-Bounded Enrichment:** the 200-user argument is a rollout ceiling. The Updater admits fewer
    when its GraphQL budget cannot preserve the downstream reserve.
3.  **`fetch-depth: 1`, deliberately:** nothing here pushes, resets to a remote head, or compares SHAs
    for ancestry, so no history is needed. neo's equivalent sets `0` for a publish push this workflow
    does not have.
4.  **No `publishGeneratedProgressOnFailure`:** neo's stages carry a flag that publishes partial output
    when a stage fails. It exists because DevIndex enrichment shared a process with neo's *corpus*
    publication — one denied stage discarded the whole corpus unpublished and froze it for nineteen
    hours. Splitting the process removes the coupling that flag protected against, so it is
    deliberately not ported. Carrying it here would import a workaround into a structure that cannot
    have the problem, and would read as though it still could.
5.  **The working set round-trips, it is never committed:** the run fetches `users.jsonl`,
    `tracker.json` and `visited.json` as one verified set and publishes them the same way. See
    [Storage](./Storage.md#the-working-set-derived-delivered-never-versioned) — this is the single most
    important invariant in the pipeline, and the reason `neomjs/neo`'s `.git` is 5.2 GB.

### Cadence

**Every two hours.** Each run is bounded by the GraphQL window rather than by `--limit 200`: a
5,000-point budget against a 32-point per-user reservation, less a 100-point downstream reserve,
admits about 153 users. The schedule is therefore the only lever on throughput — roughly 1,836
users/day, a full sweep of the 50,000-user cap in about 27 days. Hourly would halve that to ~14 days.

If the tail proves too stale, measure real `observedCost` against the 32-point reservation before
doubling the run count; the reservation is a conservative bound and may be buying less than it costs.

A **scheduled** run always collects. A **dispatched** run collects only with `run_collection` set, so
the default dispatch stays a side-effect-free probe of both credential paths.
*   **The publish step exists but has no destination.** `buildScripts/publishWorkingSet.mjs` uploads
    the three payload objects and then the manifest — in that order, because a manifest must never
    advertise a set that is still arriving. It fails loudly until `DEVINDEX_PUBLISH_BUCKET` and
    Google auth are provisioned, so a run cannot be mistaken for a working pipeline.

    Auth is **keyless**: Workload Identity Federation exchanges the runner's OIDC token for a
    short-lived credential, so no Google secret is stored in this repository — consistent with the
    GitHub App token, which is also minted per run rather than stored. The identity is dedicated to
    this job and scoped to object writes on one prefix; an hourly data job has no business holding
    more. Bindings are per-repository, so this repository needs its own.

    `buildScripts/setup-gcp-publish.sh` does the whole thing, once, and is idempotent. It reuses the
    existing Workload Identity pool and adds only what is new: a dedicated service account with
    object-write on one prefix, a per-repository impersonation binding, and the secrets plus one
    variable. Export the deployment identifiers first — they live with the deployment configuration,
    not in this repository. Neither secret is a credential: one is a resource path, one an address.

Until both land, dispatch the workflow manually. Leaving `run_collection` **off** performs a credential
probe with no side effects — it mints the token, confirms both intake repositories are reachable, and
stops. That is the check you can safely repeat while correcting an installation, which is exactly when
you need one.
