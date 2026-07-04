import { CONST, type Character, type TeamSide } from '@carlquest/shared';

export interface DraftView {
  /** Side to pick next; null once the draft is complete (or nothing to draft). */
  turn: TeamSide | null;
  /** Unpicked ids, pool order — after completion these are the undrafted leftovers. */
  remainingIds: string[];
  /** Picked ids in pick order (batting order = pick order downstream). */
  pickedA: string[];
  pickedB: string[];
  complete: boolean;
}

/**
 * Picks per player for a pool of the given size: the spec's DRAFT_ROUNDS
 * (SQUAD_SIZE + BENCH_SIZE) capped by what a shared exclusive pool can supply
 * (design decision: even squads, leftovers undrafted — 11 chars → 5 each).
 */
export function picksEach(poolSize: number): number {
  return Math.min(CONST.GAME.SQUAD_SIZE + CONST.GAME.BENCH_SIZE, Math.floor(poolSize / 2));
}

/**
 * Pure alternating draft (spec §1): side A (room creator) picks first, strict
 * A/B alternation, picked characters leave the shared pool. No timers, no
 * snake order, no undo — casual game, YAGNI.
 */
export function createDraftModule(
  pool: Character[],
  picks: number,
): {
  view(): DraftView;
  pick(side: TeamSide, id: string): boolean;
  squads(): { squadA: Character[]; squadB: Character[] };
} {
  const byId = new Map(pool.map((c) => [c.id, c]));
  const remaining = new Set(byId.keys());
  const picked: Record<TeamSide, string[]> = { A: [], B: [] };
  let turn: TeamSide | null = picks > 0 ? 'A' : null;

  function complete(): boolean {
    return picked.A.length >= picks && picked.B.length >= picks;
  }

  function view(): DraftView {
    return {
      turn,
      remainingIds: [...remaining],
      pickedA: [...picked.A],
      pickedB: [...picked.B],
      complete: complete(),
    };
  }

  function pick(side: TeamSide, id: string): boolean {
    if (turn === null || side !== turn) return false;
    if (!remaining.has(id)) return false;
    remaining.delete(id);
    picked[side].push(id);
    turn = complete() ? null : side === 'A' ? 'B' : 'A';
    return true;
  }

  function squads(): { squadA: Character[]; squadB: Character[] } {
    if (!complete()) throw new Error('draft not complete');
    const resolve = (ids: string[]): Character[] =>
      ids.map((id) => {
        const c = byId.get(id);
        if (c === undefined) throw new Error(`unknown character ${id}`);
        return c;
      });
    return { squadA: resolve(picked.A), squadB: resolve(picked.B) };
  }

  return { view, pick, squads };
}
