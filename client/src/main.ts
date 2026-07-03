import { createScene } from './SceneModule';
import { connect } from './NetModule';
import { createBallView } from './RenderModule';
import { attachInput } from './InputModule';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const status = document.querySelector<HTMLPreElement>('#status');
if (!canvas || !status) throw new Error('Missing #app canvas or #status line');

const { scene, start } = createScene(canvas);
const ball = createBallView(scene);
start();

const HELP = 'A/S/D spin · P pitch · Space swing';

connect()
  .then((net) => {
    status.textContent = `connected — ${HELP}`;
    attachInput(net, (text) => {
      status.textContent = `${text} — ${HELP}`;
    });
    net.room.onStateChange((state) => {
      ball.update(state.ball.x, state.ball.y, state.ball.z, state.ballLive);
      if (state.demoLog) status.textContent = `${state.demoLog} — ${HELP}`;
    });
  })
  .catch((error: unknown) => {
    status.textContent = `connection failed: ${String(error)} — is the server running?`;
  });
