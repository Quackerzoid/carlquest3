import type { ConfigOptions } from '@colyseus/tools';
import { MatchRoom } from './rooms/MatchRoom';

// `@colyseus/tools` is published as CommonJS without an `exports` map, so its
// `export default` helper is unreliable to import under real Node ESM (the
// interop default resolves to the whole `module.exports`). The helper is an
// identity function over `ConfigOptions`, so we export a typed plain object
// instead — both `listen()` and `@colyseus/testing`'s `boot()` accept it
// directly, keeping one config shared by the real entrypoint and the tests.

/** Single app config shared by the real entrypoint and @colyseus/testing. */
const appConfig: ConfigOptions = {
  initializeGameServer: (gameServer) => {
    gameServer.define('match', MatchRoom);
  },
};

export default appConfig;
