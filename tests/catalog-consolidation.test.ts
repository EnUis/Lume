import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../lib/server/db';
import { createTitle } from '../lib/server/pipeline';
import { previewCatalogConsolidation, applyCatalogConsolidation } from '../lib/server/catalog-consolidation';
import { encrypt, hash, id } from '../lib/server/security';
import { resolveTitleId } from '../lib/server/catalog';

let db: DB;
beforeEach(async () => { db = await openDatabase(':memory:'); });
afterEach(async () => { await db.close(); });
async function movie(name: string, year: number | null, language: string | null = null) {
  const titleId = await createTitle(db, { name, year }), sourceId = id();
  const url = `https://video.example.test/${sourceId}.mp4`;
  await db.run('INSERT INTO sources(id,title_id,entry_key,name,original_name,language,url_encrypted,url_hash,created_at) VALUES(?,?,?,?,?,?,?,?,1)', [sourceId,titleId,sourceId,'Fixture',name,language,encrypt(url),hash(url)]);
  return { titleId, sourceId };
}
it('plans dated and distinct language copies, keeping remakes, ambiguous songs and same-language copies separate', async () => {
  await movie('The Film',2020); await movie('The Film',2020); await movie('The Film',2025);
  await movie('Undated Film',null,'en'); await movie('Undated Film',null,'de');
  await movie('Uncertain Film',null,'en'); await movie('Uncertain Film',null,'en');
  await movie('Zucchero - Occhi',null); await movie('Zucchero - Diamante',null);
  const plan = await previewCatalogConsolidation(db);
  expect(plan.mergeCount).toBe(2); expect(plan.uncertainGroups).toBe(1);
  expect(new Set(plan.groups.map(group=>group.reason))).toEqual(new Set(['same-release','language-versions']));
  expect((await db.get('SELECT COUNT(*) n FROM titles'))?.n).toBe(9);
});
it('preserves source blocks and user progress, and redirects old cards to one title', async () => {
  const first = await movie('The Film',2020,'en'), second = await movie('The Film',2020,'de');
  const user = id();
  await db.run("UPDATE sources SET playback_blocked=1,health='unavailable' WHERE id=?",[second.sourceId]);
  await db.run('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,1)',[user,'viewer@example.test','Viewer','fixture']);
  await db.run('INSERT INTO playback_progress(user_id,title_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,1)',[user,second.titleId,second.titleId,42,100]);
  const plan = await previewCatalogConsolidation(db);
  expect(await applyCatalogConsolidation(db,plan)).toEqual({merged:1,skippedGroups:0});
  const surviving = await resolveTitleId(db,second.titleId);
  expect(await resolveTitleId(db,first.titleId)).toBe(surviving);
  expect((await db.get('SELECT COUNT(*) n FROM sources'))?.n).toBe(2);
  expect(await db.get('SELECT playback_blocked,health FROM sources WHERE id=?',[second.sourceId])).toEqual({playback_blocked:1,health:'unavailable'});
  expect(await db.get('SELECT title_id,position FROM playback_progress WHERE user_id=?',[user])).toEqual({title_id:surviving,position:42});
});
it('declines external conflicts and skips identities edited after preview', async () => {
  const first = await movie('Conflicting Film',2020), second = await movie('Conflicting Film',2020);
  for(const [titleId,external] of [[first.titleId,'tt1'],[second.titleId,'tt2']]) await db.run('INSERT INTO metadata_identifiers(id,title_id,provider,external_id) VALUES(?,?,?,?)',[id(),titleId,'imdb',external]);
  const one = await movie('Editable Film',2020), two = await movie('Editable Film',2020);
  const plan = await previewCatalogConsolidation(db); expect(plan.mergeCount).toBe(1);
  await db.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,1)',[two.titleId]);
  expect(await applyCatalogConsolidation(db,plan)).toEqual({merged:0,skippedGroups:1});
  expect(await resolveTitleId(db,one.titleId)).toBe(one.titleId);
});

it('keeps different remakes separate when source labels contain years missing from saved titles', async () => {
  const earlier = await movie('Shared Title',null,'en'), later = await movie('Shared Title',null,'de');
  await db.run('UPDATE sources SET original_name=? WHERE id=?',['Shared Title (1977)',earlier.sourceId]);
  await db.run('UPDATE sources SET original_name=? WHERE id=?',['Shared Title (1990)',later.sourceId]);
  expect(await previewCatalogConsolidation(db)).toMatchObject({mergeCount:0,uncertainGroups:1});
});
