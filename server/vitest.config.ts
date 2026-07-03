import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The default forks pool crashes on Windows when the Colyseus test
    // server's console output is relayed over child-process IPC (tinypool
    // Buffer deserialisation bug in Vitest 2.x), so run this project in
    // worker threads instead.
    pool: 'threads',
  },
});
