// Vendored protocol surface for the external agent.
// Keep this intentionally small: the client treats protocol payloads as JSON and
// only needs the action/state shapes it receives from unbrewed-engine.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Action {
  type: string;
  [key: string]: Json | undefined;
}

export interface ServerStateMessage {
  v: number;
  type: 'STATE';
  view: Json;
  legalActions: Action[];
  events?: Json[];
}

export interface RoomJoinedMessage {
  v: number;
  type: 'ROOM_CREATED' | 'ROOM_JOINED';
  roomId: string;
  token: string;
  you: string;
}

export interface ReplayMeta {
  winner: string | null;
  heroes: Record<string, string>;
  turns: number;
  endedAt: number;
  mapTitle: string;
}

export interface ReplayBundle {
  v: 1;
  engine: { schemaVersion: number; dslVersion: string };
  config: Json;
  actionLog: Action[];
  meta: ReplayMeta;
}

export interface ReplayBundleMessage {
  v: number;
  type: 'REPLAY_BUNDLE';
  bundle: ReplayBundle;
}

export type ServerMessage =
  | ServerStateMessage
  | RoomJoinedMessage
  | ReplayBundleMessage
  | { v: number; type: 'ERROR'; code?: string; message?: string }
  | { v: number; type: string; [key: string]: Json | undefined };

export const PROTOCOL_VERSION = 21;
