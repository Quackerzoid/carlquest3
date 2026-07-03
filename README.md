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
