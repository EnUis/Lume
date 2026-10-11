import '../lib/server/env';
import { database } from '../lib/server/db';
import { id, passwordHash, sanitizeError } from '../lib/server/security';

async function main() {
  const args = process.argv.slice(2); const value = (name: string) => args[args.indexOf(name) + 1];
  const email = value('--email')?.trim().toLowerCase(); const name = value('--name') || 'Administrator'; const password = process.env.ADMIN_PASSWORD;
  if (!args.includes('--email') || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 12 || password.length > 128) throw new Error('Usage: ADMIN_PASSWORD environment variable (12–128 characters), create-admin --email admin@example.com --name Administrator');
  const db = await database(); const existing = await db.get('SELECT id FROM users WHERE email=?', [email]); const userId = existing?.id || id(); const now = Date.now();
  await db.transaction(async tx => {
    if (existing) { await tx.run("UPDATE users SET password_hash=?,role='admin',name=? WHERE id=?", [passwordHash(password), name, userId]); await tx.run('DELETE FROM sessions WHERE user_id=?', [userId]); }
    else { await tx.run("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,'admin',?)", [userId, email, name, passwordHash(password), now]); await tx.run('INSERT INTO profiles(id,user_id,name,created_at) VALUES(?,?,?,?)', [id(), userId, name, now]); }
  }); await db.close(); console.log(`Administrator account ready for ${email}. No default credentials are installed.`);
}
main().catch(error => { console.error(sanitizeError(error)); process.exitCode = 1; });
