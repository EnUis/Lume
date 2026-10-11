import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { handleApi } from '../lib/server/api';
import { encrypt, decrypt, hash } from '../lib/server/security';
import { enqueue, leaseJob } from '../lib/server/jobs';
let db: DB;
const token = 'a'.repeat(64);
const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
const call = (route: string, method: string, data?: unknown) => handleApi(new Request(origin + '/api/admin/playlists/fixture' + route, { method, headers: { origin, 'content-type': 'application/json', cookie: 'luma_session=' + token }, ...(data ? { body: JSON.stringify(data) } : {}) }), db);
beforeEach(async () => {
  db = await openDatabase(':memory:');
  await db.run('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', ['admin','fixture@example.test','Fixture','unused','admin',Date.now()]);
  await db.run('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)', [hash(token),'admin',Date.now()+3600000,Date.now()]);
  await db.run("INSERT INTO playlists(id,name,url_encrypted,health,error,created_at) VALUES(?,?,?,'unavailable','Playlist HTTP 404',?)", ['fixture','Fixture',encrypt('https://example.test/old.m3u'),Date.now()]);
});
afterEach(async () => { await db.close(); });
it('Retry now advances an already queued delayed refresh instead of silently waiting an hour', async () => {
  const id=await enqueue(db,'sync',{playlistId:'fixture'},{dedupeKey:'sync:fixture',runAfter:Date.now()+3600000});
  await db.run("UPDATE jobs SET attempts=1,error='Playlist HTTP 404' WHERE id=?",[id]);
  const response=await call('/sync','POST');expect(response.status).toBe(200);expect((await response.json()).jobId).toBe(id);
  const job=(await db.get('SELECT * FROM jobs WHERE id=?',[id]))!;expect(Number(job.run_after)).toBeLessThanOrEqual(Date.now());expect(job.error).toBe('Playlist HTTP 404');
});
it('a replacement link clears the old refresh error and queues verification immediately', async () => {
  const id=await enqueue(db,'sync',{playlistId:'fixture'},{dedupeKey:'sync:fixture',runAfter:Date.now()+3600000});
  await db.run("UPDATE jobs SET attempts=2,error='Playlist HTTP 404' WHERE id=?",[id]);
  const response=await call('','PATCH',{url:'http://localhost:8088/new.m3u',authorized:true});expect(response.status).toBe(200);expect((await response.json()).jobId).toBe(id);
  const playlist=(await db.get('SELECT * FROM playlists WHERE id=?',['fixture']))!;expect(decrypt(playlist.url_encrypted)).toBe('http://localhost:8088/new.m3u');expect(playlist.error).toBeNull();expect(playlist.health).toBe('unknown');
  expect(await db.get('SELECT attempts,error FROM jobs WHERE id=?',[id])).toMatchObject({attempts:0,error:null});
  expect(Number((await db.get('SELECT run_after FROM jobs WHERE id=?',[id]))!.run_after)).toBeLessThanOrEqual(Date.now());
});
it('replacing a link during an old request queues a follow-up without stealing its running lease', async () => {
  const id=await enqueue(db,'sync',{playlistId:'fixture'},{dedupeKey:'sync:fixture'});await leaseJob(db,'old-worker',['sync']);
  const response=await call('','PATCH',{url:'https://example.test/new.m3u',authorized:true});expect(response.status).toBe(200);const result=await response.json();expect(result.jobId).not.toBe(id);
  expect(await db.get('SELECT status,lease_owner FROM jobs WHERE id=?',[id])).toMatchObject({status:'running',lease_owner:'old-worker'});
  expect(await db.get('SELECT status,payload FROM jobs WHERE id=?',[result.jobId])).toMatchObject({status:'queued',payload:JSON.stringify({playlistId:'fixture'})});
});
