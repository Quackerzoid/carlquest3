import { createScene } from './SceneModule';
import { connect, type MatchStateView, type Net } from './NetModule';
import {
  createBallView,
  createBatterView,
  createBenchView,
  createFieldersView,
  createRunnersView,
} from './RenderModule';
import type { KitId } from './CharacterModels';
import { attachInput } from './InputModule';
import { createCameraControls } from './CameraControls';
import { createDraftScreen } from './DraftScreen';
import { createPositioningControls, type SelectionStore } from './PositioningControls';
import { createUI, describeResolution } from './UIModule';
import { initTooltips } from './Tooltips';

const canvasEl = document.querySelector<HTMLCanvasElement>('#app');
const hudEl = document.querySelector<HTMLDivElement>('#hud');
const draftEl = document.querySelector<HTMLDivElement>('#draft');
const lobbyEl = document.querySelector<HTMLDivElement>('#lobby');
const lobbySetupEl = document.querySelector<HTMLDivElement>('#lobby-setup');
const lobbyWaitingEl = document.querySelector<HTMLDivElement>('#lobby-waiting');
const lobbyCodeEl = document.querySelector<HTMLDivElement>('#lobby-code');
const lobbyErrorEl = document.querySelector<HTMLParagraphElement>('#lobby-error');
const createButtonEl = document.querySelector<HTMLButtonElement>('#lobby-create');
const joinButtonEl = document.querySelector<HTMLButtonElement>('#lobby-join');
const joinCodeInputEl = document.querySelector<HTMLInputElement>('#join-code');
const tooltipEl = document.querySelector<HTMLDivElement>('#tooltip');
const readyButtonEl = document.querySelector<HTMLButtonElement>('#ready-button');
const readyLabelEl = document.querySelector<HTMLSpanElement>('#ready-label');
const readySubEl = document.querySelector<HTMLSpanElement>('#ready-sub');
if (
  !canvasEl ||
  !hudEl ||
  !draftEl ||
  !lobbyEl ||
  !lobbySetupEl ||
  !lobbyWaitingEl ||
  !lobbyCodeEl ||
  !lobbyErrorEl ||
  !createButtonEl ||
  !joinButtonEl ||
  !joinCodeInputEl ||
  !tooltipEl ||
  !readyButtonEl ||
  !readyLabelEl ||
  !readySubEl
) {
  throw new Error('Missing lobby or #app/#hud DOM elements');
}
// Rebind as non-null so nested functions below don't need re-narrowing.
const canvas = canvasEl;
const draft = draftEl;
const lobby = lobbyEl;
const lobbySetup = lobbySetupEl;
const lobbyWaiting = lobbyWaitingEl;
const lobbyCode = lobbyCodeEl;
const lobbyError = lobbyErrorEl;
const createButton = createButtonEl;
const joinButton = joinButtonEl;
const joinCodeInput = joinCodeInputEl;
const readyButton = readyButtonEl;
const readyLabel = readyLabelEl;
const readySub = readySubEl;

// One page-lifetime tooltip driver over all [data-tip] elements.
initTooltips(tooltipEl);

const { scene, camera, start } = createScene(canvas);
const ball = createBallView(scene);
const fielders = createFieldersView(scene);
const runners = createRunnersView(scene);
const batterView = createBatterView(scene);
const bench = createBenchView(scene);
start();

// Camera controls live for the PAGE lifetime, like the views: orbiting is a spectator
// affordance, not per-match state, so it is created once and never detached per match.
const cameraControls = createCameraControls(canvas, camera);

/** Kit for the current batter, derived from drafted-squad membership. */
function kitOf(id: string, state: MatchStateView): KitId {
  if ((state.squadAIds ?? []).includes(id)) return 'A';
  if ((state.squadBIds ?? []).includes(id)) return 'B';
  return 'neutral';
}

const ui = createUI(hudEl);

// Shared between PositioningControls (writer, on click) and DraftScreen (writer, on
// bench click / reader, for the [selected] badge) — one selected fielder id at a time.
// The store is the SINGLE source of truth for the 3D highlight: `set()` itself mirrors
// to `fielders.setSelected`, so every selection path (3D click, panel click, Escape
// clear, substitution, innings switch) stays in sync by construction — no caller may
// call `fielders.setSelected` directly.
let selectedFielderId: string | null = null;
const selection: SelectionStore = {
  get: () => selectedFielderId,
  set: (id) => {
    selectedFielderId = id;
    fielders.setSelected(id);
  },
};

/** The one live match's connection + teardown; null while in the lobby. */
let active: { net: Net; teardown(): void } | null = null;

// -------------------------------------------------------------------- READY button
// Bottom-right, large, stylised. Shows in INITIAL_POSITIONING ('CONFIRM SETUP') and
// PRE_PLAY ('READY UP'); GREEN idle → BLUE + ✓ 'WAITING FOR OPPONENT' once sent;
// hidden elsewhere. The server has no per-side confirm echo, so the confirmed state
// is CLIENT-LOCAL: we latch "sent for this phase instance" on click/Enter and reset
// the latch whenever the phase changes. Click AND the Enter key (InputModule) drive
// the SAME net senders — sendConfirmPositioning / sendReadyForPlay per phase.
type ReadyPhase = 'INITIAL_POSITIONING' | 'PRE_PLAY';
/** The phase we last confirmed for; null means "not confirmed for the current phase". */
let readyConfirmedForPhase: ReadyPhase | null = null;

function readyPhaseOf(phase: string): ReadyPhase | null {
  return phase === 'INITIAL_POSITIONING' || phase === 'PRE_PLAY' ? phase : null;
}

/** Fire the phase-appropriate ready message (shared by the button and the Enter key). */
function sendReady(net: Net): void {
  const rp = readyPhaseOf(net.phase());
  if (rp === null || readyConfirmedForPhase === rp) return;
  if (rp === 'INITIAL_POSITIONING') net.sendConfirmPositioning();
  else net.sendReadyForPlay();
  readyConfirmedForPhase = rp;
  renderReady(net.phase());
}

/** Re-render the READY button for a phase (called on every state patch and on send). */
function renderReady(phase: string): void {
  const rp = readyPhaseOf(phase);
  // Reset the client-local latch whenever we leave the phase we confirmed for.
  if (readyConfirmedForPhase !== null && readyConfirmedForPhase !== rp) {
    readyConfirmedForPhase = null;
  }
  if (rp === null || active === null) {
    readyButton.hidden = true;
    readyButton.dataset['tip'] = '';
    return;
  }
  readyButton.hidden = false;
  const confirmed = readyConfirmedForPhase === rp;
  readyButton.classList.toggle('is-waiting', confirmed);
  if (confirmed) {
    readyLabel.textContent = 'READY';
    readySub.textContent = 'waiting for opponent';
    readyButton.dataset['tip'] = 'You are set. Waiting for your opponent to ready up too.';
  } else if (rp === 'INITIAL_POSITIONING') {
    readyLabel.textContent = 'CONFIRM SETUP';
    readySub.textContent = '';
    readyButton.dataset['tip'] =
      'Lock in your line-up and positioning. The play starts once both sides confirm.';
  } else {
    readyLabel.textContent = 'READY UP';
    readySub.textContent = '';
    readyButton.dataset['tip'] = 'Ready for the next play. It begins once both sides are ready.';
  }
}

readyButton.addEventListener('click', () => {
  if (active) sendReady(active.net);
});

// Result-overlay buttons: wired ONCE (the UI is a singleton); they act on whichever
// match is live when clicked.
ui.onRematchClick(() => {
  active?.net.sendRematch();
});
ui.onLeaveClick(() => {
  if (!active) return;
  const { net, teardown } = active;
  net.markLeaving();
  teardown();
  void net.room.leave().catch(() => {
    // Room may already be closing/closed server-side; nothing more to do.
  });
  showLobbySetup();
});

/** Plain-words feed line for a server rejection (exact map per the M10 plan). */
function describeRejection(reason: string): string {
  if (reason === 'wrongRole') return 'not your role';
  if (reason === 'paused') return 'game is paused';
  return reason;
}

function showLobbySetup(notice = ''): void {
  lobby.hidden = false;
  lobbySetup.style.display = '';
  lobbyWaiting.style.display = 'none';
  createButton.disabled = false;
  joinButton.disabled = false;
  lobbyError.textContent = notice;
}

function showLobbyWaiting(code: string): void {
  lobbySetup.style.display = 'none';
  lobbyWaiting.style.display = 'block';
  lobbyCode.textContent = code;
}

function hideLobby(): void {
  lobby.hidden = true;
}

function runMatch(net: Net): void {
  // Tracks the fielding/batting flip across innings so a leftover positioning
  // selection from the old fielding side doesn't survive into the next one.
  let lastBattingSide: string | null = null;
  // Feed-event edge detection (opponent joined, rematch started, paused/resumed).
  let lastPhase: string | null = null;
  let lastPaused = false;
  // Per-net, like attachInput: holds the net closure. createDraftScreen empties
  // its container on creation, so re-entry after opponentLeft is clean.
  selection.set(null);
  const draftScreen = createDraftScreen(draft, net, selection);
  const { detach } = attachInput(net, (action) => {
    // Local key echoes retired with the status line — the feed carries authoritative
    // events only. But the READY button's client-local confirmed latch must follow
    // the Enter key too: InputModule already SENT the message, so here we only mirror
    // the latch + re-render (no re-send) so the button flips green→blue on Enter.
    if (action === 'confirm positioning' || action === 'ready for play') {
      const rp = readyPhaseOf(net.phase());
      if (rp !== null) {
        readyConfirmedForPhase = rp;
        renderReady(net.phase());
      }
    }
  });
  const positioningControls = createPositioningControls(
    canvas,
    camera,
    fielders,
    net,
    selection,
    () => {
      // As above: selection feedback lives in the 3D highlight + panel badge now.
    },
    // A click that concludes (or closely follows) an orbit drag must not reposition.
    cameraControls.dragging,
  );

  // Single teardown for EVERY way a match ends (opponent left, leave button,
  // reconnect success/failure): detach listeners, clear selection, reset the HUD.
  let torn = false;
  const teardown = (): void => {
    if (torn) return;
    torn = true;
    detach();
    positioningControls.detach();
    selection.set(null);
    batterView.update(null, 'neutral', false); // hide the batter; dispose stays page-lifetime
    ui.reset();
    readyButton.hidden = true; // the READY button belongs to the live match only
    readyConfirmedForPhase = null;
    if (active?.net === net) active = null;
  };
  active = { net, teardown };
  readyConfirmedForPhase = null; // fresh confirmed-latch for this match

  net.onPlayOutcome((resolution) => {
    if (torn) return;
    ui.pushEvent(describeResolution(resolution));
    for (const id of resolution.outs) runners.markOut(id);
  });
  net.onRejected((rejection) => {
    if (torn) return;
    ui.pushEvent(describeRejection(rejection.reason));
  });
  net.onRoll((e) => {
    if (torn) return;
    // Banner + feed line (showRoll echoes to the feed itself), plus the matching
    // 3D beat: the bowler's wind-up on the pitch roll, the bat swing on the swing
    // roll (connect and miss both swing — a miss just follows through).
    ui.showRoll(e);
    if (e.contest === 'pitch') fielders.windUp(e.actorId);
    else if (e.contest === 'swing') batterView.swing();
  });
  net.onOpponentLeft((side) => {
    net.markLeaving();
    teardown();
    void net.room.leave().catch(() => {
      // Room may already be closing/closed server-side; nothing more to do.
    });
    showLobbySetup(`opponent left — match over (side ${side})`);
  });
  net.onUnexpectedDisconnect(() => {
    void (async () => {
      ui.pushEvent('connection lost — reconnecting…');
      ui.setNotice('reconnecting…');
      const fresh = await net.tryReconnect();
      // The user may have clicked LEAVE while the reconnect was in flight — that
      // handler already called teardown() (setting `torn`) and returned to the
      // lobby. Capture torn's state from BEFORE this teardown() call: if it was
      // already true, the match was deliberately abandoned and a resolved
      // reconnect must not re-enter it (it would silently pull the player back
      // into the match they just left).
      const deliberatelyLeft = torn;
      teardown();
      if (deliberatelyLeft) {
        // Don't strand the freshly-reconnected room the player no longer wants.
        void fresh?.room.leave().catch(() => {
          // Already closing/closed server-side; nothing more to do.
        });
        return;
      }
      if (fresh) {
        runMatch(fresh);
        ui.pushEvent('reconnected');
      } else {
        showLobbySetup('connection lost');
      }
    })();
  });
  net.room.onStateChange((state) => {
    if (torn) return; // a straggler patch after teardown must not resurrect the HUD
    if (state.battingSide !== lastBattingSide) {
      lastBattingSide = state.battingSide;
      selection.set(null);
    }
    if (lastPhase === 'LOBBY' && state.phase !== 'LOBBY') ui.pushEvent('opponent joined');
    if (lastPhase === 'GAME_OVER' && state.phase !== 'GAME_OVER' && state.phase !== 'LOBBY') {
      // Rematch: the feed is per-match — clear it, then note the restart.
      ui.reset();
      ui.pushEvent('rematch started');
    }
    if (state.paused && !lastPaused) ui.pushEvent('game paused — opponent disconnected');
    if (!state.paused && lastPaused) ui.pushEvent('game resumed');
    lastPhase = state.phase;
    lastPaused = state.paused;
    ball.update(state.ball.x, state.ball.y, state.ball.z, state.ballLive);
    // Phase drives interpolation speed: fast in PLAY, walk-clamped elsewhere (T4).
    fielders.setPhase(state.phase);
    runners.setPhase(state.phase);
    batterView.setPhase(state.phase);
    bench.setPhase(state.phase);
    // Kit assignments before the per-entity updates, so a post-draft patch builds
    // new models directly in the right kit (empty pre-draft → everyone neutral).
    fielders.setTeams([...state.squadAIds], [...state.squadBIds]);
    runners.setTeams([...state.squadAIds], [...state.squadBIds]);
    bench.setTeams([...state.squadAIds], [...state.squadBIds]);
    fielders.update(state.fielders.values());
    runners.update(state.runners.values());
    // Current batter at the batting square; suppressed (hidden, not disposed) while a
    // runner with the same id is on-field so there is never a double render.
    const batterId = state.currentBatterId || null;
    batterView.update(
      batterId,
      batterId === null ? 'neutral' : kitOf(batterId, state),
      batterId !== null && state.runners.has(batterId),
    );
    // The batting side's off-field squad walks to a bench beside the field (T4:
    // pure client choreography, derived only from synced state).
    bench.update({
      squadAIds: state.squadAIds,
      squadBIds: state.squadBIds,
      battingSide: state.battingSide,
      currentBatterId: state.currentBatterId,
      runnerIds: [...state.runners.keys()],
    });
    if (state.phase === 'LOBBY') {
      // Idempotent refresh: the first patch may arrive after showLobbyWaiting's
      // synchronous read, and later patches are harmless no-op re-assignments.
      if (state.roomCode) lobbyCode.textContent = state.roomCode;
    } else {
      hideLobby();
    }
    draftScreen.update(state, net.mySide());
    ui.update(state, net);
    renderReady(state.phase);
  });
}

async function startCreate(): Promise<void> {
  createButton.disabled = true;
  joinButton.disabled = true;
  lobbyError.textContent = '';
  try {
    const net = await connect({ mode: 'create' });
    showLobbyWaiting(net.room.state.roomCode);
    runMatch(net);
  } catch (error: unknown) {
    lobbyError.textContent = `could not create match: ${String(error)}`;
    createButton.disabled = false;
    joinButton.disabled = false;
  }
}

async function startJoin(): Promise<void> {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) {
    lobbyError.textContent = 'enter the 4-letter code';
    return;
  }
  createButton.disabled = true;
  joinButton.disabled = true;
  lobbyError.textContent = '';
  try {
    const net = await connect({ mode: 'join', code });
    runMatch(net);
  } catch (error: unknown) {
    lobbyError.textContent = `could not join match: ${String(error)}`;
    createButton.disabled = false;
    joinButton.disabled = false;
  }
}

createButton.addEventListener('click', () => {
  void startCreate();
});
joinButton.addEventListener('click', () => {
  void startJoin();
});
joinCodeInput.addEventListener('input', () => {
  joinCodeInput.value = joinCodeInput.value.toUpperCase().slice(0, 4);
});
joinCodeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void startJoin();
});

showLobbySetup();
