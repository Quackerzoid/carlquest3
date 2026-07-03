import { listen } from '@colyseus/tools';
import appConfig from './app.config';

// Named CJS exports (unlike `default`) are detected by Node's ESM interop,
// so this import is safe under tsx, Node and Vite alike.
void listen(appConfig, 2567);
