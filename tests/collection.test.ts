import {afterEach,describe,it,expect} from 'vitest';
import {openDatabase,type DB} from '../lib/server/db';
import {publicCollection} from '../lib/server/collection';
import {encrypt} from '../lib/server/security';
let db:DB;
afterEach(async()=>{if(db)await db.close()});
describe('saved title metadata outside the discovery page',()=>{
 it('returns requested old title IDs as alternate IDs on their single canonical record',async()=>{
  db=await openDatabase(':memory:');
  await db.run("INSERT INTO titles(id,name,normalized,type,published,created_at,updated_at) VALUES('canonical','A Film','a film','movie',1,1,1)");
  await db.run("INSERT INTO sources(id,title_id,entry_key,name,url_encrypted,url_hash,health,created_at) VALUES('source','canonical','source','Sample',?,'url','healthy',1)",[encrypt('https://example.com/sample.mp4')]);
  await db.run("INSERT INTO title_redirects(alias_id,title_id,created_at) VALUES('old-film','canonical',1),('old-translation','canonical',1),('unused-alias','canonical',1)");
  const titles=await publicCollection(db,['old-film','canonical','old-translation','old-film']);
  expect(titles).toHaveLength(1);expect(titles[0]).toMatchObject({id:'canonical',alternateIds:['old-film','old-translation']});
  expect((await publicCollection(db,['canonical']))[0].alternateIds).toBeUndefined();
 });
 it('preserves requested order but excludes hidden and unverified titles',async()=>{db=await openDatabase(':memory:');for(const [id,published,health]of [['old',1,'healthy'],['hidden',0,'healthy'],['unknown',1,'unknown'],['recent',1,'healthy']]as const){await db.run('INSERT INTO titles(id,name,normalized,type,published,created_at,updated_at) VALUES(?,?,?,\'movie\',?,?,?)',[id,id,id,published,1,1]);await db.run('INSERT INTO sources(id,title_id,entry_key,name,url_encrypted,url_hash,health,created_at) VALUES(?,?,?,?,?,?,?,?)',[`${id}s`,id,id,'Public sample',encrypt('https://example.com/sample.mp4'),id,health,1]);}expect((await publicCollection(db,['recent','old','hidden','unknown','old'])).map(t=>t.id)).toEqual(['recent','old']);});
 it('rejects unbounded or invalid identifiers before querying',async()=>{db=await openDatabase(':memory:');await expect(publicCollection(db,Array.from({length:101},(_,i)=>String(i)))).rejects.toThrow('100');await expect(publicCollection(db,['../private'])).rejects.toThrow('valid');});
});
