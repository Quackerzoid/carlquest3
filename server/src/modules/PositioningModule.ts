import { CONST, type Character } from '@carlquest/shared';

const { FIELD, GAME } = CONST;

export interface PositioningView {
  /** Current (x, z) per ON-FIELD character id. */
  positions: Record<string, { x: number; z: number }>;
  /** On-field ids, pick order (substitutions replace in place). */
  onField: string[];
  bench: string[];
  subsUsed: number;
}

/**
 * Pre-play positioning state for ONE side (spec §4): custom fielder positions,
 * bench membership and the per-innings substitution counter. Pure — pitcher
 * pinning and phase/role gating live in the room. Positions and bench persist
 * for the side across the whole game; a rematch constructs fresh modules.
 */
export function createPositioningModule(
  squad: Character[],
  fieldSlots: number,
): {
  view(): PositioningView;
  reposition(id: string, x: number, z: number): boolean;
  substitute(outId: string, inId: string): boolean;
  resetSubs(): void;
} {
  const slots = Math.max(0, Math.min(fieldSlots, FIELD.FIELDING_POSITIONS.length));
  const onField = squad.slice(0, slots).map((c) => c.id);
  const bench = squad.slice(slots).map((c) => c.id);
  const positions: Record<string, { x: number; z: number }> = {};
  onField.forEach((fielderId, i) => {
    const slot = FIELD.FIELDING_POSITIONS[i];
    if (slot === undefined) throw new RangeError(`no fielding slot ${i}`);
    positions[fielderId] = { x: slot.x, z: slot.z };
  });
  let subsUsed = 0;

  function legal(x: number, z: number): boolean {
    const zone = FIELD.LEGAL_ZONE;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (x < zone.minX || x > zone.maxX || z < zone.minZ || z > zone.maxZ) return false;
    const dist = Math.hypot(x - FIELD.BATTING_SQUARE.x, z - FIELD.BATTING_SQUARE.z);
    return dist > FIELD.BATTING_SQUARE_KEEPOUT;
  }

  return {
    view() {
      const copy: Record<string, { x: number; z: number }> = {};
      for (const [fielderId, p] of Object.entries(positions)) copy[fielderId] = { ...p };
      return { positions: copy, onField: [...onField], bench: [...bench], subsUsed };
    },
    reposition(id, x, z) {
      if (!onField.includes(id) || !legal(x, z)) return false;
      positions[id] = { x, z };
      return true;
    },
    substitute(outId, inId) {
      const outIdx = onField.indexOf(outId);
      const inIdx = bench.indexOf(inId);
      if (outIdx === -1 || inIdx === -1) return false;
      if (!(subsUsed < GAME.SUBS_PER_INNINGS_CASUAL)) return false;
      onField[outIdx] = inId;
      bench[inIdx] = outId;
      const p = positions[outId];
      if (p !== undefined) positions[inId] = p;
      delete positions[outId];
      subsUsed += 1;
      return true;
    },
    resetSubs() {
      subsUsed = 0;
    },
  };
}
