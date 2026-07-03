import { Schema, type } from '@colyseus/schema';
import type { MatchPhase } from '@carlquest/shared';

/** Authoritative, network-replicated state for a single match. */
export class MatchState extends Schema {
  @type('string') phase: MatchPhase = 'LOBBY';
}
