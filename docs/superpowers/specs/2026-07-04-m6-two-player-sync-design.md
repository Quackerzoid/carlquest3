# M6 Design — 2-player authoritative sync (spec §9.6, §7)

Date: 2026-07-04. Status: USER-APPROVED (this session).
Scope decision (user): **strict sync-only** — two clients, sides, room-code join, lobby wait,
per-role gating of the *existing* message set, disconnect handling. DRAFT stays auto-skipped with
mirror rosters (M7); positioning input stays skipped (M8). Swing timing stays server-authoritative
(latency compensation logged as a post-M6 tuning item, not built). Disconnect = pause + reconnect
grace (user choice). Join = friendly 4-letter code (user choice).

## 1. Room creation and code join

- Player 1's client generates a 4-letter uppercase A–Z code **client-side** and calls
  `client.create('match', { code })`. The server validates the format (`/^[A-Z]{4}$/`, else reject
  the join) and mirrors it into a `MatchState.roomCode` field so the creator's UI can display it.
- Player 2 calls `client.join('match', { code })`, matched via `gameServer.define(...).filterBy(['code'])`.
  `join` (NOT `joinOrCreate`): a wrong/expired code errors instead of silently creating a new room.
- Rationale: `filterBy` matches against room **creation** options, so a server-generated code would
  never match a filtered join — hence client-generated. The code is a rendezvous string, not a
  trust boundary; collision space 26^4 is fine for a 2-player game.
- The test-only `{seed?, rng?}` creation options are unchanged and unaffected by the filter.
- `maxClients: 2` (already set) locks the room once both seats fill; third joins fail.

## 2. Seats, sides, and role gating

- First client = side `'A'`, second = `'B'`. `MatchState` gains `sessionA`, `sessionB` (sessionIds,
  `''` when empty) and `connectedA`/`connectedB` booleans. A client derives `mySide` by comparing
  `room.sessionId` — no extra message.
- **Role is derived, never stored:** with `battingSide` already rotating in RulesModule,
  a client may send `pitch` only if its side is the fielding side, and `swing`/`runDecision` only
  if its side is the batting side. RulesModule is untouched.
- `confirmPositioning` and `readyForPlay` become **both-players gates**: MatchRoom collects one
  confirmation per side (reset on phase entry), and calls the existing single RulesModule
  transition only when both sides have confirmed. A duplicate confirm from the same side is
  idempotent (accepted, no state change), not a rejection.
- `rematch` stays either-player (casual default).
- All new rejections reuse the structured `rejected` broadcast with reason `wrongRole`
  (plus the existing phase reasons). Messages from a session that holds no seat (never possible
  post-lock, but defensive) are rejected likewise.

## 3. Lobby wait

- Replace the M5 fast-forward stub: `onJoin` seats the client only. When the second seat fills,
  the room calls `rules.bothConnected()` then `rules.completeDraft()` (mirror-roster auto-draft,
  unchanged until M7) → `INITIAL_POSITIONING`.
- Until then the room sits in `LOBBY`; the creator's client shows the room code and
  "waiting for opponent".

## 4. Disconnect and reconnect

- `onLeave(client, consented)`:
  - **In LOBBY** (game not started): free the seat, no grace. Room disposes when empty (autoDispose).
  - **Consented leave mid-game** (deliberate quit): no grace — broadcast an `opponentLeft` notice
    and dispose the room. A stranded opponent returns to the lobby screen.
  - **Unconsented drop mid-game:** set `state.paused = true`, `connectedX = false`, and
    `await this.allowReconnection(client, 60)`. On reconnect (same sessionId restored by Colyseus)
    set `connectedX = true`, unpause. On grace expiry or room disposal the await rejects —
    catch it and dispose (opponent notified as above).
- **Pause semantics:** while `paused`, the simulation callback returns before stepping AND before
  accruing the fixed-step accumulator, so physics, play timeout, and rest-detection timers all
  freeze; nothing about the play resolves during a pause. (The accumulator is wall-clock-fed —
  merely skipping `step` would fast-forward on resume.) Gameplay messages (`pitch`, `swing`,
  `runDecision`) are rejected while paused with reason `paused`; confirms/rematch are likewise
  held (the opponent isn't there to be confirmed against).

## 5. Client

- `NetModule.connect(opts: { mode: 'create' } | { mode: 'join'; code: string })` — create generates
  the code and calls `create`; join calls `join` with the entered code. Exposes `mySide: TeamSide`
  (derived once seated) alongside the existing state view/senders. Errors (bad code, room full)
  surface to the lobby screen, not the console.
- **Lobby screen** (pre-connect DOM UI): create-game button → connecting → shows the room code to
  share + "waiting for opponent"; join-game → 4-letter input → connecting → seated. Designed with
  the `unslop-ui` skill — a deliberate project-specific look, not a templated default.
- `InputModule` gates keys by derived role (P pitch only when fielding; Space/R/T only when
  batting; Enter/N unchanged but now per-side confirms). Blocked keys do nothing locally rather
  than round-tripping a guaranteed rejection.
- Status line adds: `you are A · batting`, `waiting for opponent`, `opponent disconnected — waiting`,
  `opponent left`.

## 6. Testing and acceptance

- Room tests (`@colyseus/testing`, two clients): lobby holds in LOBBY until the second join;
  side assignment by join order; wrong-role pitch/swing/runDecision rejected with `wrongRole`
  while the right role succeeds; both-confirm gating (one side ready ≠ transition; both = transition;
  duplicate confirm idempotent); simulated drop pauses (ball position identical across ticks while
  paused) and reconnect resumes; consented leave disposes; join with wrong code fails; format-invalid
  create code rejected.
- **Known churn:** most existing MatchRoom tests join ONE client and single-confirm through phases —
  the lobby wait and both-confirm gates intentionally break them. They must be updated to seat two
  clients and act from the correct role. This is expected migration, and the gates must NOT be
  weakened to keep old tests green.
- Acceptance (§9.6): two scripted colyseus.js WS clients vs a real `npm run dev` server play a full
  game end-to-end, each sending only its own role's messages, including one wrong-role message shown
  rejected; a drop/reconnect demonstrated with the ball frozen while paused. Browser: two Playwright
  tabs (create + join by code) reach PLAY together. Evidence committed under
  `docs/superpowers/acceptance/`.

## 7. Out of scope (deferred)

- draftPick / reposition / substitute / setPitcher / setBatter messages (M7/M8).
- Client physics prediction; swing-timing latency compensation (post-M6 tuning item; the M3/M6
  known-issue entry moves to "revisit if remote play feels unfair").
- Ranked/casual sub caps, spectators, more than one concurrent room per code (codes may collide
  across simultaneous lobbies at 26^4 odds — accepted).
