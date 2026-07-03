import { Room, type Client } from '@colyseus/core';
import {
  CONST,
  getCharacter,
  type PitchInput,
  type SwingInput,
} from '@carlquest/shared';
import { createPhysicsModule, type PhysicsModule } from '../modules/PhysicsModule';
import { resolvePitch } from '../modules/PitchModule';
import { resolveSwing } from '../modules/HitModule';
import { MatchState } from './MatchState';

const { PHYSICS, GAME, FIELD } = CONST;

/** Demo cast for the M3 single-player loop; the draft replaces this in Milestone 7. */
const DEMO_PITCHER = getCharacter('kian');
const DEMO_BATTER = getCharacter('carl');

type SwingMessage = SwingInput & { timing: number };

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function isVec3(v: unknown): v is { x: number; y: number; z: number } {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return isFiniteNumber(c.x) && isFiniteNumber(c.y) && isFiniteNumber(c.z);
}

/** Authoritative match room. M3: single-player pitch→swing demo loop. */
export class MatchRoom extends Room<MatchState> {
  override maxClients = 2;

  private physics!: PhysicsModule;
  private simTime = 0;
  /** Sim-time when the live ball crossed the batting-square plane; null until it does. */
  private contactTime: number | null = null;
  private crossed = false;
  private swung = false;
  private liveSince = 0;
  private restSince: number | null = null;

  override async onCreate(): Promise<void> {
    this.setState(new MatchState());
    this.physics = await createPhysicsModule();

    this.onMessage('pitch', (client, message) => this.handlePitch(client, message));
    this.onMessage('swing', (client, message) => this.handleSwing(client, message));

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), 1000 / 60);
  }

  override onJoin(client: Client): void {
    console.log(`client ${client.sessionId} joined`);
  }

  override onLeave(client: Client): void {
    console.log(`client ${client.sessionId} left`);
  }

  override onDispose(): void {
    this.physics.dispose();
  }

  private handlePitch(_client: Client, message: unknown): void {
    const m = message as Partial<PitchInput>;
    if (this.state.ballLive || !isVec3(m.aim) || !isFiniteNumber(m.spinInput)) {
      this.state.demoLog = 'pitch rejected (ball live or malformed input)';
      return;
    }
    const params = resolvePitch(DEMO_PITCHER.stats, { aim: m.aim, spinInput: m.spinInput });
    this.physics.applyPitch(params);
    this.state.ballLive = true;
    this.state.demoLog = 'pitch away';
    this.contactTime = null;
    this.crossed = false;
    this.swung = false;
    this.liveSince = this.simTime;
    this.restSince = null;
  }

  private handleSwing(_client: Client, message: unknown): void {
    const m = message as Partial<SwingMessage>;
    // M3 decision: the client 'timing' field is accepted but ignored; the server's
    // own sim-time is authoritative. Revisit for latency compensation in Milestone 6.
    if (!this.state.ballLive || this.swung || !isVec3(m.aim) || !isFiniteNumber(m.spinInput)) {
      this.state.demoLog = 'swing rejected (no live pitch, already swung, or malformed input)';
      return;
    }
    const error = this.timingErrorNow();
    if (error === null) {
      this.state.demoLog = 'swing rejected (ball never reaches the batter)';
      return;
    }
    this.swung = true;
    const result = resolveSwing(DEMO_BATTER.stats, { aim: m.aim, spinInput: m.spinInput }, error);
    if (!result.contact) {
      this.state.demoLog = `swing missed (timing error ${error.toFixed(3)} s)`;
      return;
    }
    this.physics.applyHit(result.params);
    this.state.demoLog = `hit! timing factor ${result.timingFactor.toFixed(2)}`;
  }

  /** Signed swing-timing error: positive = late, negative = early; null if no contact possible. */
  private timingErrorNow(): number | null {
    if (this.contactTime !== null) return this.simTime - this.contactTime;
    const ball = this.physics.getBallState();
    const dz = ball.position.z - FIELD.BATTING_SQUARE.z;
    if (ball.velocity.z >= 0) return null; // moving away — will never cross
    const timeToPlane = dz / -ball.velocity.z;
    return -timeToPlane; // early by the projected time remaining
  }

  private tick(deltaMs: number): void {
    // Clamp to avoid a spiral-of-death catch-up burst after an event-loop stall (§6.4 M2 item).
    const dt = Math.min(deltaMs / 1000, PHYSICS.SIM_MAX_CATCHUP);
    this.simTime += dt;
    if (!this.state.ballLive) return;

    const before = this.physics.getBallState().position.z;
    this.physics.step(dt);
    const state = this.physics.getBallState();

    // Record the moment the ball first crosses the batting-square plane (ideal contact).
    if (!this.crossed && before > FIELD.BATTING_SQUARE.z && state.position.z <= FIELD.BATTING_SQUARE.z) {
      this.crossed = true;
      this.contactTime = this.simTime;
    }

    this.state.ball.x = state.position.x;
    this.state.ball.y = state.position.y;
    this.state.ball.z = state.position.z;
    this.state.ball.vx = state.velocity.x;
    this.state.ball.vy = state.velocity.y;
    this.state.ball.vz = state.velocity.z;
    this.state.ball.wx = state.angularVelocity.x;
    this.state.ball.wy = state.angularVelocity.y;
    this.state.ball.wz = state.angularVelocity.z;

    this.endPlayIfOver(state);
  }

  private endPlayIfOver(state: { velocity: { x: number; y: number; z: number } }): void {
    const speed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
    if (speed < GAME.BALL_REST_SPEED) {
      this.restSince ??= this.simTime;
    } else {
      this.restSince = null;
    }
    const timedOut = this.simTime - this.liveSince > GAME.PLAY_TIMEOUT_S;
    const atRest = this.restSince !== null && this.simTime - this.restSince > GAME.BALL_REST_TIME_S;
    if (timedOut || atRest) {
      this.state.ballLive = false;
      this.state.demoLog = `play over (${timedOut ? 'timeout' : 'ball at rest'}) — press P to pitch`;
      this.physics.spawnBall();
    }
  }
}
