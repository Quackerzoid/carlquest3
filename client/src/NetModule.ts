/** Colyseus connection (grows into the full NetModule in Milestone 6). */
import { Client, type Room } from 'colyseus.js';
import type {
  MatchPhase,
  PitchInput,
  PlayResolution,
  RunDecisionInput,
  SwingInput,
} from '@carlquest/shared';

const SERVER_URL = `ws://${location.hostname}:2567`;

/** Runtime shape of a FielderSchema entry (server/src/rooms/MatchState.ts). */
export interface FielderState {
  id: string;
  x: number;
  z: number;
  hasBall: boolean;
  stamina: number;
}

/** Runtime shape of a RunnerSchema entry (server/src/rooms/MatchState.ts). */
export interface RunnerState {
  id: string;
  x: number;
  z: number;
  atPost: number;
  running: boolean;
  out: boolean;
}

/** Structured rejection broadcast for a phase-invalid / malformed message. */
export interface RejectionEvent {
  message: string;
  phase: MatchPhase;
  reason: string;
}

/** Runtime shape of MatchState as seen by the client (server/src/rooms/MatchState.ts). */
export interface MatchStateView {
  phase: MatchPhase;
  ball: { x: number; y: number; z: number };
  ballLive: boolean;
  fielders: ReadonlyMap<string, FielderState>;
  runners: ReadonlyMap<string, RunnerState>;
  scoreHalvesA: number;
  scoreHalvesB: number;
  inningsIndex: number;
  outs: number;
  battingSide: string;
  currentBatterId: string;
  currentPitcherId: string;
  tiebreak: boolean;
  winner: string;
  lastOutcome: string;
  lastRejection: string;
}

export interface Net {
  room: Room<MatchStateView>;
  /** Current authoritative phase (read from synced state; no client-side rules). */
  phase(): MatchPhase;
  sendPitch(input: PitchInput): void;
  sendSwing(input: SwingInput & { timing: number }): void;
  sendRunDecision(input: RunDecisionInput): void;
  sendConfirmPositioning(): void;
  sendReadyForPlay(): void;
  sendRematch(): void;
  onPlayOutcome(callback: (resolution: PlayResolution) => void): void;
  onRejected(callback: (rejection: RejectionEvent) => void): void;
}

export async function connect(): Promise<Net> {
  const client = new Client(SERVER_URL);
  const room = await client.joinOrCreate<MatchStateView>('match');
  return {
    room,
    phase() {
      return room.state.phase;
    },
    sendPitch(input) {
      room.send('pitch', input);
    },
    sendSwing(input) {
      room.send('swing', input);
    },
    sendRunDecision(input) {
      room.send('runDecision', input);
    },
    sendConfirmPositioning() {
      room.send('confirmPositioning');
    },
    sendReadyForPlay() {
      room.send('readyForPlay');
    },
    sendRematch() {
      room.send('rematch');
    },
    onPlayOutcome(callback) {
      room.onMessage('playOutcome', (resolution: PlayResolution) => callback(resolution));
    },
    onRejected(callback) {
      room.onMessage('rejected', (rejection: RejectionEvent) => callback(rejection));
    },
  };
}
