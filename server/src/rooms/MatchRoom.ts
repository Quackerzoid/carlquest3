import { Room, type Client } from '@colyseus/core';
import { MatchState } from './MatchState';

/** Authoritative match room. Game modules attach here in later milestones. */
export class MatchRoom extends Room<MatchState> {
  override maxClients = 2;

  override onCreate(): void {
    this.setState(new MatchState());
  }

  override onJoin(client: Client): void {
    console.log(`client ${client.sessionId} joined`);
  }

  override onLeave(client: Client): void {
    console.log(`client ${client.sessionId} left`);
  }
}
