<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./resources/images/logo/neo_logo_text_primary_dark.svg">
    <img height="100" src="./resources/images/logo/neo_logo_text_primary.svg" alt="Neo.mjs Logo">
  </picture>
</p>
</br>
<p align="center">
  <a href="https://neomjs.com/dist/production/apps/devindex/index.html"><img src="https://img.shields.io/badge/Live-DevIndex-brightgreen.svg?logo=githubpages&logoColor=white" alt="Live app"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://github.com/neomjs/neo"><img src="https://img.shields.io/badge/Built%20with-Neo.mjs-1f6feb.svg" alt="Built with Neo.mjs"></a>
  <a href="https://discord.gg/6p8paPq"><img src="https://img.shields.io/discord/656620537514164249?label=Discord&logo=discord&logoColor=white" alt="Discord Chat"></a>
  <a href="https://github.com/neomjs/devindex/issues"><img src="https://img.shields.io/badge/PRs-welcome-green.svg?logo=GitHub&logoColor=white" alt="PRs Welcome"></a>
</p>

# The GitHub meritocracy index

**DevIndex makes open-source labor visible.** It indexes the 50,000 most active developers on GitHub by *lifetime* contributions — a number GitHub's own API will not give you — and renders all of them in the browser, from a static host, with no backend server.

**[▶ Open the live index](https://neomjs.com/dist/production/apps/devindex/index.html)**

> **Not affiliated with GitHub, Inc.** DevIndex is an independent, MIT-licensed open-source project. It is not endorsed by or associated with GitHub in any way, and it uses only publicly available data from the GitHub API. No advertisements, no tracking cookies, nothing sold.

---

## The problem it exists to solve

Ask "who are the most active open-source developers?" and you get bad answers. Existing lists are localized, niche, or simply wrong — routinely missing developers with tens or hundreds of thousands of contributions. Ask an LLM and it will hallucinate a top-20 whose members have a fraction of the contributions of the people actually in the top 100.

The cause is technical, not editorial. GitHub has over 180 million users, and it stores contribution data **strictly per year** — there is no endpoint that returns a lifetime total. Building an accurate ranking means discovering candidates across a 180M-node graph and then aggregating each one year by year.

That gap has consequences beyond curiosity. LLMs are trained on the open-source corpus and strip attribution as a matter of architecture — the licenses that corpus ships under are almost all attribution licenses. And where public funding bodies want to direct money at critical digital infrastructure, nobody can answer the question that decision starts from: *who is actually doing the work, and where are they?*

## How it works

A Node.js **Data Factory** runs on a schedule and writes flat files; the browser reads them. There is no application server anywhere in the stack.

| Stage | What it does |
|---|---|
| **Spider** | Discovers candidates across the GitHub graph using weighted random walks, network traversal, temporal slicing and keyword strategies — deliberately breaking out of the filter bubble that keeps prolific-but-unknown developers invisible |
| **Updater** | Aggregates true lifetime totals via multi-year GraphQL queries, with rename recovery and a strict API budget |
| **Heuristics** | Computes velocity, acceleration and consistency to separate organic contributors from automation |
| **Cleanup** | Enforces blocklists, expires failed profiles, and canonically sorts every file so diffs stay readable |

The client streams the resulting JSONL progressively — the app is usable before the data finishes loading, and you can stop the stream at any point.

**The Meritocracy Filter.** A browser cannot download 180 million records, so the index holds the top **50,000** and the entry bar rises as it fills. That bar is not a fixed rule; it is whatever 50,000th place currently costs:

```
indexed developers   49,999
entry threshold       5,907 lifetime contributions
dataset               ~23 MB JSONL  (~8 MB gzipped)
```

For scale: in February 2026 the same bar was **2,134**. It has nearly tripled as the Spider filled the index.

## Your data, your call

DevIndex indexes public GitHub profiles. It is also **radically inclusive by design** — the only accounts filtered out are those explicitly flagged as automation bots, and anyone who has asked to be removed.

- **Missing?** [Open an opt-in request](https://github.com/neomjs/devindex-opt-in/issues/new/choose) for yourself or nominate someone else. The Spider is a heuristic, not a database dump; it *will* have gaps, and the index gets better when people report them.
- **Want out?** [Open an opt-out request](https://github.com/neomjs/devindex-opt-out/issues/new/choose). Removal is permanent and enforced on every subsequent run, not just once.

Both intake repositories are separate and public, so the entire moderation trail is auditable. See [Privacy & Opt-Out](./learn/OptOut.md) and [Opt-In & Nominations](./learn/OptIn.md).

## What the data is for

The index carries more than a leaderboard: GitHub Sponsors links, the `hireable` flag, and normalized ISO country codes. That makes a few things possible that were not before.

- **Funding the maintainers.** Sponsor links sit next to the contribution counts, so recognition and support land in the same place.
- **Talent scouting.** Filter the world's most prolific contributors by country and hireable status.
- **Policy and research.** Per-country contribution totals against active-user counts expose structural disparities in who sustains public digital infrastructure — the kind of empirical footing an argument for FOSS funding actually needs.

See [Methodology](./learn/Methodology.md) for how scoring and anomaly detection work, and [The Ethical Manifesto](./learn/EthicalManifesto.md) for why it is built this way.

## Built with Neo.mjs

DevIndex is a real product and a deliberate stress test. It renders 50,000 rows in a browser without virtualization stutter, using the [Neo.mjs](https://github.com/neomjs/neo) multi-threaded application engine — App, VDom, Data and Canvas workers, with the UI running off the main thread.

The whole platform — the Data Factory, the streaming frontend, and a from-scratch rewrite of the engine's Grid component — was built in **one month** (February 2026) by a single developer working with AI pair programmers, across roughly 400 resolved tickets. The commit log and issue tracker are public; the claim is checkable.

Read [Frontend Architecture](./learn/frontend/Architecture.md), [The 50k-Row Grid](./learn/frontend/TheGrid.md), and [The Backend Twist](./learn/Backend.md) — the last of which explains how a "backend" runs with no server.

## Running it locally

```bash
npm install
npm run server-start
```

Then open `apps/devindex/index.html`. For the Data Factory CLI (`spider`, `update`, `optin`, `optout`, `cleanup`) see [The Data Factory](./learn/data-factory/Intro.md); it needs a GitHub token in `.env`.

```bash
npm run test-unit
```

## Contributing

Issues and feature requests belong in **[this repository's tracker](https://github.com/neomjs/devindex/issues)**.

One firm rule: **a pull request must reference an existing issue.** Architectural changes get discussed before they get written, not after.

The codebase is advanced — it is a multi-threaded engine driving a streaming data grid — but you do not have to navigate it unaided. Neo.mjs ships [MCP servers](https://neomjs.com/#/learn/guides/mcp/Introduction) including a Knowledge Base and a Memory Core, so a compatible AI assistant can be pointed straight at the code and act as an informed pair programmer.

## Related repositories

| Repository | Purpose |
|---|---|
| [neomjs/devindex](https://github.com/neomjs/devindex) | This repository — the app and the Data Factory |
| [neomjs/devindex-opt-in](https://github.com/neomjs/devindex-opt-in) | Opt-in and nomination requests |
| [neomjs/devindex-opt-out](https://github.com/neomjs/devindex-opt-out) | Opt-out requests |
| [neomjs/neo](https://github.com/neomjs/neo) | The Neo.mjs engine DevIndex is built on |

## License

[MIT](./LICENSE) — the application, the Data Factory, and the engine underneath it.
