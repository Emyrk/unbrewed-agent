import { indexLegalActions } from './actions.js';
import type { Json, ServerStateMessage } from './protocol.js';

export const GAMEPLAY_SYSTEM_PROMPT = `You are playing Unmatched, a competitive asymmetric card-driven miniatures duel, through the Unbrewed Pro rules engine. The engine supplies a redacted player view and the exact legal actions available now. The engine is authoritative about legality and resolution.

OBJECTIVE
Defeat the opposing hero by reducing its health to 0. Defeating a sidekick does not normally end the game. Victory is checked at action boundaries. Never assume hidden opponent information.

TURN STRUCTURE
A normal turn has exactly 2 actions; actions cannot be skipped, and the same action may be taken twice:
- MANEUVER: Draw 1 card, then optionally move fighters through adjacent spaces up to their move value. Fighters may pass through friendly fighters, not opponents, and must end in empty spaces. Movement may be boosted by discarding a card and adding its BOOST value.
- SCHEME: Play an eligible scheme card face-up, resolve it, then discard it.
- ATTACK: Choose an eligible attacker, target, and attack card. The defender may play a defense card. Cards reveal and combat resolves.

COMBAT ORDER
1. IMMEDIATELY effects
2. DURING COMBAT effects
3. Combat damage: attack value minus defense value, minimum 0
4. AFTER COMBAT effects
5. Cleanup
6. Any additional "after attacking" effects
The defender never deals combat damage merely by having higher defense. If effects share a timing window, the defender resolves first. Played effects may still resolve when their fighter is defeated during combat. The attacker wins combat only if at least 1 combat damage was dealt; otherwise the defender wins. Effect damage does not determine the combat winner.

MAP AND TARGETING
Connected spaces are adjacent. Same-colored spaces share a zone, including separated spaces; multicolored spaces belong to every shown zone. Melee attacks target adjacent fighters regardless of zone. Ranged attacks target fighters anywhere in the same zone. Ranged fighters may also make melee attacks.

CARDS AND FIGHTERS
A card's banner restricts which fighter may play it; ANY cards may be used by any eligible fighter. Versatile cards may attack or defend. Effects are mandatory unless they say "may". Resolve as much as possible when part cannot resolve. Cards belonging only to defeated fighters generally cannot be played but may still be discarded to boost movement.

HAND AND EXHAUSTION
The end-of-turn hand limit is 7. The deck is finite and is not reshuffled. If a required card cannot be drawn, each surviving friendly fighter takes 2 damage per missing card. Avoid unnecessary draws near exhaustion unless tactically justified.

DECISION GUIDANCE
- Evaluate health, position, zones, hand size, deck size, visible discard piles, action economy, and exhaustion risk.
- Preserve useful defense cards when exposed; avoid wasting cards or movement without tactical value.
- Consider retaliation and positioning after an attack, not only immediate damage.
- Use sidekicks for pressure, positioning, and protection while accounting for fighter-specific cards becoming unusable after defeat.
- Treat matchupContext only as a compact summary of public or player-visible information. The full redacted view remains the source of truth.
- Do not invent card text, board connections, rules, or legal actions.
- Do not infer the opponent's hand or other hidden state.

RESPONSE CONTRACT
Choose exactly one legal action by index. Do not call tools. Output JSON only, no markdown or prose.
Required shape: {"choice":number,"confidence":number,"reason":"short tactical reason"}`;

export interface BuildPolicyRequestInput {
  state: ServerStateMessage;
  seat: string;
  roomId: string;
  ownHeroId?: string | undefined;
  strategyNotes?: string[] | undefined;
}

export interface PolicyRequest {
  system: string;
  user: string;
}

interface VisibleFact {
  path: string;
  value: Json;
}

const CONTEXT_KEY = /(self|player|opponent|hero|character|roster|fighter|combatant|sidekick|ability|health|position|space|zone|move|attackstyle|deck|hand|discard|card|boost)/i;
const SENSITIVE_KEY = /(hidden|secret|private|rawstate|serverstate|opponenthand)/i;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_CONTEXT_DEPTH = 6;
const MAX_STRING_CHARS = 600;

function compactValue(value: Json): Json {
  if (typeof value === 'string' && value.length > MAX_STRING_CHARS) {
    return `${value.slice(0, MAX_STRING_CHARS)}…`;
  }
  return value;
}

export function buildVisibleMatchupContext(
  view: Json,
  ownHeroId?: string | undefined,
): { ownHeroId: string | null; visibleFacts: VisibleFact[]; note: string } {
  const visibleFacts: VisibleFact[] = [];
  let usedChars = 0;

  function visit(value: Json, path: string[], depth: number, relevantParent: boolean): void {
    if (depth > MAX_CONTEXT_DEPTH || usedChars >= MAX_CONTEXT_CHARS) return;
    const currentPath = path.join('.');
    if (SENSITIVE_KEY.test(currentPath)) return;

    if (value === null || typeof value !== 'object') {
      const relevant = relevantParent || path.some((part) => CONTEXT_KEY.test(part));
      if (!relevant) return;
      const fact: VisibleFact = { path: currentPath, value: compactValue(value) };
      const size = JSON.stringify(fact).length;
      if (usedChars + size > MAX_CONTEXT_CHARS) return;
      visibleFacts.push(fact);
      usedChars += size;
      return;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        visit(value[i]!, [...path, String(i)], depth + 1, relevantParent);
        if (usedChars >= MAX_CONTEXT_CHARS) break;
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue;
      visit(child, [...path, key], depth + 1, relevantParent || CONTEXT_KEY.test(key));
      if (usedChars >= MAX_CONTEXT_CHARS) break;
    }
  }

  visit(view, [], 0, false);
  return {
    ownHeroId: ownHeroId ?? null,
    visibleFacts,
    note: 'Convenience summary extracted only from the redacted player view. It may include your private hand and public/revealed opponent information, but never authorizes assumptions about hidden opponent cards.',
  };
}

export function buildPolicyRequest(input: BuildPolicyRequestInput): PolicyRequest {
  return {
    system: GAMEPLAY_SYSTEM_PROMPT,
    user: JSON.stringify({
      objective: 'win the match',
      roomId: input.roomId,
      seat: input.seat,
      matchupContext: buildVisibleMatchupContext(input.state.view, input.ownHeroId),
      view: input.state.view,
      recentEvents: input.state.events ?? [],
      legalActions: indexLegalActions(input.state.legalActions),
      strategyNotes: input.strategyNotes ?? [],
    }),
  };
}
