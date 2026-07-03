/**
 * The character roster (spec §3) — the ONLY source of character data in the game.
 * Ability behaviour lands in Milestone 9; ids are stored from day one.
 */
import type { Character } from './types';

function deepFreeze<T extends object>(obj: T): T {
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const CHARACTERS: readonly Character[] = deepFreeze([
  { id: 'carl', name: 'Carl', stats: { speed: 7, reach: 6, power: 8, pitch: 5, spin: 5, stamina: 7, reflex: 6, instinct: 6, nerve: 8 }, ability: 'CLUTCH_SWING' },
  { id: 'kian', name: 'Kian', stats: { speed: 5, reach: 6, power: 5, pitch: 8, spin: 9, stamina: 6, reflex: 7, instinct: 6, nerve: 6 }, ability: 'CURVEBALL_MASTER' },
  { id: 'laurie', name: 'Laurie', stats: { speed: 6, reach: 9, power: 6, pitch: 5, spin: 5, stamina: 7, reflex: 7, instinct: 8, nerve: 6 }, ability: 'LONG_REACH' },
  { id: 'josh', name: 'Josh', stats: { speed: 8, reach: 7, power: 6, pitch: 6, spin: 5, stamina: 7, reflex: 9, instinct: 6, nerve: 5 }, ability: 'QUICK_DRAW' },
  { id: 'joel', name: 'Joel', stats: { speed: 6, reach: 6, power: 7, pitch: 9, spin: 6, stamina: 6, reflex: 6, instinct: 5, nerve: 6 }, ability: 'CANNON_ARM' },
  { id: 'darcy', name: 'Darcy', stats: { speed: 7, reach: 7, power: 7, pitch: 6, spin: 7, stamina: 7, reflex: 7, instinct: 7, nerve: 7 }, ability: 'SWITCH' },
  { id: 'jonty', name: 'Jonty', stats: { speed: 3, reach: 8, power: 9, pitch: 6, spin: 4, stamina: 5, reflex: 5, instinct: 7, nerve: 8 }, ability: 'IMMOVABLE' },
  { id: 'robbie', name: 'Robbie', stats: { speed: 5, reach: 6, power: 8, pitch: 5, spin: 5, stamina: 6, reflex: 6, instinct: 6, nerve: 7 }, ability: 'POWER_BASE' },
  { id: 'joe', name: 'Joe', stats: { speed: 2, reach: 2, power: 2, pitch: 3, spin: 2, stamina: 3, reflex: 2, instinct: 2, nerve: 2 }, ability: 'BUTTERFINGERS' },
  { id: 'ricy', name: 'Ricy', stats: { speed: 7, reach: 8, power: 8, pitch: 8, spin: 6, stamina: 8, reflex: 7, instinct: 7, nerve: 7 }, ability: 'POWERHOUSE' },
  { id: 'whale', name: 'The Whale', stats: { speed: 1, reach: 10, power: 10, pitch: 4, spin: 2, stamina: 5, reflex: 3, instinct: 6, nerve: 7 }, ability: 'WALL' },
]);

/** Look up a character by id; unknown ids are a programmer error. */
export function getCharacter(id: string): Character {
  const found = CHARACTERS.find((c) => c.id === id);
  if (found === undefined) throw new RangeError(`unknown character id: ${id}`);
  return found;
}
