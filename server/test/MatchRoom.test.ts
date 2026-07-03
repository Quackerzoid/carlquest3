import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, ColyseusTestServer } from '@colyseus/testing';
import appConfig from '../src/app.config';

describe('MatchRoom', () => {
  let colyseus: ColyseusTestServer;

  beforeAll(async () => {
    colyseus = await boot(appConfig);
  });
  afterAll(async () => {
    await colyseus.shutdown();
  });

  it('boots and lets a client join the match room in LOBBY phase', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    // The colyseus.js client applies the initial full-state snapshot
    // asynchronously after the join handshake resolves, so reading
    // `client.state` immediately after `connectTo` races that decode step
    // (observed intermittently as `client.state.phase === undefined`).
    // `onStateChange` fires once the state has actually been applied —
    // including for this first snapshot, not just later patches — so
    // waiting on it (rather than the server-side `room.waitForNextPatch()`,
    // or the client-side `waitForNextPatch()`, which only resolves on a
    // *subsequent* patch and never fires in this empty room) is the
    // documented way to await readiness of `client.state`. Guard against
    // the opposite race too (state already applied before we subscribe) by
    // checking synchronously first.
    if (client.state.phase === undefined) {
      await new Promise<void>((resolve) => client.onStateChange.once(() => resolve()));
    }
    expect(client.state.phase).toBe('LOBBY');
  });

  it('caps the room at two clients', async () => {
    const room = await colyseus.createRoom('match', {});
    expect(room.maxClients).toBe(2);
  });
});
