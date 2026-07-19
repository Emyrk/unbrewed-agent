import type { Action } from './protocol.js';

export type IndexedAction = Action & {
  index: number;
};

export interface ValidatedChoice {
  action: Action;
  source: 'model' | 'fallback';
  reason: string;
  confidence: number | null;
  error?: string;
}

interface ModelChoice {
  choice: number;
  reason?: unknown;
  confidence?: unknown;
}

export function summarizeAction(action: Action): string {
  const { type, ...rest } = action;
  return `${type} ${JSON.stringify(rest)}`;
}

export function indexLegalActions(actions: Action[]): IndexedAction[] {
  // Keep each legal action exactly once. The previous nested action + summary shape
  // serialized every action twice, which became especially expensive for movement
  // effects with a large branching factor.
  return actions.map((action, index) => ({ ...action, index }));
}

export function chooseValidatedAction(rawModelOutput: string, legalActions: Action[]): ValidatedChoice {
  const fallback = fallbackAction(legalActions);
  if (!fallback) throw new Error('No legal actions available');

  try {
    const parsed = parseModelChoice(rawModelOutput);
    if (!Number.isInteger(parsed.choice)) throw new Error('choice must be an integer');
    if (parsed.choice < 0 || parsed.choice >= legalActions.length) {
      throw new Error(`choice ${parsed.choice} out of range 0..${legalActions.length - 1}`);
    }
    return {
      action: legalActions[parsed.choice]!,
      source: 'model',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    };
  } catch (err) {
    return {
      action: fallback,
      source: 'fallback',
      reason: 'Fallback selected first non-forfeit legal action.',
      confidence: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function parseModelChoice(raw: string): ModelChoice {
  const json = extractFirstJsonObject(raw);
  const parsed = JSON.parse(json) as Partial<ModelChoice>;
  if (typeof parsed.choice !== 'number') throw new Error('choice must be a number');
  return parsed as ModelChoice;
}

function fallbackAction(actions: Action[]): Action | null {
  return actions.find((action) => action.type !== 'FORFEIT') ?? actions[0] ?? null;
}

function extractFirstJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in model output');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const char = raw[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  throw new Error('No complete JSON object found in model output');
}
