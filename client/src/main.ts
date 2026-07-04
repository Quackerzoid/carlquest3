import { CHARACTERS, type PlayOutcome, type PlayResolution } from '@carlquest/shared';
import { createScene } from './SceneModule';
import { connect, type MatchStateView, type Net } from './NetModule';
import { createBallView, createFieldersView, createRunnersView } from './RenderModule';
import { attachInput } from './InputModule';
import { createDraftScreen } from './DraftScreen';

const canvasEl = document.querySelector<HTMLCanvasElement>('#app');
const statusEl = document.querySelector<HTMLPreElement>('#status');
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
  !statusEl ||
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
  throw new Error('Missing lobby or #app/#status DOM elements');
}
// Rebind as non-null so nested functions below don't need re-narrowing.
const canvas = canvasEl;
const status = statusEl;
const draft = draftEl;
const lobby = lobbyEl;
const lobbySetup = lobbySetupEl;
const lobbyWaiting = lobbyWaitingEl;
const lobbyCode = lobbyCodeEl;
const lobbyError = lobbyErrorEl;
const createButton = createButtonEl;
const joinButton = joinButtonEl;
const joinCodeInput = joinCodeInputEl;

const { scene, start } = createScene(canvas);
const ball = createBallView(scene);
const fielders = createFieldersView(scene);
const runners = createRunnersView(scene);
start();

const HELP =
  'A/S/D spin · P pitch · Space swing · R run · T stop · Enter confirm/ready · N rematch ' +
  '(keys only act for your own role)';

function characterName(id: string): string {
  // Tolerant lookup for the status line (unlike shared getCharacter, which throws).
  return CHARACTERS.find((c) => c.id === id)?.name ?? '—';
}

function describeCause(cause: PlayOutcome): string {
  switch (cause.kind) {
    case 'caught':
      return `caught by ${characterName(cause.by)}`;
    case 'runOut':
      return `${characterName(cause.runnerId)} run out at post ${String(cause.atPost)}`;
    case 'safe':
      return `${characterName(cause.runnerId)} safe at post ${String(cause.atPost)}`;
    case 'rounder':
      return 'rounder!';
  }
}

function describeResolution(resolution: PlayResolution): string {
  const parts = [describeCause(resolution.cause)];
  if (resolution.scoreDeltaHalves > 0) parts.push(`+${String(resolution.scoreDeltaHalves)}½`);
  if (resolution.outs.length > 0) parts.push(`out: ${resolution.outs.map(characterName).join(', ')}`);
  return parts.join(' · ');
}

/** `phase | A x½ – B y½ | innings i | outs o | batter: name` + side/role + last play + help. */
function statusLine(net: Net, state: MatchStateView, lastPlay: string, localAction: string): string {
  const score = `A ${String(state.scoreHalvesA)}½ – B ${String(state.scoreHalvesB)}½`;
  const winner = state.winner ? ` | winner: ${state.winner}` : '';
  const tiebreak = state.tiebreak ? ' | TIEBREAK' : '';
  const side = net.mySide();
  const role = net.myRole();
  const you = side ? ` | you are ${side}${role ? ` · ${role}` : ''}` : '';
  const draftSegment =
    state.phase === 'DRAFT'
      ? ` | ${state.draftTurn === side ? 'your pick' : 'opponent picks'}`
      : '';
  const bowlerSegment =
    state.phase === 'INITIAL_POSITIONING' || state.phase === 'PRE_PLAY' || state.phase === 'PLAY'
      ? ` | bowler: ${characterName(state.currentPitcherId)}`
      : '';
  const head =
    `${state.phase} | ${score} | innings ${String(state.inningsIndex + 1)} | ` +
    `outs ${String(state.outs)} | batter: ${characterName(state.currentBatterId)}` +
    `${tiebreak}${winner}${you}${draftSegment}${bowlerSegment}`;
  const paused = state.paused === true ? 'opponent disconnected — waiting for reconnect' : '';
  const tail = [paused, lastPlay && `last: ${lastPlay}`, localAction, HELP].filter(Boolean).join(' — ');
  return `${head}\n${tail}`;
}

function showLobbySetup(): void {
  lobby.hidden = false;
  lobbySetup.style.display = '';
  lobbyWaiting.style.display = 'none';
  createButton.disabled = false;
  joinButton.disabled = false;
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
  let lastPlay = '';
  let localAction = '';
  // Per-net, like attachInput: holds the net closure. createDraftScreen empties
  // its container on creation, so re-entry after opponentLeft is clean.
  const draftScreen = createDraftScreen(draft, net);
  const refresh = () => {
    status.textContent = statusLine(net, net.room.state, lastPlay, localAction);
  };
  status.textContent = `connected — ${HELP}`;
  const { detach } = attachInput(net, (text) => {
    localAction = text;
    refresh();
  });
  net.onPlayOutcome((resolution) => {
    lastPlay = describeResolution(resolution);
    refresh();
  });
  net.onRejected((rejection) => {
    localAction = `rejected ${rejection.message} (${rejection.phase}): ${rejection.reason}`;
    refresh();
  });
  net.onOpponentLeft((side) => {
    status.textContent = `opponent left — match over (side ${side})`;
    detach();
    void net.room.leave().catch(() => {
      // Room may already be closing/closed server-side; nothing more to do.
    });
    showLobbySetup();
  });
  net.room.onStateChange((state) => {
    ball.update(state.ball.x, state.ball.y, state.ball.z, state.ballLive);
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
    refresh();
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
status.textContent = `${HELP}`;
