import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { query } from './db.js';

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'ub_session';

export function getDiscordConfig() {
  return {
    clientId: process.env.DISCORD_CLIENT_ID!,
    clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    redirectUri: process.env.DISCORD_REDIRECT_URI || `${(process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '')}/auth/callback`,
  };
}

export function getDiscordAuthUrl(): string {
  const { clientId, redirectUri } = getDiscordConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
  });
  return `${DISCORD_API}/oauth2/authorize?${params}`;
}

export async function exchangeCode(code: string): Promise<{
  id: string;
  username: string;
  avatar: string | null;
  discriminator: string;
}> {
  const { clientId, clientSecret, redirectUri } = getDiscordConfig();
  // Exchange code for token
  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Discord token exchange failed: ${tokenRes.status} ${text.slice(0, 300)}`);
  }
  const tokenData = (await tokenRes.json()) as { access_token: string };

  // Fetch user info
  const userRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) throw new Error(`Discord user fetch failed: ${userRes.status}`);
  return (await userRes.json()) as { id: string; username: string; avatar: string | null; discriminator: string };
}

export async function createOrUpdateUser(discordUser: {
  id: string;
  username: string;
  avatar: string | null;
}): Promise<string> {
  const avatarUrl = discordUser.avatar
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
    : null;

  const existing = await query<{ id: string }>(
    'SELECT id FROM users WHERE discord_id = $1',
    [discordUser.id],
  );

  if (existing.rows.length > 0) {
    const userId = existing.rows[0]!.id;
    await query('UPDATE users SET username = $1, avatar_url = $2 WHERE id = $3', [
      discordUser.username,
      avatarUrl,
      userId,
    ]);
    return userId;
  }

  const userId = randomUUID();
  await query(
    'INSERT INTO users (id, discord_id, username, avatar_url) VALUES ($1, $2, $3, $4)',
    [userId, discordUser.id, discordUser.username, avatarUrl],
  );
  return userId;
}

export async function createSession(userId: string): Promise<string> {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
  await query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [
    sessionId,
    userId,
    expiresAt,
  ]);
  return sessionId;
}

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS / 1000,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}

export interface AuthUser {
  id: string;
  username: string;
  avatar_url: string | null;
}

export async function getSessionUser(c: Context): Promise<AuthUser | null> {
  const sessionId = getCookie(c, COOKIE_NAME);
  if (!sessionId) return null;

  const result = await query<{ id: string; username: string; avatar_url: string | null }>(
    `SELECT u.id, u.username, u.avatar_url
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function requireUser(c: Context): Promise<AuthUser> {
  const user = await getSessionUser(c);
  if (!user) {
    throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return user;
}
