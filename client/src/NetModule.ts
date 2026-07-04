/** Colyseus connection (grows into the full NetModule in Milestone 6). */
import { Client, type Room } from 'colyseus.js';
import type {
  DraftPickInput,
  MatchPhase,
  PitchInput,
  PlayResolution,
  RepositionInput,
  RunDecisionInput,
  SetBatterInput,
  SetPitcherInput,
  SubstituteInput,
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
  roomCode: string;
  sessionA: string;
  sessionB: string;
  connectedA: boolean;
  connectedB: boolean;
  paused: boolean;
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
  /** Whose turn to pick during phase === 'DRAFT' ('A' | 'B', server-authoritative). */
  draftTurn: string;
  /** Character ids still available to draft. */
  draftRemaining: readonly string[];
  /** Character ids drafted onto side A's squad, in pick order. */
  squadAIds: readonly string[];
  /** Character ids drafted onto side B's squad, in pick order. */
  squadBIds: readonly string[];
  /** Character ids benched (not on-field) for side A, in bench order. */
  benchA: readonly string[];
  /** Character ids benched (not on-field) for side B, in bench order. */
  benchB: readonly string[];
  /** Substitutions side A has used so far this match. */
  subsUsedA: number;
  /** Substitutions side B has used so far this match. */
  subsUsedB: number;
  /** Batting side's upcoming-batter queue, EXCLUDING the current batter — front of the list is next up. */
  queueIds: readonly string[];
}

export type ConnectOptions = { mode: 'create' } | { mode: 'join'; code: string };

/** 4 crypto-random uppercase letters — a rendezvous string, not a secret. */
function generateCode(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => letters[b % 26] ?? 'A').join('');
}

export interface Net {
  room: Room<MatchStateView>;
  /** Current authoritative phase (read from synced state; no client-side rules). */
  phase(): MatchPhase;
  /** This client's side, derived from sessionId vs sessionA/B ('A'/'B'), or null pre-assignment. */
  mySide(): 'A' | 'B' | null;
  /** This client's role in the current play, or null outside PLAY / before a side is assigned. */
  myRole(): 'batting' | 'fielding' | null;
  sendPitch(input: PitchInput): void;
  sendSwing(input: SwingInput & { timing: number }): void;
  sendRunDecision(input: RunDecisionInput): void;
  sendDraftPick(input: DraftPickInput): void;
  sendSetPitcher(input: SetPitcherInput): void;
  sendReposition(input: RepositionInput): void;
  sendSubstitute(input: SubstituteInput): void;
  sendSetBatter(input: SetBatterInput): void;
  sendConfirmPositioning(): void;
  sendReadyForPlay(): void;
  sendRematch(): void;
  onPlayOutcome(callback: (resolution: PlayResolution) => void): void;
  onRejected(callback: (rejection: RejectionEvent) => void): void;
  onOpponentLeft(callback: (side: string) => void): void;
  /**
   * Fires ONCE if the room connection drops without us leaving deliberately
   * (raw socket loss, server crash — NOT consented leave() and NOT after
   * opponentLeft, both of which are deliberate teardowns).
   */
  onUnexpectedDisconnect(callback: () => void): void;
  /**
   * One reconnect attempt with the stored token. Resolves a FRESH Net bound to
   * the recovered room (the old Net is dead — re-run all match wiring against
   * the new one), or null when the grace expired / token invalid / offline.
   */
  tryReconnect(): Promise<Net | null>;
  /** Mark the next room leave as deliberate (suppresses onUnexpectedDisconnect). */
  markLeaving(): void;
}

/** Module-level storage for the current room's reconnection token (M10 reconnect surface). */
let reconnectionToken: string | null = null;

/**
 * Builds the full `Net` surface around an already-joined/reconnected `room`.
 * Shared by `connect` and `tryReconnect` so the two paths cannot drift.
 */
function wrapRoom(room: Room<MatchStateView>): Net {
  let leaving = false;
  let unexpectedDisconnectCallback: (() => void) | null = null;

  const mySide = (): 'A' | 'B' | null => {
    if (room.sessionId === room.state.sessionA) return 'A';
    if (room.sessionId === room.state.sessionB) return 'B';
    return null;
  };

  room.onLeave(() => {
    if (leaving) return;
    unexpectedDisconnectCallback?.();
  });

  const net: Net = {
    room,
    phase() {
      return room.state.phase;
    },
    mySide,
    myRole() {
      const side = mySide();
      if (side === null || room.state.phase !== 'PLAY') return null;
      return room.state.battingSide === side ? 'batting' : 'fielding';
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
    sendDraftPick(input) {
      room.send('draftPick', input);
    },
    sendSetPitcher(input) {
      room.send('setPitcher', input);
    },
    sendReposition(input) {
      room.send('reposition', input);
    },
    sendSubstitute(input) {
      room.send('substitute', input);
    },
    sendSetBatter(input) {
      room.send('setBatter', input);
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
    onOpponentLeft(callback) {
      room.onMessage('opponentLeft', (m: { side: string }) => {
        // opponentLeft is a deliberate teardown (either a consented quit or an
        // expired reconnect grace) — suppress the subsequent unexpected-disconnect
        // signal that the room close will otherwise also raise.
        leaving = true;
        callback(m.side);
      });
    },
    onUnexpectedDisconnect(callback) {
      unexpectedDisconnectCallback = callback;
    },
    async tryReconnect() {
      const token = reconnectionToken;
      if (token === null) return null;
      try {
        const freshClient = new Client(SERVER_URL);
        const freshRoom = await freshClient.reconnect<MatchStateView>(token);
        reconnectionToken = freshRoom.reconnectionToken;
        return wrapRoom(freshRoom);
      } catch {
        return null;
      }
    },
    markLeaving() {
      leaving = true;
    },
  };

  reconnectionToken = room.reconnectionToken;
  return net;
}

export async function connect(opts: ConnectOptions): Promise<Net> {
  const client = new Client(SERVER_URL);
  const room =
    opts.mode === 'create'
      ? await client.create<MatchStateView>('match', { code: generateCode() })
      : await client.join<MatchStateView>('match', { code: opts.code.trim().toUpperCase() });
  return wrapRoom(room);
}
