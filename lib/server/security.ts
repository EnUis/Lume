import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DB } from './db';
import type { User } from '../types';

export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export const id = () => randomBytes(16).toString('hex');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let key: Buffer | undefined;
function encryptionKey() {
  if (key) return key;
  const value = process.env.SOURCE_ENCRYPTION_KEY;
  if (value) { key = Buffer.from(value, 'base64'); if (key.length !== 32) throw new Error('SOURCE_ENCRYPTION_KEY must encode exactly 32 random bytes'); return key; }
  if (process.env['NODE_ENV'] === 'production') throw new Error('SOURCE_ENCRYPTION_KEY is required in production');
  const directory = resolve(process.cwd(), 'data'); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, '.source-key');
  if (!existsSync(path)) { try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; } }
  key = readFileSync(path); if (key.length !== 32) throw new Error('Invalid development encryption key'); return key;
}
export function encrypt(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), bytes.toString('base64')].join('.'); }
export function decrypt(value: string) { const parts = value.split('.'); if (parts.length !== 3 || parts.some(part => Buffer.from(part, 'base64').toString('base64') !== part)) throw new Error('Invalid encrypted payload encoding'); const [iv, tag, data] = parts; if (Buffer.from(iv, 'base64').length !== 12 || Buffer.from(tag, 'base64').length !== 16) throw new Error('Invalid encrypted payload'); const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64')); cipher.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('utf8'); }
export function passwordHash(password: string) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`; }
export function verifyPassword(password: string, stored: unknown) {
  const validFormat = typeof stored === 'string' && /^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(stored);
  // Keep the same work for missing/malformed records without trusting their salt
  // or accepting Node's permissive partial hex decoding.
  const [salt, result] = validFormat ? stored.split(':') : ['0'.repeat(32), '0'.repeat(128)];
  const computed = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(computed, Buffer.from(result, 'hex')) && validFormat;
}
export function sanitizeError(error: unknown) { const message = error instanceof Error ? error.message : String(error); return message.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted source]').replace(/(password|token|key|authorization)=?[^\s&]+/gi, '$1=[redacted]').slice(0, 300); }
export function sameOrigin(request: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  if (process.env['NODE_ENV'] === 'production' && !process.env.APP_ORIGIN) throw new AppError(503, 'Application origin is not configured');
  const requestUrl = new URL(request.url);
  let expected = process.env.APP_ORIGIN || requestUrl.origin;
  // Next's development adapter can rewrite Request.url to localhost even when
  // the browser used 127.0.0.1. Host represents the actual HTTP request origin.
  // Forwarded host/protocol headers do not influence this fallback.
  if (!process.env.APP_ORIGIN && process.env['NODE_ENV'] !== 'production') {
    const host = request.headers.get('host');
    if (host) {
      if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.test(host)) throw new AppError(403, 'Invalid request host');
      try { expected = new URL(`${requestUrl.protocol}//${host}`).origin; } catch { throw new AppError(403, 'Invalid request host'); }
    }
  }
  if (!origin || origin !== expected || request.headers.get('sec-fetch-site') === 'cross-site') throw new AppError(403, 'Request must come from this application');
  if (!request.headers.get('content-type')?.startsWith('application/json') && request.method !== 'DELETE') throw new AppError(415, 'JSON body required');
}
export async function rateLimit(db: DB, bucket: string, limit: number, windowMs: number) {
  const now = Date.now();
  // An atomic upsert prevents concurrent PostgreSQL requests from resetting or
  // bypassing the counter on an initially empty bucket.
  const current = await db.get('INSERT INTO rate_limits(bucket,count,reset_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN rate_limits.reset_at<=? THEN 1 ELSE rate_limits.count+1 END,reset_at=CASE WHEN rate_limits.reset_at<=? THEN excluded.reset_at ELSE rate_limits.reset_at END RETURNING count', [bucket, now + windowMs, now, now]);
  if (Number(current!.count) > limit) throw new AppError(429, 'Too many requests. Please try again later.');
}
export async function currentUser(db: DB, request: Request): Promise<User | null> {
  const cookie = request.headers.get('cookie')?.match(/(?:^|;\s*)luma_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!cookie) return null;
  const row = await db.get('SELECT u.id,u.name,u.email,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=? AND s.expires_at>?', [hash(cookie), Date.now()]);
  return row ? { id: row.id, email: row.email, name: row.name, role: row.role } : null;
}
export function requireUser(user: User | null, roles?: User['role'][]) { if (!user) throw new AppError(401, 'Please sign in'); if (roles && !roles.includes(user.role)) throw new AppError(403, 'You do not have permission'); return user; }
export async function session(db: DB, userId: string) { const token = randomBytes(32).toString('hex'); const now = Date.now(); await db.run('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)', [hash(token), userId, now + 30 * 86400000, now]); return `luma_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env['NODE_ENV'] === 'production' ? '; Secure' : ''}`; }
export function clearCookie() { return `luma_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env['NODE_ENV'] === 'production' ? '; Secure' : ''}`; }
export async function audit(db: DB, actorId: string, action: string, entityId: string, details: Record<string, unknown> = {}) { await db.run('INSERT INTO audit_log(id,actor_id,action,entity_id,details,created_at) VALUES(?,?,?,?,?,?)', [id(), actorId, action, entityId, JSON.stringify(details), Date.now()]); }
