# Bracket Dashboard

A local-first tournament dashboard and stream overlay system for start.gg brackets.

Import a start.gg tournament, watch every event's bracket update live, report
scores back, and drive customisable overlays into OBS or onto a venue TV — all
from a server that runs on your own machine.

---

## What it does

**See everything at once.** Import a tournament by pasting any start.gg link.
Every event appears on one screen with live set counts, so you can tell at a
glance which brackets are moving and which are stalled.

**Render brackets like start.gg, but yours.** Single elimination, double
elimination (with losers bracket, grand final and reset), round robin pools with
head-to-head grids, and Swiss with standings. Pan, zoom, and punch in on a match.

**Drive overlays into OBS.** Each output gets its own URL to paste into a Browser
Source. Four output types ship: the zoomable bracket, an upcoming-matches queue,
a standings/top-8 board, and a match scorecard lower third.

**Aim each display independently.** An output is a display surface with its own
camera, theme and auto-follow settings. The stream overlay can punch in on grand
finals while the lobby TV shows the whole bracket — same event, same server, no
interference.

**Punch in like a camera, not a crop.** Focusing a match fades the rest of the
bracket back rather than slicing it at the frame edge, so viewers keep their
bearings. Short moves glide; long jumps (winners to losers) cut through a
cross-fade instead of swooping across the whole bracket. Optional titled frame
chrome stays fixed while the bracket moves inside it.

**Report scores back to start.gg.** Score reporting, per-game logs, DQs, set
resets, and setup/stream assignment. Everything is queued locally first, so a
Wi-Fi drop at the venue never stops the desk.

**Never lose a report, never silently overwrite one.** Reports queue offline and
replay on reconnect. If start.gg changed underneath a queued report, it stops and
shows you both versions to choose between.

---

## Quick start

```bash
npm install
npm run build
npm start
```

Then open <http://localhost:4747>. On first run an `admin` account is created and
its password is printed to the terminal once — it is not stored and cannot be
recovered, only reset.

### Try it without a real tournament

```bash
node packages/server/dist/bin/serve.js --mock
```

Mock mode runs a simulated 4-event tournament — double elim, round robin, single
elim, and a two-phase event (round robin pools feeding a single elim top cut) —
whose matches progress on a timer. Import
`https://www.start.gg/tournament/bracket-dashboard-demo` and everything —
overlays, the director, reporting, conflicts — works with no network at all. Good
for laying out your OBS scenes the night before.

### Development

```bash
npm run dev        # backend on :4747, Vite dev server on :5173
npm test           # unit tests
npm run typecheck
```

### Desktop app

```bash
npm run desktop            # run the Electron shell
npm run package -w @bracket/desktop   # build installers
```

The Electron shell runs the same backend in-process. Because it bundles
`better-sqlite3`, run `npm run rebuild -w @bracket/desktop` after changing Electron
versions.

---

## Setting up an OBS overlay

1. Go to **Outputs** and create one. Pick a type, an event, and a theme.
2. Copy its URL.
3. In OBS: **Sources → + → Browser**, paste the URL, set the size (1920×1080 for a
   full-bracket overlay).
4. Leave the background transparent — overlays paint nothing behind themselves,
   so they composite straight onto your scene.

To control the shot live, open **Direct** next to the output. Pick a match and the
overlay animates to it immediately. For an unattended display, turn on
**Auto-follow** instead and it will track live matches on its own; taking manual
control pauses the automation for a grace period, then it resumes.

The **Presentation** section of the director panel controls the frame, the title
bar, whether punching in dims or crops, and how the camera moves between shots.

Want the same bracket on a TV as well? **Duplicate** the output. The copy has its
own URL and camera, so the two never fight.

---

## Events with multiple phases

Most non-trivial events run pools and then a top cut. Each phase numbers its
rounds from 1, so a "round 1" in pools and a "round 1" in the cut are unrelated —
rendering them together would interleave into nonsense. A bracket therefore shows
exactly **one phase at a time**, and the server decides which one in a single
place that the dashboard, the overlays and auto-follow all share.

When creating an output you pick:

- **A specific phase** — pin a display to Pools or to Top Cut.
- **Follow whichever phase is live** (the default) — the display walks itself from
  pools into the top cut as the event progresses. This is what you want on an
  unattended venue TV.

If the chosen phase has several pools, pin one or leave it on **busiest pool**,
which tracks wherever play is actually happening. The dashboard's event page has
the same picker, listing every phase and pool, and renders each with the right
view: a standings table plus head-to-head grid for round robin pools, a tree for
the cut.

## Reporting and offline behaviour

Every write goes onto a durable queue before it goes to start.gg:

1. The result is applied locally and appears instantly on the dashboard and every
   overlay, marked as still syncing.
2. A worker sends it as soon as start.gg is reachable.
3. On success the local copy is replaced with what start.gg actually recorded.

If the connection is down, reports stack up and replay automatically on
reconnect. If a queued report reaches start.gg to find someone else already
reported that set differently, it is **not** sent. It moves to the **Report
queue** as a conflict showing your version and start.gg's side by side, and a
person decides. Nothing is silently overwritten and nothing is silently dropped.

---

## Roles

Local accounts, since the app holds one start.gg credential for writes and needs
to decide who may use it.

| Role | Can do |
| --- | --- |
| **admin** | Everything, including accounts and connection settings |
| **organiser** | Report, reset, DQ, reseed, manage outputs and themes, resolve conflicts |
| **scorekeeper** | Report results, start matches, assign setups |
| **viewer** | Read-only |

Scorekeepers can be scoped to specific events, so the person running Melee singles
cannot report into the Ultimate bracket by mistake.

Overlay URLs are deliberately outside this system — they carry an unguessable
per-output secret, because an OBS browser source and a TV in the corner cannot log
in. Rotate a URL from the Outputs page if one leaks.

---

## Network access

By default the server binds to your whole local network so scorekeepers on phones
and a second stream PC can reach it. The addresses are listed under **Settings →
Network access**.

Anyone who can reach those addresses can attempt to sign in, so use real passwords
on a shared venue network. To restrict the app to the machine it runs on:

```bash
node packages/server/dist/bin/serve.js --localhost-only
```

The server never binds to the public internet, and it does not trust proxy
headers.

---

## The start.gg connection

Two endpoints are supported, switchable in **Settings** without touching code:

- **Site endpoint** (default) — `https://www.start.gg/api/-/gql`, the endpoint the
  start.gg website itself uses. No token needed for reading, and no query
  complexity ceiling, which is what makes pulling a whole multi-event tournament
  in one call practical. It is **undocumented**, so it can change without notice.
- **Documented API** — `https://api.start.gg/gql/alpha`. Stable and supported, but
  requires a personal access token and enforces complexity limits.

Both go through one transport interface, so switching is a settings change.

Reporting *to* start.gg requires a credential that can perform writes. Without
one, reads and overlays work normally and reports queue locally; the UI says so
plainly rather than failing silently.

> **Verify before a live event.** This was built and tested against a faithful
> mock of the start.gg schema, not a live account. The read queries follow the
> documented schema; the **mutation names and input shapes have not been executed
> against a real start.gg account** and may need adjusting. They are isolated in
> `packages/server/src/startgg/queries.ts`, and because every write goes through
> the outbox, a rejected mutation surfaces as a conflict for a human rather than
> as lost data. Do a dry run on a test tournament first.

### Keeping call volume down

The sync engine only asks for what changed. Each event keeps a watermark and
requests sets updated since then, at a cadence based on what the event is doing:

| Event state | Poll interval |
| --- | --- |
| Matches in progress | 10s |
| Running, nothing live | 30s |
| Not started | 2min |
| Finished | 10min |

A full reconcile runs every 15 minutes to catch what a delta cannot express
(resets, reseeds, deleted sets). The watermark is rewound by 90 seconds before
each request to absorb clock skew between your machine and start.gg; the few sets
that get re-fetched are dropped by a content hash, so overlays only re-render when
something a viewer can see actually changed.

---

## Architecture

```
packages/
  shared/    Types, bracket layout algorithms, theme schema, camera logic, WS protocol
  server/    Fastify + SQLite: start.gg client, sync engine, reporting outbox, auth, WS hub
  web/       React + Vite: dashboard, director panel, theme editor, OBS overlays
  desktop/   Electron shell that boots the server in-process
```

Two decisions worth knowing:

**Layout is pure and shared.** `layoutElimination` turns a flat list of sets into
positioned nodes and connectors, deterministically. The dashboard and the overlay
render through the same component, which is why the shot you line up in the
director is the shot that goes out.

**Camera state lives on the output record.** A browser source that reloads
mid-tournament comes back framed exactly where it was, and auto-follow decisions
are computed server-side so every client watching an output agrees.

---

## Roadmap

This is step one. The pieces are shaped so the next steps do not need a rewrite:

- The sync layer is an event log, so replay and history come cheap.
- The backend runs headless, so it can become the core of a control surface.
- Writes are already modelled as queued commands, which is what any automation
  will want to emit.

---

## Licence

MIT
