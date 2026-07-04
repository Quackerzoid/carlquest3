# M10 Design — UIModule polish + client hardening (spec §9.10, §1 — FINAL milestone)

Date: 2026-07-04. Status: USER-APPROVED (this session).
User decisions: HUD = **scoreboard + event feed** (status line retires); controls = **keyboard +
contextual key legend** (no clickable play buttons); M10 absorbs ALL THREE deferred fix groups —
**client reconnect flow**, **render polish** (per-frame lerp, out-runner presentation, batting
panel current-batter/parked-runners), **paused key gating client-side**.

## 1. UIModule (new: `client/src/UIModule.ts`)

One module owning the in-match DOM; `createUI(container, net)` → `{ update(state), pushEvent(text),
onDetach() }`-style surface (plan fixes exact shape). Replaces the `#status` line with:
- **Scorer's board** (fixed, top-left, parchment idiom): `A x½ – B y½`; `innings n of N` (+
  `TIEBREAK` badge); `outs`; current batter and bowler as `Name [ability_tag]`; `PRESSURE` badge
  when the synced state implies it is derivable — NOTE: pressure is currently server-internal; if
  not cheaply derivable client-side (final innings OR 2+ runners on posts — both ARE derivable
  from synced state: inningsIndex vs INNINGS_COUNT, runners map), derive it locally, do not add
  schema; subs-used when fielding; `you are A · batting` identity line.
- **Event feed**: the last 6 entries, newest first, each a short plain-English line — play
  resolutions (reusing the existing describeResolution wording), YOUR rejections (plain words, not
  raw reasons), opponent joined/left, paused/reconnecting/resumed, rematch started. Feed is
  per-match (cleared on lobby return AND on rematch — closes the stale `lastPlay` minor).
- **Contextual key legend**: one row listing ONLY the keys valid for this client's role in the
  current phase, lit; the full vocabulary shown greyed otherwise. Mapping (from InputModule):
  DRAFT → none (mouse); INITIAL_POSITIONING/PRE_PLAY → `Enter confirm/ready` + fielding-side
  mouse hints (`click fielder → click ground`, `Esc clear`); PLAY batting → `Space swing · R run ·
  T stop`; PLAY fielding → `A/S/D spin · P pitch`; GAME_OVER → `N rematch`. Paused overrides all
  to a `paused` notice.
- **Result overlay** (GAME_OVER): final score writ large, `WINNER: side` (or the winner's squad
  side letter + first-pick name for flavour — keep simple: side letter), innings count line, a
  REMATCH button (sends the same `rematch` message as N — either player, casual) and a LEAVE
  button (consented `room.leave()` → lobby). Overlay hides on rematch (phase leaves GAME_OVER).

## 2. Lobby restyle

Same overlay, same flow (create/join/code proven — M6): refined presentation only. Title
treatment for "Carl Quest Sports", create and join as two clearly separated paths, the shareable
code displayed large with a `share this code` cue, error text styling. No logic changes.

## 3. Client hardening (absorbed deferred fixes)

- **NetModule reconnect flow** (closes the M6 §6.4 "client reconnect gap" known issue):
  - After every successful join/create/reconnect, store `room.reconnectionToken` in
    `sessionStorage` (per-tab; a refresh loses the room object anyway — token survives for the
    refresh-rejoin case only if cheap; the REQUIRED path is the live-socket-drop case).
  - On an UNEXPECTED room leave (colyseus.js `room.onLeave` with a non-consented code, or
    `onError`): attempt ONE `client.reconnect(token)`; UI shows `reconnecting…`; success rebinds
    the same Net surface (the room object changes — the plan must specify how listeners re-attach;
    acceptable shape: `connect()` returns a Net whose internals swap the room and re-register, or
    main.ts tears down and re-runs runMatch with the new room — plan decides, correctness first).
  - On reconnect failure, consented leave, or `opponentLeft`: catch-all teardown — detach input +
    positioning controls, clear selection, clear the stored token, return to the lobby with a
    message. NO path may leave a dead-connection client with live-looking UI.
- **RenderModule per-frame smoothing**: lerp each capsule/ball per ANIMATION FRAME towards the
  last-known schema target (state change only updates the target), replacing per-patch lerp —
  fixes the §6.4 reposition-capsule-midway quirk at the root. During INITIAL_POSITIONING/PRE_PLAY
  a reposition may still animate (pleasant) but must converge without further patches.
- **Out-runner presentation**: on a `playOutcome` whose `outs` list is non-empty, the out
  runner's capsule tints red and topples (rotate ~90°) for ~1.5 s before removal (client-side
  timer; the schema delete already arrives — delay the visual removal only). Closes the §6.4
  "out runner simply vanishes" item.
- **Batting panel additions** (DraftScreen batting mode): a `now batting: Name` header row and a
  `parked: Name @ post n` section derived from state.runners (atPost ≥ 1, not out) — closes the
  M8 reviewer's M10 note.
- **InputModule paused gating**: while `state.paused === true`, gameplay keys do nothing locally
  (no guaranteed-rejection round-trips).

## 4. Server changes

NONE expected. Everything renders from already-synced state; pressure is derived client-side.
If acceptance exposes a genuine server need, STOP and report (standing rule).

## 5. Verification and acceptance (§9.10)

- `npm run check` green (client typecheck/lint; server suite untouched — any server test change
  is a red flag).
- Browser acceptance IS this milestone's proof (Playwright, two pages, committed under
  `docs/superpowers/acceptance/`): full game through the real UI — lobby create/join (screenshot),
  draft click-through (existing helper), HUD mid-play with scoreboard + feed + lit legend
  (screenshot), a run-out or caught event appearing in the feed, GAME_OVER result overlay
  (screenshot), REMATCH button click → fresh game state; **reconnect drill**: page B goes offline
  (Playwright `context.setOffline(true)`), page A shows paused, B back online → auto-reconnect →
  A shows resumed and B's UI is live again (assert from DOM state, screenshot the reconnecting
  state if capturable). Scripted WS acceptance: NOT needed this milestone (no server change) —
  recorded as the scope decision.

## 6. Out of scope

- Clickable play buttons; mobile/responsive; spectators; sound; character art (capsules stay);
  ranked mode UI; roster growth. Client unit tests remain deliberately absent (convention:
  browser acceptance is the client's proof layer).
