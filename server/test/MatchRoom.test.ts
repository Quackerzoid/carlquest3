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

  it('pitch while idle makes the ball live with stat-derived speed', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    await client.waitForNextPatch();
    expect(client.state.ballLive).toBe(true);
    const speed = Math.hypot(client.state.ball.vx, client.state.ball.vy, client.state.ball.vz);
    expect(speed).toBeGreaterThan(20); // Kian pitch 8 → 26.4 m/s minus a tick of damping/gravity coupling
    expect(speed).toBeLessThan(27);
  });

  it('rejects a second pitch while the ball is live', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    const before = { ...room.state.ball };
    client.send('pitch', { aim: { x: 1, y: 0, z: 0 }, spinInput: 1 });
    await room.waitForNextSimulationTick();
    // Velocity direction unchanged (second pitch ignored; ball still travelling -z)
    expect(room.state.ball.vz).toBeLessThan(0);
    expect(Math.sign(room.state.ball.vx)).toBe(Math.sign(before.vx));
    expect(room.state.demoLog).toContain('rejected');
  });

  it('rejects a swing when no ball is live', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('swing', { timing: 0, aim: { x: 0.5, y: 0.3, z: 1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.demoLog).toContain('rejected');
  });

  it('rejects a pitch message sent with no payload instead of crashing', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch');
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.demoLog).toContain('rejected');
  });

  it('rejects a swing message sent with a null payload instead of crashing', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('swing', null);
    await room.waitForNextSimulationTick();
    expect(room.state.ballLive).toBe(false);
    expect(room.state.demoLog).toContain('rejected');
  });

  it('stays responsive to a valid pitch after payload-less pitch/swing messages', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch');
    await room.waitForNextSimulationTick();
    client.send('swing', null);
    await room.waitForNextSimulationTick();
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    await client.waitForNextPatch();
    expect(client.state.ballLive).toBe(true);
    const speed = Math.hypot(client.state.ball.vx, client.state.ball.vy, client.state.ball.vz);
    expect(speed).toBeGreaterThan(20);
    expect(speed).toBeLessThan(27);
  });

  it('full loop: pitch, wait for plane crossing, swing connects and reverses flight', async () => {
    const room = await colyseus.createRoom('match', {});
    const client = await colyseus.connectTo(room);
    client.send('pitch', { aim: { x: 0, y: 0, z: -1 }, spinInput: 0 });
    // Ball travels ~7.5 m at ~26.4 m/s ≈ 0.284 s ≈ 17 ticks. Poll until it nears the plane.
    for (let i = 0; i < 60; i += 1) {
      await room.waitForNextSimulationTick();
      if (room.state.ball.z < 0.5) break;
    }
    client.send('swing', { timing: 0, aim: { x: 0.5, y: 0.3, z: 1 }, spinInput: 0 });
    await room.waitForNextSimulationTick();
    await room.waitForNextSimulationTick();
    // A connected hit sends the ball back out (+z-ish per the demo aim) at hit speed.
    expect(room.state.ball.vz).toBeGreaterThan(0);
    const speed = Math.hypot(room.state.ball.vx, room.state.ball.vy, room.state.ball.vz);
    expect(speed).toBeGreaterThan(10);
  }, 15000);
});
