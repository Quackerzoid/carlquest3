import { Schema, type } from '@colyseus/schema';
import type { MatchPhase } from '@carlquest/shared';

export class BallSchema extends Schema {
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('number') vx = 0;
  @type('number') vy = 0;
  @type('number') vz = 0;
  @type('number') wx = 0;
  @type('number') wy = 0;
  @type('number') wz = 0;
}

export class MatchState extends Schema {
  @type('string') phase: MatchPhase = 'LOBBY';
  @type(BallSchema) ball = new BallSchema();
  @type('boolean') ballLive = false;
  /** Dev-visible log line for the M3 demo (rejections, outcomes). Replaced by real events in M5+. */
  @type('string') demoLog = '';
}
