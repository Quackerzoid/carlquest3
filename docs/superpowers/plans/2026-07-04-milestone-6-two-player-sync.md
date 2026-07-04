# Milestone 6 — Two-Player Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two clients join one MatchRoom by a 4-letter room code, are seated as sides A/B, and play the full M5 game against each other with every message gated by role; a disconnect pauses the game with a 60 s reconnect grace.

**Architecture:** All multiplayer state (seats, code, pause) lives in MatchRoom/MatchState — RulesModule stays a pure game-rules machine and is NOT modified. Role is derived (`sideOf(client)` vs `rules.view().battingSide`), never stored. The client derives `mySide` by comparing `room.sessionId` to the synced seat fields.

**Tech Stack:** Colyseus 0.15 (`filterBy` matchmaking, `allowReconnection`), colyseus.js, @colyseus/testing + Vitest, Vite/TS client.

**Design spec:** `docs/superpowers/specs/2026-07-04-m6-two-player-sync-design.md` — read it before starting any task.

## Global Constraints

- TypeScript strict; no `any`/`@ts-ignore` without a justifying comment. British English.
- All tunables in `shared/src/constants.ts` (one new: `GAME.RECONNECT_GRACE_S = 60`). No magic numbers elsewhere.
- Server authoritative; every message validated server-side (phase AND role). RulesModule must not be edited.
- Verification for every task: `npm run check` green across all workspaces (typecheck ×3, ESLint, Vitest).
- **Existing-test churn is expected and REQUIRED:** the lobby wait and both-confirm gates break most existing MatchRoom tests. Update the tests/helpers to the new protocol; NEVER weaken a gate to keep an old test green.
- Rejection reasons used by tests/clients are exact strings: `'wrongRole'`, `'paused'`. Other reasons stay prose.
- Work happens in a worktree created via superpowers:using-git-worktrees; commits per task by the controller session.

## File Structure

- `shared/src/constants.ts` — +`RECONNECT_GRACE_S` (Task 3).
- `server/src/app.config.ts` — `filterBy(['code'])` (Task 1).
- `server/src/rooms/MatchState.ts` — +`roomCode`, `sessionA/B`, `connectedA/B` (Task 1), +`paused` (Task 3).
- `server/src/rooms/MatchRoom.ts` — seats/lobby (Task 1), role + both-confirm gating (Task 2), disconnect/pause (Task 3).
- `server/test/MatchRoom.test.ts` — helper migration + new gate tests (Tasks 1–3).
- `client/src/NetModule.ts`, `InputModule.ts`, `main.ts`, `client/index.html` — create/join, mySide, lobby screen, role-gated keys, status states (Task 4).
- `docs/superpowers/acceptance/m6-*` — acceptance evidence (Task 5).

**Sequencing:** Task 1 → Task 2 → Task 3 (same server files, sequential). Task 4 depends only on Task 1's schema fields and may run in parallel with Tasks 2–3. Task 5 last.

---

### Task 1: Seats, room code, lobby wait (server)

**Files:**
- Modify: `server/src/app.config.ts`
- Modify: `server/src/rooms/MatchState.ts`
- Modify: `server/src/rooms/MatchRoom.ts:56-67` (options), `:128-163` (onCreate), `:165-178` (onJoin/onLeave)
- Test: `server/test/MatchRoom.test.ts`

**Interfaces:**
- Consumes: existing `rules.bothConnected()`, `rules.completeDraft()` (RulesModule, unchanged).
- Produces: `MatchState.roomCode/sessionA/sessionB/connectedA/connectedB: string|string|string|boolean|boolean`; `MatchRoomOptions.code?: string`; room named `'match'` filtered by `['code']`; test helper `connectPair(room)` returning `{ clientA, clientB }` (join order = A then B). Tasks 2–4 rely on these exact names.

- [ ] **Step 1: Write the failing tests** — append a `describe('M6 lobby & seats', ...)` block:

```typescript
describe('M6 lobby & seats', () => {
  it('holds in LOBBY with one client, advances on the second, seats by join order', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const clientA = await colyseus.connectTo(room);
    await awaitClientState(clientA);
    for (let i = 0; i < 30; i += 1) await room.waitForNextSimulationTick();
    expect(room.state.phase).toBe('LOBBY'); // no fast-forward on first join any more
    expect(room.state.sessionA).toBe(clientA.sessionId);
    expect(room.state.sessionB).toBe('');

    const clientB = await colyseus.connectTo(room);
    await awaitClientState(clientB);
    await waitForPhase(room, 'INITIAL_POSITIONING');
    expect(room.state.sessionB).toBe(clientB.sessionId);
    expect(room.state.connectedA).toBe(true);
    expect(room.state.connectedB).toBe(true);
  });

  it('matches a filtered join to the room with that code, and rejects a wrong code', async () => {
    const created = await colyseus.sdk.create<MatchState>('match', { code: 'ABCD' });
    const joined = await colyseus.sdk.join<MatchState>('match', { code: 'ABCD' });
    expect(joined.roomId).toBe(created.roomId);
    await expect(colyseus.sdk.join('match', { code: 'ZZZZ' })).rejects.toThrow();
    await created.leave();
    await joined.leave();
  });

  it('mirrors a valid creation code into state and rejects a malformed one', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { code: 'GXQT' });
    expect(room.state.roomCode).toBe('GXQT');
    await expect(colyseus.createRoom('match', { code: 'nope!' })).rejects.toThrow();
  });

  it('locks the room at two clients', async () => {
    const room = await colyseus.createRoom<MatchState>('match', {});
    await connectPair(room);
    await expect(colyseus.connectTo(room)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Add the `connectPair` helper** next to `awaitClientState`:

```typescript
/** Seat two clients (join order fixes sides: first = A, second = B) and await both snapshots. */
async function connectPair(room: TestRoom): Promise<{ clientA: TestClient; clientB: TestClient }> {
  const clientA = await colyseus.connectTo(room);
  const clientB = await colyseus.connectTo(room);
  await awaitClientState(clientA);
  await awaitClientState(clientB);
  return { clientA, clientB };
}
```

- [ ] **Step 3: Run the new tests to verify they fail** — `npx vitest run test/MatchRoom.test.ts -t 'M6 lobby'` in `/server`. Expected: FAIL (phase already INITIAL_POSITIONING after one join; `sessionA` undefined).

- [ ] **Step 4: Schema fields** — in `MatchState.ts` add to `MatchState` (after `lastRejection`):

```typescript
  // --- M6 seats & room code -------------------------------------------------
  /** 4-letter room code from the creation options ('' if created without one, e.g. tests). */
  @type('string') roomCode = '';
  /** SessionIds seated as side A (creator/first join) and side B; '' while unseated. */
  @type('string') sessionA = '';
  @type('string') sessionB = '';
  @type('boolean') connectedA = false;
  @type('boolean') connectedB = false;
```

- [ ] **Step 5: filterBy** — in `app.config.ts`:

```typescript
    gameServer.define('match', MatchRoom).filterBy(['code']);
```

- [ ] **Step 6: Options + onCreate + onJoin/onLeave** — in `MatchRoom.ts`:

Add `code?: string` to `MatchRoomOptions` (documented: client-generated rendezvous string — `filterBy` matches creation options, so the server cannot invent it). At the TOP of `onCreate`, before `setState`:

```typescript
    // The room code is client-generated (filterBy matches CREATION options; a
    // server-invented code could never match a filtered join). Absent = no code
    // (tests / direct createRoom); present-but-malformed = reject the creation.
    if (options.code !== undefined && !/^[A-Z]{4}$/.test(String(options.code))) {
      throw new Error(`invalid room code: ${String(options.code)}`);
    }
```

After `this.setState(new MatchState())`: `if (options.code !== undefined) this.state.roomCode = options.code;`

Replace `onJoin`/`onLeave` (the M5 fast-forward stub goes away):

```typescript
  override onJoin(client: Client): void {
    if (this.state.sessionA === '') {
      this.state.sessionA = client.sessionId;
      this.state.connectedA = true;
    } else if (this.state.sessionB === '') {
      this.state.sessionB = client.sessionId;
      this.state.connectedB = true;
      // Both seats filled: leave LOBBY. DRAFT stays auto-skipped with the
      // mirror-roster demo squads until M7.
      this.rules.bothConnected();
      this.rules.completeDraft();
    }
    this.syncRulesView();
  }

  override onLeave(client: Client): void {
    // Pre-game leave frees the seat; mid-game disconnect handling lands in Task 3.
    if (this.phase() !== 'LOBBY') return;
    if (this.state.sessionA === client.sessionId) {
      this.state.sessionA = '';
      this.state.connectedA = false;
    } else if (this.state.sessionB === client.sessionId) {
      this.state.sessionB = '';
      this.state.connectedB = false;
    }
  }
```

- [ ] **Step 7: Migrate every existing test to two clients.** Each existing test does `createRoom` + one `connectTo` — change each to `const { clientA } = await connectPair(room);` (destructure `clientB` only where needed) and keep sending from `clientA` (any-client gating is unchanged until Task 2). `startPlay(room, client)` keeps its signature this task; call it with `clientA`.

- [ ] **Step 8: Run the full file** — `npx vitest run test/MatchRoom.test.ts`. Expected: ALL pass (new + migrated).

- [ ] **Step 9: `npm run check`** at repo root. Expected: green. Then commit (controller): `feat(server): M6 seats, room-code matchmaking, real lobby wait`.

---

### Task 2: Role gating and both-players confirm gates (server)

**Files:**
- Modify: `server/src/rooms/MatchRoom.ts` (handlers, message registration, new private helpers)
- Test: `server/test/MatchRoom.test.ts`

**Interfaces:**
- Consumes: Task 1's `sessionA/sessionB` seats.
- Produces: rejection reason exact string `'wrongRole'`; both-confirm semantics (one side's confirm/ready is idempotent and does not transition). Test helpers change signature: `startPlay(room, clientA, clientB)`, `pitchThenSwing(room, clientA, clientB, aim)`, `pitchThenSwingAtTarget(room, clientA, clientB, target, lateTicks, aimY?)` — later tasks and all tests use these.

- [ ] **Step 1: Write the failing tests:**

```typescript
describe('M6 role gating', () => {
  it('rejects a pitch from the batting side and accepts it from the fielding side', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    // Side A bats first (battingSide 'A' at match start) → A may NOT pitch.
    clientA.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
    clientB.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(true);
  });

  it('rejects swing and runDecision from the fielding side', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    clientB.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await waitNearPlane(room);
    clientB.send('swing', { timing: 0, aim: { x: 0.55, y: 0.47, z: 0.65 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
    clientB.send('runDecision', { go: false });
    await room.waitForNextSimulationTick();
    expect(JSON.parse(room.state.lastRejection).reason).toBe('wrongRole');
  });

  it('requires BOTH sides to confirm positioning and ready up (duplicates idempotent)', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await waitForPhase(room, 'INITIAL_POSITIONING');
    clientA.send('confirmPositioning');
    clientA.send('confirmPositioning'); // duplicate: accepted, no transition, no rejection
    for (let i = 0; i < 10; i += 1) await room.waitForNextSimulationTick();
    expect(room.state.phase).toBe('INITIAL_POSITIONING');
    expect(room.state.lastRejection).toBe('');
    clientB.send('confirmPositioning');
    await waitForPhase(room, 'PRE_PLAY');
    clientB.send('readyForPlay');
    for (let i = 0; i < 10; i += 1) await room.waitForNextSimulationTick();
    expect(room.state.phase).toBe('PRE_PLAY');
    clientA.send('readyForPlay');
    await waitForPhase(room, 'PLAY');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/MatchRoom.test.ts -t 'M6 role'`. Expected: FAIL (pitch from A accepted; single confirm transitions).

- [ ] **Step 3: Implement.** In `MatchRoom.ts`:

Import `type TeamSide` from `@carlquest/shared`. Add fields + helpers:

```typescript
  /** Per-side confirmations for the current INITIAL_POSITIONING / PRE_PLAY gate. */
  private confirmed: Record<TeamSide, boolean> = { A: false, B: false };
  private ready: Record<TeamSide, boolean> = { A: false, B: false };

  /** Which seat a message came from; null = not seated (defensive — reject). */
  private sideOf(client: Client): TeamSide | null {
    if (client.sessionId === this.state.sessionA) return 'A';
    if (client.sessionId === this.state.sessionB) return 'B';
    return null;
  }

  private fieldingSide(): TeamSide {
    return this.rules.view().battingSide === 'A' ? 'B' : 'A';
  }
```

Message registration passes the client through to the three parameterless handlers:

```typescript
    this.onMessage('confirmPositioning', (client) => this.handleConfirmPositioning(client));
    this.onMessage('readyForPlay', (client) => this.handleReadyForPlay(client));
    this.onMessage('rematch', (client) => this.handleRematch(client));
```

Role gates — `handlePitch` (rename `_client` → `client`), directly after its phase check:

```typescript
    if (this.sideOf(client) !== this.fieldingSide()) {
      this.reject('pitch', 'wrongRole');
      return;
    }
```

`handleSwing` and `handleRunDecision` get the mirror-image gate after their phase checks:

```typescript
    if (this.sideOf(client) !== this.rules.view().battingSide) {
      this.reject('swing', 'wrongRole'); // 'runDecision' in that handler
      return;
    }
```

Both-players gates (RulesModule still fires its single transition once):

```typescript
  private handleConfirmPositioning(client: Client): void {
    const side = this.sideOf(client);
    if (side === null) {
      this.reject('confirmPositioning', 'wrongRole');
      return;
    }
    if (this.phase() !== 'INITIAL_POSITIONING') {
      this.reject('confirmPositioning', `only allowed in INITIAL_POSITIONING (phase ${this.phase()})`);
      return;
    }
    this.confirmed[side] = true; // duplicate confirm is idempotent, not a rejection
    if (this.confirmed.A && this.confirmed.B) {
      this.rules.confirmPositioning();
      this.confirmed = { A: false, B: false };
      this.syncRulesView();
    }
  }

  private handleReadyForPlay(client: Client): void {
    const side = this.sideOf(client);
    if (side === null) {
      this.reject('readyForPlay', 'wrongRole');
      return;
    }
    if (this.phase() !== 'PRE_PLAY') {
      this.reject('readyForPlay', `only allowed in PRE_PLAY (phase ${this.phase()})`);
      return;
    }
    this.ready[side] = true;
    if (this.ready.A && this.ready.B) {
      this.rules.readyForPlay();
      this.ready = { A: false, B: false };
      this.syncRulesView();
    }
  }
```

`handleRematch(client: Client)`: add the same `sideOf === null → reject('rematch', 'wrongRole')` guard at the top; otherwise unchanged (either seated player may rematch — casual default, design §2). Reset the gate collectors wherever a phase is (re-)entered so stale half-confirms never leak: in `endPlay` (returns to PRE_PLAY) and in `handleRematch` after the rules call, add:

```typescript
    this.confirmed = { A: false, B: false };
    this.ready = { A: false, B: false };
```

- [ ] **Step 4: Migrate the helpers and every test to role-correct senders.** New helper + signature changes:

```typescript
/** The client currently batting / fielding (side A bats first; innings switches flip it). */
function battingClient(room: TestRoom, clientA: TestClient, clientB: TestClient): TestClient {
  return room.state.battingSide === 'A' ? clientA : clientB;
}
function fieldingClient(room: TestRoom, clientA: TestClient, clientB: TestClient): TestClient {
  return room.state.battingSide === 'A' ? clientB : clientA;
}
```

- `startPlay(room, clientA, clientB)`: send `confirmPositioning` from BOTH clients, then `readyForPlay` from BOTH.
- `pitchThenSwing` / `pitchThenSwingAtTarget` take `(room, clientA, clientB, ...)`: pitch from `fieldingClient(...)`, swing from `battingClient(...)` — resolved per call, since full-game tests cross innings switches.
- `runDecision` sends switch to `battingClient(...)`.
- Update every call site. The full-game GAME_OVER/rematch tests loop plays across innings — the per-call helpers handle the flip automatically.

- [ ] **Step 5: Run the full file** — `npx vitest run test/MatchRoom.test.ts`. Expected: ALL pass. Watch for tests that asserted `lastRejection` prose reasons — only `wrongRole`/`paused` are exact strings; do not rewrite other reasons.

- [ ] **Step 6: `npm run check`** green. Commit: `feat(server): per-role message gating and both-players confirm gates`.

---

### Task 3: Disconnect pause, reconnect grace, consented quit (server)

**Files:**
- Modify: `shared/src/constants.ts` (+`RECONNECT_GRACE_S`), `shared/test/constants.test.ts`
- Modify: `server/src/rooms/MatchState.ts` (+`paused`), `server/src/rooms/MatchRoom.ts` (onLeave, tick gate, paused rejections, options)
- Test: `server/test/MatchRoom.test.ts`

**Interfaces:**
- Consumes: Task 1 seats, Task 2 `sideOf`.
- Produces: `MatchState.paused: boolean`; broadcast `'opponentLeft'` with payload `{ side: TeamSide }`; rejection reason `'paused'`; `MatchRoomOptions.reconnectGraceS?: number` (test-only override, runtime-validated like `seed`); `CONST.GAME.RECONNECT_GRACE_S = 60`.

- [ ] **Step 1: Write the failing tests:**

```typescript
describe('M6 disconnect handling', () => {
  it('an unconsented drop pauses the game (ball frozen) and a reconnect resumes it', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    fieldingClient(room, clientA, clientB).send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await waitNearPlane(room); // ball demonstrably in flight
    const token = clientB.reconnectionToken;
    await clientB.leave(false); // unconsented
    await waitForCondition(room, () => room.state.paused);
    const frozen = { x: room.state.ball.x, z: room.state.ball.z };
    for (let i = 0; i < 30; i += 1) await room.waitForNextSimulationTick();
    expect(room.state.ball.x).toBe(frozen.x);
    expect(room.state.ball.z).toBe(frozen.z);
    // Gameplay is rejected while paused.
    clientA.send('swing', { timing: 0, aim: { x: 0.55, y: 0.47, z: 0.65 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    expect(JSON.parse(room.state.lastRejection).reason).toBe('paused');
    const rejoined = await colyseus.sdk.reconnect(token);
    await waitForCondition(room, () => !room.state.paused);
    expect(room.state.connectedB).toBe(true);
    await rejoined.leave();
  });

  it('a consented mid-game leave notifies the survivor and disposes the room', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS });
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    const left = new Promise<{ side: string }>((resolve) => {
      clientA.onMessage('opponentLeft', (m: { side: string }) => resolve(m));
    });
    await clientB.leave(true); // deliberate quit
    expect((await left).side).toBe('B');
  });

  it('grace expiry disposes the room (short test-only grace)', async () => {
    const room = await colyseus.createRoom<MatchState>('match', { rng: ALWAYS_MISS, reconnectGraceS: 1 });
    const { clientA, clientB } = await connectPair(room);
    await startPlay(room, clientA, clientB);
    const left = new Promise<{ side: string }>((resolve) => {
      clientA.onMessage('opponentLeft', (m: { side: string }) => resolve(m));
    });
    await clientB.leave(false);
    expect((await left).side).toBe('B'); // fires when the 1 s grace lapses
  });
});
```

Helper (next to `waitForPhase`):

```typescript
/** Poll the room until `cond()` is true, or throw. */
async function waitForCondition(room: TestRoom, cond: () => boolean, maxTicks = 300): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (cond()) return;
    await room.waitForNextSimulationTick();
  }
  throw new Error('condition not reached');
}
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/MatchRoom.test.ts -t 'M6 disconnect'`. Expected: FAIL (`paused` undefined; no `opponentLeft`).

- [ ] **Step 3: Constant.** In `shared/src/constants.ts` `GAME` block: `/** Seconds a mid-game disconnected player may reconnect before the room disposes. */ RECONNECT_GRACE_S: 60,` — add the matching structural pin in `shared/test/constants.test.ts` alongside the other GAME values (write it first if following strict TDD file order; both land this step).

- [ ] **Step 4: Schema + options.** `MatchState`: `/** True while a mid-game disconnect grace runs — the simulation is frozen. */ @type('boolean') paused = false;`. `MatchRoomOptions`: `reconnectGraceS?: number` (doc: test-only, wire-reachable like `seed`, runtime-validated). In `onCreate`: `this.reconnectGraceS = isFiniteNumber(options.reconnectGraceS) && options.reconnectGraceS > 0 ? options.reconnectGraceS : GAME.RECONNECT_GRACE_S;` with the field `private reconnectGraceS = CONST.GAME.RECONNECT_GRACE_S;`.

- [ ] **Step 5: onLeave.** Replace Task 1's version (keep its LOBBY branch):

```typescript
  override async onLeave(client: Client, consented?: boolean): Promise<void> {
    const side = this.sideOf(client);
    if (side === null) return;
    if (this.phase() === 'LOBBY') {
      // Game not started: free the seat entirely (a different client may take it).
      if (side === 'A') this.state.sessionA = '';
      else this.state.sessionB = '';
      this.setConnected(side, false);
      return;
    }
    this.setConnected(side, false);
    if (consented === true) {
      // Deliberate quit mid-game: no grace — tell the survivor and shut down.
      this.broadcast('opponentLeft', { side });
      await this.disconnect();
      return;
    }
    // Unexpected drop: freeze the game and hold the seat for the grace window.
    this.state.paused = true;
    try {
      await this.allowReconnection(client, this.reconnectGraceS);
      this.setConnected(side, true);
      if (this.state.connectedA && this.state.connectedB) this.state.paused = false;
    } catch {
      // Grace expired or the room is already disposing (both players gone).
      if (this.clients.length > 0) {
        this.broadcast('opponentLeft', { side });
        await this.disconnect();
      }
    }
  }

  private setConnected(side: TeamSide, value: boolean): void {
    if (side === 'A') this.state.connectedA = value;
    else this.state.connectedB = value;
  }
```

- [ ] **Step 6: Tick gate + paused rejections.** First line of `tick()`: `if (this.state.paused) return; // frozen: no sim time accrues, so play timeout/rest timers hold`. First line of `handlePitch`, `handleSwing`, `handleRunDecision`, `handleConfirmPositioning`, `handleReadyForPlay`, `handleRematch` (before all other checks): `if (this.state.paused) { this.reject('<name>', 'paused'); return; }` with each handler's own message name.

- [ ] **Step 7: Run the full file, then `npm run check`.** Expected: green. NOTE the disposal races: after `disconnect()` the `waitForNextSimulationTick` helpers on that room throw — tests above only await broadcasts after disposal-bound leaves, keep it that way. Commit: `feat(server): disconnect pause, reconnect grace, consented-quit disposal`.

---

### Task 4: Client — create/join flow, lobby screen, role-gated input (parallel-safe after Task 1)

**Files:**
- Modify: `client/src/NetModule.ts`, `client/src/InputModule.ts`, `client/src/main.ts`, `client/index.html`

**Interfaces:**
- Consumes: Task 1 schema fields (`roomCode`, `sessionA/B`, `connectedA/B`), Task 3's `paused` (read defensively: `state.paused === true`, so the client also typechecks before Task 3 lands), rejection reasons `wrongRole`/`paused`, broadcast `opponentLeft`.
- Produces: `connect(opts: ConnectOptions): Promise<Net>` with `ConnectOptions = { mode: 'create' } | { mode: 'join'; code: string }`; `Net.mySide(): 'A' | 'B' | null`, `Net.myRole(): 'batting' | 'fielding' | null`, `Net.onOpponentLeft(cb: (side: string) => void)`. Task 5's acceptance drives this UI.

**UI note:** the lobby screen is a designed element — the implementing agent MUST invoke the `unslop-ui` skill and make a deliberate project-specific choice consistent with the existing monospace/parchment status aesthetic (`#f5f1e6` on the 3D field). No templated defaults.

- [ ] **Step 1: NetModule.** Extend `MatchStateView` with `roomCode/sessionA/sessionB: string`, `connectedA/connectedB/paused: boolean`. Replace `connect`:

```typescript
export type ConnectOptions = { mode: 'create' } | { mode: 'join'; code: string };

/** 4 crypto-random uppercase letters — a rendezvous string, not a secret. */
function generateCode(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => letters[b % 26] ?? 'A').join('');
}

export async function connect(opts: ConnectOptions): Promise<Net> {
  const client = new Client(SERVER_URL);
  const room =
    opts.mode === 'create'
      ? await client.create<MatchStateView>('match', { code: generateCode() })
      : await client.join<MatchStateView>('match', { code: opts.code.trim().toUpperCase() });
  // ...existing senders/handlers, plus:
  return {
    // ...
    mySide() {
      if (room.sessionId === room.state.sessionA) return 'A';
      if (room.sessionId === room.state.sessionB) return 'B';
      return null;
    },
    myRole() {
      const side = this.mySide();
      if (side === null || room.state.phase !== 'PLAY') return null;
      return room.state.battingSide === side ? 'batting' : 'fielding';
    },
    onOpponentLeft(callback) {
      room.onMessage('opponentLeft', (m: { side: string }) => callback(m.side));
    },
  };
}
```

(`myRole` returning `null` outside PLAY keeps gameplay keys dead in other phases without duplicating server logic; Enter/N remain phase-switched as today.)

- [ ] **Step 2: InputModule role gating.** `attachInput(net, onLocalAction)` unchanged signature. Gate the gameplay keys — blocked keys do NOTHING locally (no guaranteed-rejection round-trip):

```typescript
      case 'KeyP':
        if (net.myRole() !== 'fielding') break;
        net.sendPitch({ aim: PITCH_AIM, spinInput: state.spin });
        break;
      case 'Space':
        event.preventDefault();
        if (net.myRole() !== 'batting') break;
        net.sendSwing({ timing: 0, aim: HIT_AIM, spinInput: 0 });
        break;
      case 'KeyR':
        if (net.myRole() !== 'batting') break;
        net.sendRunDecision({ go: true });
        onLocalAction('run: go');
        break;
      case 'KeyT':
        if (net.myRole() !== 'batting') break;
        net.sendRunDecision({ go: false });
        onLocalAction('run: stop');
        break;
```

- [ ] **Step 3: Lobby screen.** `index.html` gains an overlay `<div id="lobby">` (create button; 4-letter code input + join button) styled per the unslop-ui pass. `main.ts` restructure: show lobby → on create, call `connect({ mode: 'create' })`, swap the lobby content to the big shareable `state.roomCode` + "waiting for opponent"; on join, `connect({ mode: 'join', code })`. Hide the lobby when `state.phase !== 'LOBBY'`. Connection errors (bad code, room full) render inside the lobby, and the buttons re-enable for another attempt.

- [ ] **Step 4: Status line.** Add to `statusLine`: a `you are A|B · batting|fielding` segment (from `mySide`/`battingSide`); `paused` → `opponent disconnected — waiting for reconnect`; `onOpponentLeft` → replace status with `opponent left — match over` (and leave the room). Update `HELP` to note keys only work for your role.

- [ ] **Step 5: Verify.** `npm run check` (client typecheck + lint — the client has no unit tests; behaviour is proven in Task 5). Manual smoke: `npm run dev`, open two browser tabs, create in one, join with the code in the other, confirm both reach INITIAL_POSITIONING. Commit: `feat(client): lobby create/join by code, role-gated input, M6 status states`.

---

### Task 5: §9.6 acceptance + docs

**Files:**
- Create: `docs/superpowers/acceptance/m6-acceptance.mjs`, `m6-acceptance.log`, `m6-*.png`
- Modify: `CLAUDE.md` (§6.1 state, §6.2 decisions, §6.3 changelog, §6.4 known issues), `TUNING.md`

**Interfaces:** consumes everything above; produces committed evidence.

- [ ] **Step 1: Scripted WS acceptance** (`m6-acceptance.mjs`, patterned on `m5-acceptance.mjs`): against a real `npm run dev` server — two colyseus.js clients, creator + code join; play a full game to GAME_OVER with every message sent by its role-correct client only; include ONE deliberate wrong-role pitch and log its structured `wrongRole` rejection; then a second room demonstrating drop → `paused` with identical ball position across ≥1 s → reconnect → resumed. Log to `m6-acceptance.log`.
- [ ] **Step 2: Browser acceptance** (Playwright, as M5): two pages — page 1 creates and displays the code (read it from the DOM), page 2 joins with it; both reach INITIAL_POSITIONING; screenshot each lobby + the joined state.
- [ ] **Step 3: Docs.** CLAUDE.md §6.4: REMOVE the two "no per-client role gating" items and the "either joined client may send stop/go" item (fixed this milestone); UPDATE the swing-vs-plane latency item to "post-M6 tuning: revisit if remote play feels unfair" (the M6 decision was to keep server timing — user choice, log in §6.2). §6.2 new rows: client-generated room code rationale; consented-quit vs drop semantics; `RECONNECT_GRACE_S = 60` + test-only `reconnectGraceS` option. §6.1/§6.3 per the log rules. TUNING.md: note `RECONNECT_GRACE_S` as a playtest candidate.
- [ ] **Step 4: Full verification** — `npm run check` green; acceptance artefacts committed. Commit: `docs: M6 acceptance evidence and project log`.

---

## Self-Review Notes (already applied)

- Spec coverage: §1→T1, §2→T1+T2, §3→T1, §4→T3, §5→T4, §6→tests in T1–T3 + T5. Deferred list (§7) requires no task.
- `startPlay`/`pitchThenSwing` signatures change in Task 2 — Task 2 Step 4 owns ALL call-site migration; Task 3's new tests already use the new signatures.
- `client.leave(consented)` in colyseus.js sends the consent flag; `@colyseus/testing`'s `connectTo` returns a client room exposing `reconnectionToken` — reconnect via `colyseus.sdk.reconnect(token)`. If the installed Colyseus 0.15.x API differs (e.g. token shape), adapt the TEST, not the room semantics.
- `onUncaughtException` already guards the async `onLeave` path; the `catch {}` around `allowReconnection` is still required (rejection is the documented expiry signal, not an error).
