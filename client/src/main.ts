import { createScene } from './SceneModule';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('Missing #app canvas');

createScene(canvas).start();
