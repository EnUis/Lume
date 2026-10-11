import type { DB, Row } from './db';
import { AppError, id } from './security';
import { createTitle } from './pipeline';
import { normalizeTitle } from './m3u';

/** Recheck automatic repairs against current administrator and identity decisions. */
export async function automaticMergeConflict(db: DB, from: Row, to: Row): Promise<string | null> {
  if (from.type !== to.type) return 'Content types conflict; keep identities separate';
  if (from.year != null && to.year != null && Number(from.year) !== Number(to.year)) return 'Release years conflict; keep remakes separate';
  if (await db.get('SELECT title_id FROM title_metadata_locks WHERE title_id IN (?,?) LIMIT 1', [from.id, to.id])) return 'Administrator metadata locks protect these identities; confirm any merge manually';
  const identities = await db.all('SELECT provider,external_id FROM metadata_identifiers WHERE title_id IN (?,?)', [from.id, to.id]);
  const providers = new Map<string, Set<string>>();
  for (const identity of identities) { const values = providers.get(identity.provider) || new Set<string>(); values.add(identity.external_id); providers.set(identity.provider, values); }
  if ([...providers.values()].some(values => values.size > 1)) return 'External identities conflict; confirm the correct work';
  if (from.type === 'series') {
    const coordinates = await db.all('SELECT season,number FROM episodes WHERE title_id IN (?,?)', [from.id, to.id]);
    if (coordinates.some(row => !Number.isInteger(Number(row.season)) || Number(row.season) < 0 || Number(row.season) > 99 || !Number.isInteger(Number(row.number)) || Number(row.number) < 1 || Number(row.number) > 999)) return 'Episode coordinates conflict; confirm the series structure';
    const overlaps = await db.all('SELECT a.intro_start AS a_intro_start,a.intro_end AS a_intro_end,a.recap_start AS a_recap_start,a.recap_end AS a_recap_end,b.intro_start AS b_intro_start,b.intro_end AS b_intro_end,b.recap_start AS b_recap_start,b.recap_end AS b_recap_end FROM episodes a JOIN episodes b ON b.season=a.season AND b.number=a.number WHERE a.title_id=? AND b.title_id=?', [from.id, to.id]);
    if (overlaps.some(row => ['intro_start', 'intro_end', 'recap_start', 'recap_end'].some(field => row[`a_${field}`] != null && row[`b_${field}`] != null && Number(row[`a_${field}`]) !== Number(row[`b_${field}`])))) return 'Episode chapter markers conflict; confirm compatible versions';
  }
  return null;
}
export async function mergeTitles(db: DB, fromId: string, toId: string, options: { automatic?: boolean } = {}) {
  if (fromId === toId) throw new AppError(400, 'Select two different titles');
  await db.transaction(async tx => {
    const titles = await tx.all('SELECT * FROM titles WHERE id IN (?,?) ORDER BY id' + (tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), [fromId, toId]);
    const from = titles.find(row => row.id === fromId), to = titles.find(row => row.id === toId);
    if (!from || !to) throw new AppError(404, 'Title not found'); if (from.type !== to.type) throw new AppError(400, 'Only titles of the same content type can be merged');
    if (options.automatic) { const conflict = await automaticMergeConflict(tx, from, to); if (conflict) throw new AppError(409, conflict); }
    if (!(await tx.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [toId]))) {
      const fields: Row = {};
      for (const field of ['synopsis', 'poster', 'backdrop', 'trailer', 'director', 'age_rating', 'attribution']) if (!to[field] && from[field]) fields[field] = from[field];
      for (const field of ['genres', 'cast_members']) if ((!to[field] || to[field] === '[]') && from[field] && from[field] !== '[]') fields[field] = from[field];
      if (to.year == null && from.year != null) fields.year = from.year;
      if (Object.keys(fields).length) await tx.run(`UPDATE titles SET ${Object.keys(fields).map(field => `${field}=?`).join(',')},updated_at=? WHERE id=?`, [...Object.values(fields), Date.now(), toId]);
    }
    const episodeMap = new Map<string, string>();
    const episodes = await tx.all('SELECT * FROM episodes WHERE title_id=? ORDER BY season,number', [fromId]);
    // A series may contain thousands of episodes. Read the destination once,
    // then remap references in bounded batches instead of querying each episode.
    const targetSeasons = new Map<number, string>();
    const targetEpisodes = new Map<string, Row>();
    if (episodes.length) {
      for (const season of await tx.all('SELECT id,number FROM seasons WHERE title_id=?', [toId])) targetSeasons.set(Number(season.number), season.id);
      for (const episode of await tx.all('SELECT * FROM episodes WHERE title_id=?', [toId])) targetEpisodes.set(`${Number(episode.season)}:${Number(episode.number)}`, episode);
    }
    const remappedEpisodes: Array<[string, string]> = [];
    const movedEpisodes = new Map<string, string[]>();
    for (const episode of episodes) {
      let targetSeasonId = targetSeasons.get(Number(episode.season));
      if (!targetSeasonId) { targetSeasonId = id(); await tx.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,?)', [targetSeasonId, toId, episode.season]); targetSeasons.set(Number(episode.season), targetSeasonId); }
      const coordinate = `${Number(episode.season)}:${Number(episode.number)}`;
      const targetEpisode = targetEpisodes.get(coordinate);
      if (targetEpisode) {
        const fields: Row = {};
        for (const field of ['duration', 'intro_start', 'intro_end', 'recap_start', 'recap_end']) if (targetEpisode[field] == null && episode[field] != null) fields[field] = episode[field];
        if ((!targetEpisode.name || /^Episode\s+\d+$/i.test(targetEpisode.name)) && episode.name && !/^Episode\s+\d+$/i.test(episode.name)) fields.name = episode.name;
        if (Object.keys(fields).length) await tx.run(`UPDATE episodes SET ${Object.keys(fields).map(field => `${field}=?`).join(',')} WHERE id=?`, [...Object.values(fields), targetEpisode.id]);
        episodeMap.set(episode.id, targetEpisode.id); remappedEpisodes.push([episode.id, targetEpisode.id]);
      }
      else {
        episodeMap.set(episode.id, episode.id);
        const moves = movedEpisodes.get(targetSeasonId) || []; moves.push(episode.id); movedEpisodes.set(targetSeasonId, moves);
        targetEpisodes.set(coordinate, { ...episode, title_id: toId, season_id: targetSeasonId });
      }
    }
    const redirectedAt = Date.now();
    for (let offset = 0; offset < remappedEpisodes.length; offset += 250) {
      const mappings = remappedEpisodes.slice(offset, offset + 250);
      const mappingSql = `WITH mappings(old_id,new_id) AS (VALUES ${mappings.map(() => '(?,?)').join(',')})`;
      const values = mappings.flat();
      for (const table of ['sources', 'episode_redirects']) await tx.run(`${mappingSql} UPDATE ${table} SET episode_id=(SELECT new_id FROM mappings WHERE old_id=${table}.episode_id) WHERE episode_id IN (SELECT old_id FROM mappings)`, values);
      await tx.run(`INSERT INTO episode_redirects(alias_id,episode_id,created_at) VALUES ${mappings.map(() => '(?,?,?)').join(',')} ON CONFLICT(alias_id) DO UPDATE SET episode_id=excluded.episode_id`, mappings.flatMap(([oldId, newId]) => [oldId, newId, redirectedAt]));
    }
    for (const [seasonId, moves] of movedEpisodes) {
      for (let offset = 0; offset < moves.length; offset += 250) {
        const batch = moves.slice(offset, offset + 250);
        await tx.run(`UPDATE episodes SET title_id=?,season_id=? WHERE id IN (${batch.map(() => '?').join(',')})`, [toId, seasonId, ...batch]);
      }
    }
    await tx.run('UPDATE sources SET title_id=? WHERE title_id=?', [toId, fromId]);
    const progress = await tx.all('SELECT * FROM playback_progress WHERE title_id=?', [fromId]);
    for (const item of progress) {
      const episodeId = item.episode_id ? episodeMap.get(item.episode_id) || null : null; const itemKey = episodeId || toId;
      await tx.run('INSERT INTO playback_progress(user_id,profile_id,title_id,episode_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,item_key) DO UPDATE SET title_id=excluded.title_id,episode_id=excluded.episode_id,position=excluded.position,duration=excluded.duration,updated_at=excluded.updated_at WHERE excluded.updated_at>=playback_progress.updated_at', [item.user_id, item.profile_id, toId, episodeId, itemKey, item.position, item.duration, item.updated_at]);
      await tx.run('DELETE FROM playback_progress WHERE user_id=? AND item_key=? AND title_id=?', [item.user_id, item.item_key, fromId]);
    }
    const history = await tx.all('SELECT id,episode_id FROM watch_history WHERE title_id=?', [fromId]);
    for (const item of history) await tx.run('UPDATE watch_history SET title_id=?,episode_id=? WHERE id=?', [toId, item.episode_id ? episodeMap.get(item.episode_id) || null : null, item.id]);
    for (const table of ['watchlist', 'favorites']) {
      const rows = await tx.all(`SELECT * FROM ${table} WHERE title_id=?`, [fromId]);
      for (const row of rows) await tx.run(`INSERT INTO ${table}(user_id,title_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`, [row.user_id, toId, row.created_at]);
    }
    await tx.run('UPDATE metadata_identifiers SET title_id=? WHERE title_id=?', [toId, fromId]);
    const aliases = await tx.all('SELECT * FROM title_aliases WHERE title_id=?', [fromId]);
    for (const alias of aliases) await tx.run('INSERT INTO title_aliases(id,title_id,name,normalized) VALUES(?,?,?,?) ON CONFLICT(title_id,normalized) DO NOTHING', [id(), toId, alias.name, alias.normalized]);
    await tx.run('INSERT INTO title_aliases(id,title_id,name,normalized) VALUES(?,?,?,?) ON CONFLICT(title_id,normalized) DO NOTHING', [id(), toId, from.name, from.normalized]);
    await tx.run('UPDATE review_queue SET candidate_id=? WHERE candidate_id=?', [toId, fromId]);
    await tx.run("UPDATE review_queue SET title_id=?,status='resolved' WHERE title_id=?", [toId, fromId]);
    await tx.run('UPDATE title_redirects SET title_id=? WHERE title_id=?', [toId, fromId]);
    await tx.run('INSERT INTO title_redirects(alias_id,title_id,created_at) VALUES(?,?,?) ON CONFLICT(alias_id) DO UPDATE SET title_id=excluded.title_id', [fromId, toId, Date.now()]);
    const metadataLock = await tx.get('SELECT updated_at FROM title_metadata_locks WHERE title_id=?', [fromId]);
    if (metadataLock) await tx.run('INSERT INTO title_metadata_locks(title_id,updated_at) VALUES(?,?) ON CONFLICT(title_id) DO UPDATE SET updated_at=excluded.updated_at', [toId, Math.max(Date.now(), Number(metadataLock.updated_at))]);
    await tx.run('DELETE FROM titles WHERE id=?', [fromId]);
  });
}
export async function splitSource(db: DB, sourceId: string, name: string, year: number | null) {
  let newTitleId = '';
  await db.transaction(async tx => {
    const source = await tx.get('SELECT * FROM sources WHERE id=?', [sourceId]); if (!source) throw new AppError(404, 'Source not found');
    const title = await tx.get('SELECT * FROM titles WHERE id=?', [source.title_id]);
    newTitleId = await createTitle(tx, { name, year, type: title!.type, poster: title!.poster, published: !!title!.published });
    let episodeId = null;
    if (source.episode_id) {
      const episode = await tx.get('SELECT * FROM episodes WHERE id=?', [source.episode_id]); const seasonId = id(); episodeId = id();
      await tx.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,?)', [seasonId, newTitleId, episode!.season]);
      await tx.run('INSERT INTO episodes(id,title_id,season_id,season,number,name,duration) VALUES(?,?,?,?,?,?,?)', [episodeId, newTitleId, seasonId, episode!.season, episode!.number, episode!.name, episode!.duration]);
    }
    await tx.run('UPDATE sources SET title_id=?,episode_id=? WHERE id=?', [newTitleId, episodeId, sourceId]);
    await tx.run("UPDATE review_queue SET status='resolved' WHERE source_id=?", [sourceId]);
  }); return newTitleId;
}
export async function updateEpisode(db: DB, episodeId: string, fields: Record<string, unknown>) {
  const episode = await db.get('SELECT * FROM episodes WHERE id=?', [episodeId]); if (!episode) throw new AppError(404, 'Episode not found');
  const season = Number(fields.season ?? episode.season); const number = Number(fields.number ?? episode.number);
  if (!Number.isInteger(season) || season < 0 || season > 99 || !Number.isInteger(number) || number < 1 || number > 999) throw new AppError(400, 'Invalid episode numbering');
  let seasonRow = await db.get('SELECT id FROM seasons WHERE title_id=? AND number=?', [episode.title_id, season]);
  if (!seasonRow) { const seasonId = id(); await db.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,?)', [seasonId, episode.title_id, season]); seasonRow = { id: seasonId }; }
  const columnMap: Record<string, string> = { name: 'name', duration: 'duration', introStart: 'intro_start', introEnd: 'intro_end', recapStart: 'recap_start', recapEnd: 'recap_end' };
  const updates: Record<string, unknown> = { season, number, season_id: seasonRow.id };
  for (const [key, column] of Object.entries(columnMap)) if (fields[key] !== undefined) updates[column] = fields[key];
  await db.run(`UPDATE episodes SET ${Object.keys(updates).map(column => `${column}=?`).join(',')} WHERE id=?`, [...Object.values(updates), episodeId]);
}
