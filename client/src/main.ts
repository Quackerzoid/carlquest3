import { CHARACTERS, type PlayOutcome, type PlayResolution } from '@carlquest/shared';
import { createScene } from './SceneModule';
import { connect, type MatchStateView } from './NetModule';
import { createBallView, createFieldersView, createRunnersView } from './RenderModule';
import { attachInput } from './InputModule';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const status = document.querySelector<HTMLPreElement>('#status');
if (!canvas || !status) throw new Error('Missing #app canvas or #status line');

const { scene, start } = createScene(canvas);
const ball = createBallView(scene);
const fielders = createFieldersView(scene);
const runners = createRunnersView(scene);
start();

const HELP = 'A/S/D spin · P pitch · Space swing · R run · T stop · Enter confirm/ready · N rematch';

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

/** `phase | A x½ – B y½ | innings i | outs o | batter: name` + last play + help. */
function statusLine(state: MatchStateView, lastPlay: string, localAction: string): string {
  const score = `A ${String(state.scoreHalvesA)}½ – B ${String(state.scoreHalvesB)}½`;
  const winner = state.winner ? ` | winner: ${state.winner}` : '';
  const tiebreak = state.tiebreak ? ' | TIEBREAK' : '';
  const head =
    `${state.phase} | ${score} | innings ${String(state.inningsIndex + 1)} | ` +
    `outs ${String(state.outs)} | batter: ${characterName(state.currentBatterId)}` +
    `${tiebreak}${winner}`;
  const tail = [lastPlay && `last: ${lastPlay}`, localAction, HELP].filter(Boolean).join(' — ');
  return `${head}\n${tail}`;
}

connect()
  .then((net) => {
    let lastPlay = '';
    let localAction = '';
    const refresh = () => {
      status.textContent = statusLine(net.room.state, lastPlay, localAction);
    };
    status.textContent = `connected — ${HELP}`;
    attachInput(net, (text) => {
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
    net.room.onStateChange((state) => {
      ball.update(state.ball.x, state.ball.y, state.ball.z, state.ballLive);
      fielders.update(state.fielders.values());
      runners.update(state.runners.values());
      refresh();
    });
  })
  .catch((error: unknown) => {
    status.textContent = `connection failed: ${String(error)} — is the server running?`;
  });
