import { expect, it } from 'vitest';
import { openDatabase } from '../lib/server/db';
import { availableTitleSQL, catalogAvailabilitySQL, catalog } from '../lib/server/catalog';
import { discovery } from '../lib/server/discovery';
import { createTitle } from '../lib/server/pipeline';

it('builds availability from the indexed verified set instead of scanning sources for every title', async () => {
  const db = await openDatabase(':memory:');
  try {
    for (const available of [availableTitleSQL, catalogAvailabilitySQL]) {
      const plan = await db.all(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM titles t WHERE t.published=1 AND ${available}`);
      const sourceLookups = plan.filter(row => /SEARCH s USING/.test(row.detail));
      expect(sourceLookups.length).toBeGreaterThan(0);
      expect(sourceLookups.every(row => /USING COVERING INDEX (sources_verified_playback|sources_admin_playable)/.test(row.detail) && /health=\?/.test(row.detail) && /playback_blocked=\?/.test(row.detail))).toBe(true);
      expect(plan.some(row => /CORRELATED/.test(row.detail))).toBe(false);
    }
  } finally { await db.close(); }
});

it('keeps bulk catalog and recent discovery eligibility fresh when newer unverified titles dominate the catalog', async () => {
  const db = await openDatabase(':memory:');
  try {
    const available = await createTitle(db, { name: 'Available older film', year: 2020 });
    await db.run('UPDATE titles SET created_at=1 WHERE id=?', [available]);
    for (let offset = 0; offset < 1000; offset += 100) {
      const rows = Array.from({ length: 100 }, (_, index) => [`unverified-${offset + index}`, `New film ${offset + index}`, `new film ${offset + index}`, 100 + offset + index, 1]);
      await db.run(`INSERT INTO titles(id,name,normalized,type,created_at,updated_at) VALUES ${rows.map(() => "(?,?,?,'movie',?,?)").join(',')}`, rows.flat());
    }
    await db.run("INSERT INTO sources(id,title_id,entry_key,name,url_encrypted,url_hash,health,created_at) VALUES('working',?,'working','Provider','fixture','fixture','healthy',1)", [available]);
    await db.run("INSERT INTO sources(id,title_id,entry_key,name,url_encrypted,url_hash,health,created_at) VALUES('alternative',?,'alternative','Provider','fixture','other','healthy',1)", [available]);
    const point = await db.all(`SELECT t.id FROM titles t WHERE t.published=1 AND ${availableTitleSQL}`);
    const bulk = await db.all(`SELECT t.id FROM titles t WHERE t.published=1 AND ${catalogAvailabilitySQL}`);
    expect(point).toEqual([{ id: available }]); expect(bulk).toEqual(point);
    expect(await catalog(db, new URLSearchParams('type=movie&limit=12'))).toMatchObject({ total: 1, titles: [{ id: available }] });
    expect((await discovery(db)).recent.map(title => title.id)).toEqual([available]);
    await db.run("UPDATE sources SET playback_blocked=1 WHERE id='working'");
    expect((await catalog(db, new URLSearchParams())).total).toBe(1);
    await db.run("UPDATE sources SET health='unavailable' WHERE id='alternative'");
    expect((await catalog(db, new URLSearchParams())).total).toBe(0);
    expect((await discovery(db)).recent).toEqual([]);
    await db.run("UPDATE sources SET health='healthy' WHERE id='alternative'");
    expect((await catalog(db, new URLSearchParams())).total).toBe(1);
    expect((await discovery(db)).recent.map(title => title.id)).toEqual([available]);
    expect(await catalog(db, new URLSearchParams('availability=hidden'), true)).toMatchObject({ total: 1000 });
  } finally { await db.close(); }
});
