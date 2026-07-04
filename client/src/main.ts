import { createScene } from './SceneModule';
import { connect, type Net } from './NetModule';
import { createBallView, createFieldersView, createRunnersView } from './RenderModule';
import { attachInput } from './InputModule';
import { createDraftScreen } from './DraftScreen';
import { createPositioningControls, type SelectionStore } from './PositioningControls';
import { createUI, describeResolution } from './UIModule';

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
  !joinCodeInputEl
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

const { scene, camera, start } = createScene(canvas);
const ball = createBallView(scene);
const fielders = createFieldersView(scene);
const runners = createRunnersView(scene);
start();

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
  const { detach } = attachInput(net, () => {
    // Local key echoes retired with the status line — the feed carries authoritative
    // events only (play resolutions, rejections, connection changes).
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
    ui.reset();
    if (active?.net === net) active = null;
  };
  active = { net, teardown };

  net.onPlayOutcome((resolution) => {
    if (torn) return;
    ui.pushEvent(describeResolution(resolution));
    for (const id of resolution.outs) runners.markOut(id);
  });
  net.onRejected((rejection) => {
    if (torn) return;
    ui.pushEvent(describeRejection(rejection.reason));
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
    // Kit assignments before the per-entity updates, so a post-draft patch builds
    // new models directly in the right kit (empty pre-draft → everyone neutral).
    fielders.setTeams([...state.squadAIds], [...state.squadBIds]);
    runners.setTeams([...state.squadAIds], [...state.squadBIds]);
    fielders.update(state.fielders.values());
    runners.update(state.runners.values());
    if (state.phase === 'LOBBY') {
      // Idempotent refresh: the first patch may arrive after showLobbyWaiting's
      // synchronous read, and later patches are harmless no-op re-assignments.
      if (state.roomCode) lobbyCode.textContent = state.roomCode;
    } else {
      hideLobby();
    }
    draftScreen.update(state, net.mySide());
    ui.update(state, net);
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
