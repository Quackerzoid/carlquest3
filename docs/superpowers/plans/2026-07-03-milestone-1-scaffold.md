# Milestone 1 — Monorepo Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable npm-workspaces monorepo where `npm run dev` serves a Three.js client showing the rounders pitch, posts, and camera; the server boots an empty Colyseus `MatchRoom`; and `/shared` imports cleanly from both — with `npm run check` (typecheck + lint + Vitest) green.

**Architecture:** Three npm workspaces (`/client`, `/server`, `/shared`). `/shared` is a source-level TS package (no build step for dev): the client resolves it through Vite, the server runs it through `tsx`. The server is a Colyseus app defining a `match` room with a minimal synced schema (`phase` only, for now). The client is a Vite vanilla-TS app with a `SceneModule` that builds the static pitch from geometry constants in `/shared/constants.ts` — no game logic anywhere on the client.

**Tech Stack:** TypeScript 5 (strict), Three.js ≥ r160, Colyseus 0.15 (+ `@colyseus/testing`), Vite 5, Vitest 2, ESLint 9 (flat, typescript-eslint) + Prettier, tsx for server dev, concurrently for `npm run dev`. Node 20+.

## Global Constraints

- TypeScript `strict: true` everywhere; no `any`, no `@ts-ignore` without a justifying comment.
- All tunable numbers live in `shared/src/constants.ts` — no magic numbers in client or server code (spec §1, CLAUDE.md).
- Server is authoritative; the client renders only. Nothing in `/client` may compute game state.
- British English in all comments, docs, and UI copy.
- Conventional commit messages; small commits per logical unit; milestone ends on a tagged green commit (`m1-scaffold`).
- Workspace tool: **npm workspaces** (decision — matches `npm run …` commands in CLAUDE.md §3; state it in README).
- Rapier is NOT part of this milestone (physics is Milestone 2). Do not add the dependency yet.

## File Structure

```
package.json                 root: workspaces, dev/check/test/build scripts
tsconfig.base.json           shared strict compiler options
eslint.config.js             flat config, typescript-eslint + prettier-compat
.prettierrc.json             prettier config
vitest.workspace.ts          points Vitest at all three workspaces
README.md                    stack + npm-workspaces statement + commands
.gitignore                   node_modules, dist, etc.
shared/package.json          name @carlquest/shared, main = src/index.ts
shared/tsconfig.json
shared/src/index.ts          re-exports types + constants
shared/src/types.ts          MatchPhase, Vec3 (grows in later milestones)
shared/src/constants.ts      §6/§8b tunables + field geometry
shared/test/constants.test.ts
server/package.json          name @carlquest/server
server/tsconfig.json
server/src/index.ts          Colyseus server bootstrap, port 2567
server/src/rooms/MatchRoom.ts  empty authoritative room, maxClients 2
server/src/rooms/MatchState.ts Colyseus schema (phase only)
server/test/MatchRoom.test.ts  boot + join test via @colyseus/testing
client/package.json          name @carlquest/client
client/tsconfig.json
client/index.html
client/vite.config.ts
client/src/main.ts           entry: create scene, start render loop
client/src/SceneModule.ts    pitch, posts, batting/bowling squares, camera, lights
```

### Task 1: Root workspace scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `vitest.workspace.ts`, `README.md`, `.gitignore`

**Interfaces:**
- Produces: root scripts `dev`, `check`, `typecheck`, `lint`, `test`, `build` that later tasks' workspaces plug into via `--workspaces --if-present`.

- [ ] **Step 1: Write root `package.json`**

```json
{
  "name": "carlquest",
  "private": true,
  "version": "0.1.0",
  "description": "Carl Quest Sports — multiplayer 3D rounders",
  "workspaces": ["shared", "server", "client"],
  "scripts": {
    "dev": "concurrently -n server,client -c blue,green \"npm run dev -w @carlquest/server\" \"npm run dev -w @carlquest/client\"",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint": "eslint .",
    "test": "vitest run",
    "check": "npm run typecheck && npm run lint && npm run test",
    "build": "npm run build --workspaces --if-present"
  },
  "devDependencies": {
    "@eslint/js": "^9.5.0",
    "concurrently": "^8.2.2",
    "eslint": "^9.5.0",
    "eslint-config-prettier": "^9.1.0",
    "prettier": "^3.3.0",
    "typescript": "^5.5.0",
    "typescript-eslint": "^7.13.0",
    "vitest": "^2.0.0"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

(Note: the server workspace overrides `module`/`moduleResolution` — see Task 3 — because Colyseus + tsx run on Node module resolution, not bundler resolution.)

- [ ] **Step 3: Write `eslint.config.js`**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
);
```

- [ ] **Step 4: Write `.prettierrc.json`**

```json
{ "singleQuote": true, "printWidth": 100, "trailingComma": "all" }
```

- [ ] **Step 5: Write `vitest.workspace.ts`**

```ts
export default ['shared', 'server', 'client'];
```

- [ ] **Step 6: Write `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 7: Write `README.md`**

```markdown
# Carl Quest Sports

Multiplayer (2-player) 3D rounders. TypeScript (strict), Three.js, Rapier, Colyseus, Vite.

**Workspace tool: npm workspaces** (not pnpm). Node 20+ required.

## Layout
- `client/` — Three.js + Rapier client (rendering, input, prediction)
- `server/` — Colyseus authoritative sim (Rapier headless, rules, scoring)
- `shared/` — TS types, constants, stat formulas, character data

## Commands
- `npm run dev` — client (Vite, http://localhost:5173) + server (Colyseus, ws://localhost:2567)
- `npm run check` — typecheck + lint + test, all workspaces
- `npm run test` — Vitest
- `npm run build` — production build

The design spec lives at `docs/design/spec.md`.
```

- [ ] **Step 8: Verify install runs**

Run: `npm install`
Expected: completes without errors, lockfile created.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.base.json eslint.config.js .prettierrc.json vitest.workspace.ts README.md .gitignore package-lock.json
git commit -m "chore: root npm-workspaces scaffold (eslint, prettier, vitest, scripts)"
```

(If this is the repo's first commit, also `git add CLAUDE.md docs/` in a preceding `docs:` commit so the spec and plan are tracked.)

---

### Task 2: `/shared` package (types + constants) — TDD

**Files:**
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/index.ts`, `shared/src/types.ts`, `shared/src/constants.ts`
- Test: `shared/test/constants.test.ts`

**Interfaces:**
- Produces: package `@carlquest/shared` exporting `MatchPhase` (string-literal union + `MATCH_PHASES` ordered array), `Vec3`, and `CONST` (frozen constants object with `PHYSICS`, `FIELD`, `GAME` groups). Server and client import ONLY via `@carlquest/shared`.

- [ ] **Step 1: Write `shared/package.json` and `shared/tsconfig.json`**

```json
{
  "name": "@carlquest/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": { "typecheck": "tsc --noEmit" }
}
```

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test"]
}
```

- [ ] **Step 2: Write the failing test**

`shared/test/constants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CONST, MATCH_PHASES } from '../src/index';

describe('constants', () => {
  it('defines the fixed physics timestep as exactly 1/60', () => {
    expect(CONST.PHYSICS.FIXED_TIMESTEP).toBe(1 / 60);
  });

  it('defines ball properties from spec §6', () => {
    expect(CONST.PHYSICS.BALL_RADIUS).toBe(0.036);
    expect(CONST.PHYSICS.BALL_MASS).toBe(0.16);
    expect(CONST.PHYSICS.BALL_RESTITUTION).toBe(0.4);
    expect(CONST.PHYSICS.MAGNUS_K).toBe(0.0006);
  });

  it('defines exactly four posts', () => {
    expect(CONST.FIELD.POSTS).toHaveLength(4);
  });

  it('orders match phases per spec §2', () => {
    expect(MATCH_PHASES).toEqual([
      'LOBBY',
      'DRAFT',
      'INITIAL_POSITIONING',
      'PRE_PLAY',
      'PLAY',
      'PLAY_RESOLVE',
      'INNINGS_SWITCH',
      'GAME_OVER',
    ]);
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(CONST)).toBe(true);
    expect(Object.isFrozen(CONST.PHYSICS)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run shared`
Expected: FAIL — cannot resolve `../src/index`.

- [ ] **Step 4: Write `shared/src/types.ts`**

```ts
/** Match phases in spec §2 order. */
export const MATCH_PHASES = [
  'LOBBY',
  'DRAFT',
  'INITIAL_POSITIONING',
  'PRE_PLAY',
  'PLAY',
  'PLAY_RESOLVE',
  'INNINGS_SWITCH',
  'GAME_OVER',
] as const;

export type MatchPhase = (typeof MATCH_PHASES)[number];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
```

- [ ] **Step 5: Write `shared/src/constants.ts`**

```ts
/**
 * Single source of truth for every tunable number (spec §5, §6, §8b).
 * Field geometry is a Milestone-1 placeholder based on standard school
 * rounders layout — logged in CLAUDE.md §6.2, to be tuned in playtest.
 */

const PHYSICS = {
  GRAVITY_Y: -9.81,
  FIXED_TIMESTEP: 1 / 60,
  BALL_RADIUS: 0.036,
  BALL_MASS: 0.16,
  BALL_RESTITUTION: 0.4,
  BALL_LINEAR_DAMPING: 0.05,
  BALL_ANGULAR_DAMPING: 0.02,
  MAGNUS_K: 0.0006,
  GROUND_FRICTION: 0.6,
} as const;

const FIELD = {
  /** Batter stands here; world origin. */
  BATTING_SQUARE: { x: 0, z: 0 },
  /** Bowler stands here, facing the batter. */
  BOWLING_SQUARE: { x: 0, z: 7.5 },
  /** Posts 1–4, run anticlockwise. Placeholder school-rounders layout. */
  POSTS: [
    { x: 11, z: 4 },
    { x: 9, z: 15 },
    { x: -3, z: 17 },
    { x: -8.5, z: 6 },
  ],
  POST_HEIGHT: 1.2,
  POST_RADIUS: 0.04,
  /** Half-extent of the square ground plane rendered in Milestone 1. */
  GROUND_HALF_EXTENT: 40,
  BATTING_SQUARE_SIZE: 2,
  BOWLING_SQUARE_SIZE: 2.5,
} as const;

const GAME = {
  SQUAD_SIZE: 9,
  BENCH_SIZE: 2,
  INNINGS_COUNT: 2,
  SUBS_PER_INNINGS_CASUAL: Infinity,
  SUBS_PER_INNINGS_RANKED: 3,
  MOVE_MIN: 2.5,
  MOVE_MAX: 8.0,
  REACH_MIN: 0.8,
  REACH_MAX: 3.0,
  PITCH_MIN: 12,
  PITCH_MAX: 30,
  HIT_MIN: 10,
  HIT_MAX: 40,
  SPIN_MAX_RADS: 40,
  BASE_TIMING_WINDOW: 0.25,
  BASE_CATCH: 0.3,
  INSTINCT_W: 0.4,
  REFLEX_W: 0.3,
  BENCH_STAMINA_REGEN: 1,
} as const;

function deepFreeze<T extends object>(obj: T): T {
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const CONST = deepFreeze({ PHYSICS, FIELD, GAME });
```

(Note: `BENCH_STAMINA_REGEN` has no value in the spec — §4 names the constant but gives no number. `1` stamina point per play is a placeholder; log it as a decision and revisit when fatigue lands in Milestone 4.)

- [ ] **Step 6: Write `shared/src/index.ts`**

```ts
export * from './types';
export * from './constants';
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run shared`
Expected: PASS, 5 tests.

- [ ] **Step 8: Commit**

```bash
git add shared
git commit -m "feat(shared): types, phase list and tunable constants with tests"
```

---

### Task 3: `/server` — Colyseus empty MatchRoom — TDD

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/src/rooms/MatchState.ts`, `server/src/rooms/MatchRoom.ts`, `server/src/index.ts`
- Test: `server/test/MatchRoom.test.ts`

**Interfaces:**
- Consumes: `MatchPhase`, `MATCH_PHASES` from `@carlquest/shared`.
- Produces: room type `"match"`; `MatchState` schema with `phase: string` (starts `'LOBBY'`); server listens on port 2567. Later milestones add modules under `server/src/modules/`.

- [ ] **Step 1: Write `server/package.json` and `server/tsconfig.json`**

```json
{
  "name": "@carlquest/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.build.json"
  },
  "dependencies": {
    "@carlquest/shared": "*",
    "@colyseus/core": "^0.15.0",
    "@colyseus/schema": "^2.0.0",
    "@colyseus/ws-transport": "^0.15.0"
  },
  "devDependencies": {
    "@colyseus/testing": "^0.15.0",
    "tsx": "^4.15.0"
  }
}
```

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "experimentalDecorators": true,
    "useDefineForClassFields": false
  },
  "include": ["src", "test"]
}
```

(`experimentalDecorators` + `useDefineForClassFields: false` are required by `@colyseus/schema` decorators. Defer `tsconfig.build.json` to the build step of a later milestone if `tsc -p` needs emit config; for Milestone 1 `build` may simply alias `typecheck`.)

- [ ] **Step 2: Write the failing test**

`server/test/MatchRoom.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, ColyseusTestServer } from '@colyseus/testing';
import appConfig from '../src/app.config';

describe('MatchRoom', () => {
  let colyseus: ColyseusTestServer;

  beforeAll(async () => {
    colyseus = await boot(appConfig);
  });
  afterAll(async () => {
    await colyseus.shutdown();
  });

  it('boots and lets a client join the match room in LOBBY phase', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    expect(client.state.phase).toBe('LOBBY');
  });

  it('caps the room at two clients', async () => {
    const room = await colyseus.createRoom('match', {});
    expect(room.maxClients).toBe(2);
  });
});
```

(Note: `@colyseus/testing` expects an app config built with `@colyseus/tools` `defineConfig`; add `server/src/app.config.ts` in Step 3 and have `index.ts` consume it, so tests and the real server boot identically. Add `@colyseus/tools` to dependencies.)

- [ ] **Step 3: Run test to verify it fails, then write the implementation**

Run: `npx vitest run server` — Expected: FAIL (modules missing).

`server/src/rooms/MatchState.ts`:

```ts
import { Schema, type } from '@colyseus/schema';
import type { MatchPhase } from '@carlquest/shared';

export class MatchState extends Schema {
  @type('string') phase: MatchPhase = 'LOBBY';
}
```

`server/src/rooms/MatchRoom.ts`:

```ts
import { Room, type Client } from '@colyseus/core';
import { MatchState } from './MatchState';

/** Authoritative match room. Game modules attach here in later milestones. */
export class MatchRoom extends Room<MatchState> {
  override maxClients = 2;

  override onCreate(): void {
    this.setState(new MatchState());
  }

  override onJoin(client: Client): void {
    console.log(`client ${client.sessionId} joined`);
  }

  override onLeave(client: Client): void {
    console.log(`client ${client.sessionId} left`);
  }
}
```

`server/src/app.config.ts`:

```ts
import config from '@colyseus/tools';
import { MatchRoom } from './rooms/MatchRoom';

export default config({
  initializeGameServer: (gameServer) => {
    gameServer.define('match', MatchRoom);
  },
});
```

`server/src/index.ts`:

```ts
import { listen } from '@colyseus/tools';
import appConfig from './app.config';

void listen(appConfig, 2567);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server`
Expected: PASS, 2 tests.

- [ ] **Step 5: Verify the server boots for real**

Run: `npm run dev -w @carlquest/server` (then stop it)
Expected: Colyseus banner, listening on 2567, no errors.

- [ ] **Step 6: Commit**

```bash
git add server
git commit -m "feat(server): colyseus bootstrap with empty authoritative MatchRoom"
```

---

### Task 4: `/client` — Vite + Three.js scene (pitch, posts, camera)

**Files:**
- Create: `client/package.json`, `client/tsconfig.json`, `client/index.html`, `client/vite.config.ts`, `client/src/main.ts`, `client/src/SceneModule.ts`

**Interfaces:**
- Consumes: `CONST.FIELD` from `@carlquest/shared` for every position/dimension.
- Produces: `createScene(canvas): { scene, camera, renderer, start(): void }` — RenderModule/NetModule attach in later milestones.

- [ ] **Step 1: Write `client/package.json`, `client/tsconfig.json`, `client/vite.config.ts`, `client/index.html`**

```json
{
  "name": "@carlquest/client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "typecheck": "tsc --noEmit",
    "build": "vite build"
  },
  "dependencies": {
    "@carlquest/shared": "*",
    "three": "^0.165.0"
  },
  "devDependencies": {
    "@types/three": "^0.165.0",
    "vite": "^5.3.0"
  }
}
```

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM"] },
  "include": ["src", "vite.config.ts"]
}
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
});
```

```html
<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Carl Quest Sports</title>
    <style>
      html, body { margin: 0; height: 100%; overflow: hidden; }
      #app { width: 100%; height: 100%; display: block; }
    </style>
  </head>
  <body>
    <canvas id="app"></canvas>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `client/src/SceneModule.ts`**

```ts
import * as THREE from 'three';
import { CONST } from '@carlquest/shared';

/** Builds the static match scene: ground, pitch markings, posts, lights, camera. */
export function createScene(canvas: HTMLCanvasElement) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5d9); // overcast British sky

  const { FIELD } = CONST;

  // Ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(FIELD.GROUND_HALF_EXTENT * 2, FIELD.GROUND_HALF_EXTENT * 2),
    new THREE.MeshLambertMaterial({ color: 0x4a7c3f }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Batting and bowling squares (flat outlines)
  const squareMat = new THREE.MeshBasicMaterial({ color: 0xf5f1e6 });
  for (const { pos, size } of [
    { pos: FIELD.BATTING_SQUARE, size: FIELD.BATTING_SQUARE_SIZE },
    { pos: FIELD.BOWLING_SQUARE, size: FIELD.BOWLING_SQUARE_SIZE },
  ]) {
    const square = new THREE.Mesh(new THREE.PlaneGeometry(size, size), squareMat);
    square.rotation.x = -Math.PI / 2;
    square.position.set(pos.x, 0.01, pos.z);
    scene.add(square);
  }

  // Posts
  const postGeo = new THREE.CylinderGeometry(
    FIELD.POST_RADIUS,
    FIELD.POST_RADIUS,
    FIELD.POST_HEIGHT,
    12,
  );
  const postMat = new THREE.MeshLambertMaterial({ color: 0xd9d3c7 });
  for (const post of FIELD.POSTS) {
    const mesh = new THREE.Mesh(postGeo, postMat);
    mesh.position.set(post.x, FIELD.POST_HEIGHT / 2, post.z);
    mesh.castShadow = true;
    scene.add(mesh);
  }

  // Lights
  scene.add(new THREE.HemisphereLight(0xcfe4f5, 0x3e5a35, 0.9));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.2);
  sun.position.set(20, 30, 10);
  sun.castShadow = true;
  scene.add(sun);

  // Camera: behind the batter, looking across the field
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
  camera.position.set(0, 12, -14);
  camera.lookAt(new THREE.Vector3(2, 0, 10));

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;

  function resize(): void {
    const { clientWidth, clientHeight } = canvas;
    renderer.setSize(clientWidth, clientHeight, false);
    renderer.setPixelRatio(window.devicePixelRatio);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  }

  function start(): void {
    resize();
    window.addEventListener('resize', resize);
    renderer.setAnimationLoop(() => renderer.render(scene, camera));
  }

  return { scene, camera, renderer, start };
}
```

- [ ] **Step 3: Write `client/src/main.ts`**

```ts
import { createScene } from './SceneModule';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('Missing #app canvas');

createScene(canvas).start();
```

- [ ] **Step 4: Verify visually**

Run: `npm run dev -w @carlquest/client`, open http://localhost:5173
Expected: green ground, two pale squares (batting near camera, bowling ahead), four posts arranged anticlockwise, sky background, no console errors. Resize the window — canvas follows.

- [ ] **Step 5: Commit**

```bash
git add client
git commit -m "feat(client): vite + three.js scene with pitch, posts and camera"
```

---

### Task 5: Full verification, log, tag

**Files:**
- Modify: `CLAUDE.md` (§6 Project Log)

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: typecheck clean in all three workspaces, ESLint clean, all Vitest suites pass (shared 5, server 2; client has no tests yet — `vitest` must not fail on the empty client suite; if it does, set `passWithNoTests: true` in root vitest config).

- [ ] **Step 2: Run the milestone acceptance check**

Run: `npm run dev`
Expected: server banner on 2567 AND Vite on 5173 concurrently; browser shows the scene; stopping with Ctrl-C kills both.

- [ ] **Step 3: Update CLAUDE.md §6**

Overwrite §6.1 Current State (Milestone 1 complete, modules: scaffold only, test status, last green commit hash). Append §6.2 decisions: npm workspaces; placeholder field geometry; `BENCH_STAMINA_REGEN = 1` placeholder. Append §6.3 changelog entry with the exact `npm run check` output summary.

- [ ] **Step 4: Commit and tag**

```bash
git add CLAUDE.md
git commit -m "docs: record milestone 1 completion in project log"
git tag m1-scaffold
```

---

## Self-Review Notes

- Spec coverage: §9.1 fully covered (client scene ✓ Task 4, empty Colyseus room ✓ Task 3, shared imports from both ✓ Tasks 3+4 consume `@carlquest/shared`). §0 stack pinned in Global Constraints. Rapier deliberately excluded (Milestone 2).
- Known risk: Colyseus 0.15 package split (`@colyseus/tools` vs raw `Server`) — the plan standardises on `@colyseus/tools` `defineConfig` + `listen` so `@colyseus/testing` and production boot share one config. If installed versions differ in API, the implementer should match the installed major version's documented boot pattern, keeping the app-config-shared-by-tests property.
- Type consistency: `MatchPhase` defined once in shared (Task 2), consumed by `MatchState` (Task 3). `CONST.FIELD` shape defined Task 2, consumed Task 4.
