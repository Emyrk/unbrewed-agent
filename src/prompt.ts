import { indexLegalActions } from './actions.js';
import type { ServerStateMessage } from './protocol.js';

export const GAMEPLAY_SYSTEM_PROMPT = `You are playing Unbrewed Pro as an external policy client.
You receive only a redacted player view and exact legal actions.
Do not infer hidden opponent information beyond the provided view.
Choose exactly one legal action by index.
Do not call tools.
Output JSON only, no markdown, no prose.
Required shape: {"choice":number,"confidence":number,"reason":"short tactical reason"}`;

export interface BuildPolicyRequestInput {
  state: ServerStateMessage;
  seat: string;
  roomId: string;
  strategyNotes?: string[] | undefined;
}

export interface PolicyRequest {
  system: string;
  user: string;
}

export function buildPolicyRequest(input: BuildPolicyRequestInput): PolicyRequest {
  return {
    system: GAMEPLAY_SYSTEM_PROMPT,
    user: JSON.stringify({
      objective: 'win the match',
      roomId: input.roomId,
      seat: input.seat,
      view: input.state.view,
      recentEvents: input.state.events ?? [],
      legalActions: indexLegalActions(input.state.legalActions),
      strategyNotes: input.strategyNotes ?? [],
    }),
  };
}
