# Milestone 10 — UI Polish + Client Hardening Implementation Plan (FINAL milestone)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the status line with a real HUD (scorer's board + event feed + contextual key legend + result overlay), restyle the lobby, and close the deferred client gaps (reconnect flow, per-frame render smoothing, out-runner presentation, paused key gating).

**Architecture:** New `UIModule` owns all in-match HUD DOM; `main.ts` becomes pure orchestration with a single teardown path (reconnect re-runs the same match wiring against the new room). RenderModule views become self-animating (per-frame lerp via their own rAF loop). ZERO server changes.

**Tech Stack:** Plain DOM + Three.js, colyseus.js reconnection API, Playwright acceptance.

**Design spec:** `docs/superpowers/specs/2026-07-04-m10-ui-polish-design.md` — read before any task.

## Global Constraints

- CLIENT-ONLY milestone: no file under `server/` or `shared/` may change. Any server test change is a defect signal — stop and report.
- TypeScript strict; British English; plain DOM (no framework); the parchment scorer's-sheet identity (monospace, `#f5f1e6`, hairline borders, bracketed badges, no gradients/shadows/emoji) is refined, not reinvented — unslop-ui pass mandatory for every new surface.
- Client has no unit tests by convention: per-task verification = `/client` `npx tsc --noEmit -p tsconfig.json` + repo-root `npx eslint client/src`; behaviour proof is Task 4's Playwright acceptance. Full `npm run check` must stay green (server suite untouched at 357/357).
- `performance.now()`/rAF are fine client-side (the determinism rule binds server physics only).
- NO path may leave a dead-connection client with live-looking UI (spec §3).
- Concurrent implementers do NOT commit; controller serialises. Worktree via superpowers:using-git-worktrees.

## File Structure

- Create: `client/src/UIModule.ts` (scoreboard, feed, legend, result overlay — one module, one `update`)
- Modify: `client/src/NetModule.ts` (reconnect surface), `client/src/InputModule.ts` (paused gating), `client/src/RenderModule.ts` (self-animating views + out-runner), `client/src/main.ts` (orchestration rewrite), `client/src/DraftScreen.ts` (batting panel additions), `client/index.html` (HUD/lobby markup + styles; `#status` removed)
- Create: `docs/superpowers/acceptance/m10-*` (Task 4)

**Sequencing:** Task 1 (net/input hardening) ∥ Task 2 (render) — disjoint files, NEITHER touches main.ts → Task 3 (UIModule + main.ts rewrite + lobby restyle + panel additions, consumes both) → Task 4 (acceptance + docs + project close-out).

---

### Task 1: NetModule reconnect surface + InputModule paused gating

**Files:**
- Modify: `client/src/NetModule.ts`, `client/src/InputModule.ts`

**Interfaces:**
- Produces (Task 3 wires these): `Net` gains

```typescript
  /**
   * Fires ONCE if the room connection drops without us leaving deliberately
   * (raw socket loss, server crash — NOT consented leave() and NOT after
   * opponentLeft, both of which are deliberate teardowns).
   */
  onUnexpectedDisconnect(callback: () => void): void;
  /**
   * One reconnect attempt with the stored token. Resolves a FRESH Net bound to
   * the recovered room (the old Net is dead — re-run all match wiring against
   * the new one), or null when the grace expired / token invalid / offline.
   */
  tryReconnect(): Promise<Net | null>;
  /** Mark the next room leave as deliberate (suppresses onUnexpectedDisconnect). */
  markLeaving(): void;
```

  Implementation contract: store `room.reconnectionToken` on every successful connect/reconnect (module-level variable is sufficient; sessionStorage optional — the required path is the live-socket-drop case, spec §3); `room.onLeave(code)` handler distinguishes deliberate (a `leaving` flag set by `markLeaving()` — called by main.ts before `room.leave()` — or a prior `opponentLeft`) from unexpected; `tryReconnect` uses `client.reconnect(token)` (same `Client` instance or a fresh one — colyseus.js accepts a fresh client with the token) and rebuilds the full Net object the same way `connect` does (extract a shared `wrapRoom(room): Net` internal so connect/tryReconnect cannot drift).
- InputModule: gameplay keys (`KeyA/S/D/P/Space/R/T`) do nothing while `net.room.state.paused === true` (Enter/N stay live — harmless and phase-checked). Add a `paused()` read via the room state, not a new Net method.

- [ ] **Step 1: Implement NetModule** per the contract above — refactor `connect`'s return-object literal into `wrapRoom(room)`; add the three new members + the internal `leaving`/token state; `onOpponentLeft` implies deliberate (set the flag when that message fires so the subsequent room close does not also fire onUnexpectedDisconnect).
- [ ] **Step 2: Implement InputModule gating** — first line of the keydown handler's gameplay cases: `if (net.room.state.paused === true) break;` (or a guard before the switch for the gameplay-key subset; keep Enter/N outside it).
- [ ] **Step 3: Verify** — `/client` `npx tsc --noEmit -p tsconfig.json`; root `npx eslint client/src`. Both clean (main.ts does not yet call the new members — additive surface, still compiles). Controller commits: `feat(client): reconnect surface + paused key gating`.

---

### Task 2: RenderModule — self-animating views + out-runner presentation

**Files:**
- Modify: `client/src/RenderModule.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 3 wires): views become SELF-ANIMATING — `createBallView/createFieldersView/createRunnersView` each start their own `requestAnimationFrame` loop lerping meshes towards last-known targets (a time-based factor, e.g. `1 − 0.001^dt` so convergence is framerate-independent; document the constant); `update(...)` now only records targets/visibility (no lerp). Each view gains `dispose(): void` cancelling its rAF (Task 3 does not need to call it today — one scene per page — but the surface must exist so teardown is possible). `RunnersView` gains `markOut(id: string): void` — the runner's mesh tints red and topples (rotate z to ~90°) and is retained ~1.5 s (performance.now timer) before removal even if the schema entry has been deleted (update()'s reconciliation must respect a `dyingUntil` timestamp per id). `FieldersView.pickId/setSelected` unchanged.

- [ ] **Step 1: Implement** per the contract. Key details: targets map per view (position + visible/material state); rAF loop lerps `mesh.position` towards target each frame; a repositioned fielder converges with NO further patches (the M8 §6.4 quirk's root fix); `markOut` sets tint (reuse a dedicated `outMat` red Lambert), rotation, and `dyingUntil = performance.now() + 1500`; reconciliation removes a mesh only when unseen AND (`no dyingUntil` OR expired); toppled runners do not lerp position (freeze where they fell).
- [ ] **Step 2: Verify** — typecheck + eslint clean; existing main.ts still compiles (update signatures unchanged). Controller commits: `feat(client): self-animating render views + out-runner presentation`.

---

### Task 3: UIModule + main.ts orchestration rewrite + lobby restyle + panel additions

**Files:**
- Create: `client/src/UIModule.ts`
- Modify: `client/src/main.ts`, `client/index.html`, `client/src/DraftScreen.ts`

**Interfaces:**
- Consumes: Task 1's `onUnexpectedDisconnect`/`tryReconnect`/`markLeaving`; Task 2's `markOut`; existing `describeResolution` wording (moves INTO UIModule); DraftScreen's `update(state, mySide)`.
- Produces:

```typescript
// client/src/UIModule.ts
export interface UI {
  /** Re-render board/legend/result from synced state; call on every onStateChange. */
  update(state: MatchStateView, net: Net): void;
  /** Push a plain-English line onto the event feed (newest first, keeps 6). */
  pushEvent(text: string): void;
  /** Clear the feed and hide overlays (rematch and lobby-return call this). */
  reset(): void;
  /** Result-overlay button hooks, wired once by main.ts. */
  onRematchClick(cb: () => void): void;
  onLeaveClick(cb: () => void): void;
}
export function createUI(container: HTMLElement): UI;
```

- [ ] **Step 1: unslop-ui skill FIRST**, then markup/styles in `client/index.html`: `#hud` container (board top-left; feed below it; legend bottom-centre; result overlay centred, hidden) replacing `#status`; lobby restyle (title treatment, two clear create/join paths, large code display with a `share this code` cue). Same parchment tokens; no new hues.
- [ ] **Step 2: UIModule.** Board per spec §1 (score `A x½ – B y½`, `innings n of ${CONST.GAME.INNINGS_COUNT * 2}` slots — display as `innings n` + `TIEBREAK` badge to avoid inventing display maths beyond what the status line showed, `outs`, `batting: Name [ability]` / `bowling: Name [ability]`, PRESSURE badge derived client-side: `inningsIndex >= INNINGS_COUNT * 2 - 1 (final innings) OR ≥2 runners map entries with atPost >= 1`, `subs used: n` when you field, `you are A · batting` identity). Feed: 6 entries, newest first. Legend mapping exactly per spec §1 (DRAFT → mouse note; positioning → Enter + fielding mouse hints; PLAY batting → `Space swing · R run · T stop`; PLAY fielding → `A/S/D spin · P pitch`; GAME_OVER → `N rematch`; paused overrides all). Result overlay on `phase === 'GAME_OVER'`: score, `WINNER: A|B`, REMATCH + LEAVE buttons.
- [ ] **Step 3: main.ts rewrite.** Remove `statusLine`/`HELP`/`describeCause`/`describeResolution` (move the describe helpers into UIModule); `runMatch(net)` restructured around a single `teardown()` (detach input + positioning controls, `selection.set(null)`, `ui.reset()`); wire: `net.onPlayOutcome` → `ui.pushEvent(describe…)` + `runners.markOut(id)` for each `resolution.outs` entry; `net.onRejected` → `ui.pushEvent` (plain words: map `wrongRole` → `not your role`, `paused` → `game is paused`, else the prose reason); `net.onOpponentLeft` → pushEvent + teardown + `net.markLeaving()` + leave + lobby; `net.onUnexpectedDisconnect` → show `reconnecting…` (feed + legend override), `await net.tryReconnect()` — success: teardown the OLD wiring and `runMatch(newNet)` (feed keeps a `reconnected` entry via the new ui? acceptable: fresh UI with one `reconnected` entry); failure: teardown → lobby with `connection lost`. Result overlay buttons: rematch → `net.sendRematch()`; leave → `net.markLeaving()` + `room.leave()` + lobby. `onStateChange` keeps the existing render/draft/selection logic + `ui.update(state, net)`.
- [ ] **Step 4: DraftScreen batting additions**: batting mode gains a `now batting: Name` header row and `parked: Name @ post n` rows derived from `state.runners` (atPost ≥ 1, not out, not running). Rows non-clickable (informational).
- [ ] **Step 5: Verify** — typecheck + eslint clean; manual smoke (`npm run dev`, two tabs: HUD renders, legend flips with role, result overlay on a quick game if feasible — otherwise leave to Task 4). Controller commits: `feat(client): UIModule HUD, result overlay, lobby restyle, batting panel info`.

---

### Task 4: Browser acceptance + docs + project close-out

**Files:**
- Create: `docs/superpowers/acceptance/m10-browser-acceptance.mjs`, `m10-acceptance.txt`, `m10-0*.png`
- Modify: `CLAUDE.md` §6, `TUNING.md` (only if warranted)

- [ ] **Step 1: Playwright acceptance** (two pages vs `npm run dev`; pattern: m7/m8 harnesses; assertion-based, exit non-zero): lobby create/join through the RESTYLED UI (screenshot m10-01); full draft click-through (existing helper); play to at least one resolved play via real keydowns asserting: scoreboard values match state, the event feed shows the play resolution line, the key legend shows exactly the batting keys on the batting page and fielding keys on the other (DOM assertions; screenshot m10-02 mid-play HUD); drive to GAME_OVER (ALWAYS-CATCH-style fast innings are not available client-side — play with the flat-drive keys and accept a longer run, or end via outs; budget ≤ 5 min), assert the result overlay (score + winner) and click REMATCH → assert fresh state (score zeroed, overlay gone, feed shows `rematch`; screenshot m10-03); **reconnect drill**: page B `context.setOffline(true)` → page A shows paused (board/feed), B `setOffline(false)` → B's `tryReconnect` path fires → assert BOTH pages live again (A unpaused, B's HUD updating; log the sequence); out-runner: assert a red/toppled capsule is visible within ~1.5 s of an out event if one occurs on-screen (best-effort — log honestly if the game produced no out in view).
- [ ] **Step 2: Docs.** CLAUDE.md §6.1 overwrite: **M10 complete = ALL TEN MILESTONES COMPLETE** — the §9 build order is done; state the project's full shipped surface in one paragraph; per-file test counts; evidence paths. §6.2 rows: reconnect one-attempt design; self-animating views; result-overlay rematch = same either-player message. §6.3 entry. §6.4: REMOVE the client-reconnect-gap item (fixed + drilled live), the capsule-lerp item (root-fixed), the out-runner-invisible item (presented), the paused-round-trip item (gated); keep server-side leftovers honestly (seed option gating, thrown-ball caught classification, roster growth). TUNING.md only if a real tunable emerged.
- [ ] **Step 3:** `npm run check` green (server 357 untouched); kill servers; no lock churn; commit `docs: M10 acceptance evidence and project log — all milestones complete`.

---

## Self-Review Notes (already applied)

- Spec §1→T3, §2→T3, §3→T1+T2+T3, §4 (no server) → Global Constraints, §5→T4, §6 respected.
- Type consistency: `onUnexpectedDisconnect`/`tryReconnect`/`markLeaving` (T1) consumed by name in T3; `markOut(id)`/`dispose()` (T2) consumed in T3; `UI` shape defined in T3 and used only there + T4's DOM assertions.
- The reconnect re-wire deliberately re-runs `runMatch` against the fresh Net (old listeners die with the old room object — the M6-era analysis already established room-scoped listeners are safe to abandon; the ONLY window-level listeners are input/positioning, both detached in `teardown()`).
- `#status` removal: the m5–m8 acceptance harnesses reference `#status` — they are FROZEN EVIDENCE, not regression suites; they are not re-run and must NOT be edited (note for the T4 implementer; §6.3 records the supersession).
