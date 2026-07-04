# Carl Quest Sports

A 2-player online 3D rounders game. One player creates a match and shares a
4-letter code; the other joins, you draft your squads from the shared character
pool, and play a full game of school-rules rounders — pitching, batting,
fielder positioning, substitutions, character abilities, innings, tiebreaks and
rematches — over a server-authoritative connection.

Built with **TypeScript (strict)**, **Three.js** (rendering), **Rapier**
(physics), **Colyseus** (authoritative multiplayer server) and **Vite**.

| The lobby | The draft |
|---|---|
| ![Lobby — create a match and share the 4-letter code](docs/superpowers/acceptance/m10-01-lobby.png) | ![Alternating character draft with stats and abilities](docs/superpowers/acceptance/m7-01-mid-draft.png) |

| Mid-play HUD | Result screen |
|---|---|
| ![Scorer's board, event feed and key legend during play](docs/superpowers/acceptance/m10-02-play-hud.png) | ![Game over — final score, winner and rematch](docs/superpowers/acceptance/m10-03-result-overlay.png) |

## Quick start (one machine, two tabs)

Requires **Node.js 20+** (npm workspaces — not pnpm).

```bash
npm install
npm run dev
```

`npm run dev` starts both halves:

- the client (Vite) at `http://localhost:5173`
- the game server (Colyseus) at `ws://localhost:2567`

Open `http://localhost:5173` in two browser tabs. In tab 1 click
**create match** and note the 4-letter code; in tab 2 enter the code and
**join**. Draft your squads by clicking character rows, then play.

## How to play

The game is keyboard-driven during play; the on-screen key legend always shows
exactly the keys available to *you* in the current phase.

| Phase | You do |
|---|---|
| Draft | Click a character row on your turn (5 picks each) |
| Positioning / pre-play | `Enter` to confirm/ready. Fielding side: click your fielder, then click the ground to reposition (`Esc` clears); nominate your bowler and make substitutions from the panel. Batting side: click a queue row to choose the next batter |
| Play — batting | `Space` swing · `R` run · `T` stop |
| Play — fielding | `A`/`S`/`D` set spin · `P` pitch |
| Game over | `N` or the on-screen button to rematch |

Scoring is school rules: reach the 2nd post on your own hit for a
**half-rounder**, complete the circuit for a **rounder**; caught balls and
run-outs end the batter; five outs end the innings; ties go to sudden-death.
Every character has an ability (the bracketed tag on their draft card) that
genuinely changes play — Kian's curveball bends late, the Whale stops any ball
that hits him dead, Jonty never drops a catch, Joe fumbles 35% of his.

![Fielding-side positioning panel with bench and substitutions](docs/superpowers/acceptance/m8-01-positioning-panel.png)

## Playing over your local network (works today, no changes)

The client connects its WebSocket to whatever hostname served the page, so LAN
play needs no configuration:

1. Start the game on the host PC: `npm run dev`.
2. Find the host PC's LAN address (`ipconfig` on Windows → the IPv4 address,
   e.g. `192.168.1.42`).
3. The second player opens `http://192.168.1.42:5173` on any device on the
   same network. Their client automatically connects to
   `ws://192.168.1.42:2567`.

**Windows firewall:** the first run may prompt to allow Node.js on private
networks — allow it, or the second player's connection will hang. If there was
no prompt, add inbound rules for TCP 5173 and 2567 (private profile).

## Server hosting guide (internet play)

Three routes, in increasing order of effort. Read the
[security notes](#security-notes-before-hosting-publicly) first if strangers
could reach your server.

### Route 1 — a plain VM / VPS over HTTP (simplest real hosting)

The stock client works unchanged as long as the page is served over **plain
HTTP** and port **2567** is reachable on the **same hostname** (the client
derives its WebSocket URL from `location.hostname`).

On any Ubuntu-ish VM (or a home server with ports forwarded):

```bash
# 1. Get the code and dependencies (Node 20+)
git clone <this repo> carlquest3 && cd carlquest3
npm install                       # dev deps included — the server runs via tsx

# 2. Build the client to static files
npm run build                     # client output lands in client/dist

# 3. Run the game server (port 2567 is hardcoded in server/src/index.ts)
npx tsx server/src/index.ts       # keep it alive with pm2/systemd in practice
# e.g.  npx pm2 start "npx tsx server/src/index.ts" --name carlquest-server

# 4. Serve the built client on port 80 from the same machine
npx serve -l 80 client/dist       # or nginx / caddy serving client/dist
```

Open the firewall / cloud security group for **TCP 80 and 2567**. Players
visit `http://your-server-ip/`, and their clients connect to
`ws://your-server-ip:2567` automatically.

Two honest caveats baked into the current code (both logged in the project
log, CLAUDE.md §6.4):

- **There is no emitted server build** — `npm run build` typechecks the server
  but outputs no JS, which is why production runs through `tsx` (a TypeScript
  runner). It's a dev dependency, so install with dev deps (plain
  `npm install`, not `--omit=dev`).
- **The port is hardcoded** to `2567` in `server/src/index.ts`. Platforms that
  inject a `PORT` env variable need that one line changed
  (`listen(appConfig, Number(process.env.PORT ?? 2567))`).

### Route 2 — a PaaS (Railway / Fly.io / Render)

The server is a standard Node app, so any Node host works:

1. **Server service:** start command `npx tsx server/src/index.ts` from the
   repo root (workspaces need the root `node_modules`). Expose port 2567 — or
   make the one-line `PORT` change above if the platform assigns ports.
2. **Client:** `npm run build`, then deploy `client/dist` to any static host
   (Netlify, Cloudflare Pages, or the same PaaS).
3. **The one required code change:** hosted platforms serve over **HTTPS**,
   an HTTPS page may not open an insecure `ws://` connection (mixed content),
   and your server now lives on a *different* hostname than the client. Point
   the client at the server explicitly in `client/src/NetModule.ts`:

   ```ts
   // before (same-host, dev/LAN):
   const SERVER_URL = `ws://${location.hostname}:2567`;
   // after (hosted):
   const SERVER_URL = 'wss://your-server-app.up.railway.app';
   ```

   Use `wss://` (the platform's TLS proxy terminates it and forwards to your
   2567). Rebuild the client after the change.

### Route 3 — a quick tunnel for one evening's play

To play with one remote friend *right now*, tunnel your dev server instead of
deploying. Because the client's WebSocket URL is derived from the page's
hostname, you need the NetModule edit from Route 2 pointing at a second tunnel:

```bash
npm run dev                                   # local game as usual
# tunnel the websocket server:
cloudflared tunnel --url http://localhost:2567   # note the https://…trycloudflare.com URL
# edit client/src/NetModule.ts → SERVER_URL = 'wss://<that-url-without-https://>'
# tunnel the client:
cloudflared tunnel --url http://localhost:5173   # send THIS url to your friend
```

(ngrok works identically. Remember to revert the NetModule edit afterwards —
or better, make the URL env-driven as in Route 2.)

### Security notes before hosting publicly

These are known, logged limitations (project log §6.4) that don't matter
between friends but do on a public server:

- **Room-creation options are client-reachable.** A creating client can pass
  `seed` (predictable catch rolls), `reconnectGraceS` and `fieldSlotsOverride`
  as join options. They're runtime-validated (junk falls back to defaults) but
  not yet gated to test environments. Harden before strangers join.
- **No authentication or rate limiting** — rooms are open to anyone with the
  4-letter code (26⁴ ≈ 457k combinations; fine for friends, guessable at
  scale).
- `npm audit` has known dev-dependency advisories, triaged in the project log;
  the only runtime one (nanoid in Colyseus) doesn't apply to its usage here.

## Repository layout

- `client/` — Three.js client: rendering, input, HUD, lobby/draft/positioning UI
- `server/` — Colyseus authoritative simulation: physics, rules, all game logic
- `shared/` — types, tunable constants, stat formulas, the character roster
- `docs/design/spec.md` — the design spec (single source of intent)
- `docs/superpowers/acceptance/` — committed acceptance evidence per milestone
- `CLAUDE.md` §6 — the live project log: verified state, decisions, known issues

## Development commands

- `npm run dev` — client + server in watch mode
- `npm run check` — typecheck + lint + full test suite (all workspaces; 357 tests)
- `npm run test` — Vitest only
- `npm run build` — production client build (server build wiring is a known
  open item; production uses `tsx`)

All ten build milestones from the spec are complete, each merged behind its
own tag (`m1-scaffold` … `m10-ui-polish`) with committed acceptance evidence.
