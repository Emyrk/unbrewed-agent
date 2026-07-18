import { homedir } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PolicyClient } from './hermes.js';

const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const REFRESH_SKEW_SECONDS = 120;

interface CodexPoolEntry {
  access_token?: unknown;
  refresh_token?: unknown;
  base_url?: unknown;
  last_error_reset_at?: unknown;
  [key: string]: unknown;
}

interface HermesAuthStore {
  providers?: {
    'openai-codex'?: {
      tokens?: CodexPoolEntry;
      last_refresh?: unknown;
      [key: string]: unknown;
    };
  };
  credential_pool?: {
    'openai-codex'?: CodexPoolEntry[];
  };
  [key: string]: unknown;
}

export interface CodexDirectClientOptions {
  authPath?: string | undefined;
  model: string;
  timeoutMs: number;
  reasoningEffort: 'low' | 'medium' | 'high';
}

interface RuntimeCredential {
  accessToken: string;
  refreshToken: string;
  baseUrl: string;
  source: 'provider' | 'pool';
  poolIndex?: number;
}

export class CodexDirectClient implements PolicyClient {
  constructor(private readonly options: CodexDirectClientOptions) {}

  async complete(system: string, user: string): Promise<string> {
    const authPath = resolveAuthPath(this.options.authPath);
    const { store, credential } = await resolveCredential(authPath);
    let accessToken = credential.accessToken;
    if (isJwtExpiring(accessToken, REFRESH_SKEW_SECONDS)) {
      const refreshed = await refreshCodexTokens(credential.refreshToken, this.options.timeoutMs);
      accessToken = refreshed.accessToken;
      credential.refreshToken = refreshed.refreshToken;
      credential.accessToken = accessToken;
      writeCredential(store, credential);
      await writeFile(authPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    }

    return await postResponsesStream({
      baseUrl: credential.baseUrl,
      accessToken,
      model: this.options.model,
      timeoutMs: this.options.timeoutMs,
      reasoningEffort: this.options.reasoningEffort,
      system,
      user,
    });
  }
}

function resolveAuthPath(path: string | undefined): string {
  if (path?.trim()) return expandHome(path.trim());
  const hermesHome = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes');
  return join(hermesHome, 'auth.json');
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

async function resolveCredential(authPath: string): Promise<{ store: HermesAuthStore; credential: RuntimeCredential }> {
  let store: HermesAuthStore;
  try {
    store = JSON.parse(await readFile(authPath, 'utf8')) as HermesAuthStore;
  } catch (error) {
    throw new Error(`Could not read Hermes auth store at ${authPath}: ${errorMessage(error)}`);
  }

  const providerTokens = store.providers?.['openai-codex']?.tokens;
  if (providerTokens) {
    const credential = credentialFromEntry(providerTokens, 'provider');
    if (credential) return { store, credential };
  }

  const pool = store.credential_pool?.['openai-codex'];
  if (Array.isArray(pool)) {
    const now = Date.now() / 1000;
    for (let i = 0; i < pool.length; i++) {
      const entry = pool[i];
      if (!entry) continue;
      const resetAt = typeof entry.last_error_reset_at === 'number' ? entry.last_error_reset_at : 0;
      if (resetAt > now) continue;
      const credential = credentialFromEntry(entry, 'pool', i);
      if (credential) return { store, credential };
    }
  }

  throw new Error(`No usable openai-codex credential found in ${authPath}. Run hermes auth add openai-codex.`);
}

function credentialFromEntry(entry: CodexPoolEntry, source: 'provider' | 'pool', poolIndex?: number): RuntimeCredential | undefined {
  const accessToken = typeof entry.access_token === 'string' ? entry.access_token.trim() : '';
  const refreshToken = typeof entry.refresh_token === 'string' ? entry.refresh_token.trim() : '';
  if (!accessToken || !refreshToken) return undefined;
  const baseUrl = typeof entry.base_url === 'string' && entry.base_url.trim()
    ? entry.base_url.trim().replace(/\/$/, '')
    : DEFAULT_CODEX_BASE_URL;
  return poolIndex === undefined
    ? { accessToken, refreshToken, baseUrl, source }
    : { accessToken, refreshToken, baseUrl, source, poolIndex };
}

function writeCredential(store: HermesAuthStore, credential: RuntimeCredential): void {
  const updated = {
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    last_refresh: new Date().toISOString(),
  };
  if (credential.source === 'provider') {
    store.providers ??= {};
    store.providers['openai-codex'] ??= {};
    store.providers['openai-codex'].tokens = {
      ...(store.providers['openai-codex'].tokens ?? {}),
      ...updated,
    };
    store.providers['openai-codex'].last_refresh = updated.last_refresh;
    return;
  }
  const pool = store.credential_pool?.['openai-codex'];
  if (!Array.isArray(pool) || credential.poolIndex === undefined) return;
  const entry = pool[credential.poolIndex];
  if (!entry) return;
  Object.assign(entry, updated, {
    last_status: null,
    last_status_at: null,
    last_error_code: null,
    last_error_reason: null,
    last_error_message: null,
    last_error_reset_at: null,
  });
}

function isJwtExpiring(token: string, skewSeconds: number): boolean {
  const parts = token.split('.');
  if (parts.length < 2) return false;
  try {
    const payload = JSON.parse(Buffer.from(base64UrlToBase64(parts[1]!), 'base64').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && payload.exp - skewSeconds <= Date.now() / 1000;
  } catch {
    return false;
  }
}

function base64UrlToBase64(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return padded.padEnd(Math.ceil(padded.length / 4) * 4, '=');
}

async function refreshCodexTokens(refreshToken: string, timeoutMs: number): Promise<{ accessToken: string; refreshToken: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID,
    });
    const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Codex token refresh ${response.status}: ${redactLarge(text)}`);
    const payload = JSON.parse(text) as { access_token?: unknown; refresh_token?: unknown };
    const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
    if (!accessToken) throw new Error('Codex token refresh response had no access_token');
    const nextRefresh = typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : refreshToken;
    return { accessToken, refreshToken: nextRefresh };
  } finally {
    clearTimeout(timeout);
  }
}

async function postResponsesStream(options: {
  baseUrl: string;
  accessToken: string;
  model: string;
  timeoutMs: number;
  reasoningEffort: 'low' | 'medium' | 'high';
  system: string;
  user: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        authorization: `Bearer ${options.accessToken}`,
      },
      body: JSON.stringify({
        model: options.model,
        instructions: options.system,
        input: [
          { role: 'user', content: [{ type: 'input_text', text: options.user }] },
        ],
        store: false,
        stream: true,
        reasoning: { effort: options.reasoningEffort, summary: 'auto' },
        include: [],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Codex Responses API ${response.status}: ${redactLarge(text)}`);
    }
    if (!response.body) throw new Error('Codex Responses API returned no stream body');
    return await readOutputTextFromSse(response.body);
  } finally {
    clearTimeout(timeout);
  }
}

async function readOutputTextFromSse(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  const dataLines: string[] = [];
  let output = '';

  function flushEvent(): void {
    if (!dataLines.length) {
      event = '';
      return;
    }
    const data = dataLines.join('\n');
    dataLines.length = 0;
    try {
      const payload = JSON.parse(data) as Record<string, unknown>;
      if (event === 'response.output_text.delta') {
        const delta = payload.delta;
        if (typeof delta === 'string') output += delta;
      } else if (event === 'response.output_text.done') {
        const text = payload.text;
        if (typeof text === 'string') output = text;
      } else if (event === 'response.completed') {
        // Some backend responses put only partial final data here. Prefer deltas.
      } else if (event === 'response.failed' || event === 'response.incomplete') {
        throw new Error(`Codex stream ${event}: ${redactLarge(data)}`);
      }
    } finally {
      event = '';
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) {
        flushEvent();
      } else if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
    if (done) break;
  }
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
      else if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    }
  }
  flushEvent();
  if (!output.trim()) throw new Error('Codex Responses stream produced no output text');
  return output.trim();
}

function redactLarge(text: string): string {
  return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/g, 'Bearer [REDACTED]').slice(0, 500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
