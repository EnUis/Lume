import type { DB, Row } from './db';
import { normalizeLanguage } from '../languages';
import { cleanMediaTitle, cleanSeriesTitle, normalizeTitle, parseEpisodeTitle, parseM3U, type PlaylistEntry } from './m3u';
import { automaticMergeConflict, mergeTitles } from './management';
import { AppError, decrypt, hash, id } from './security';

export interface LanguageRepairReport { renamed: number; reclassified: number; seriesRepaired: number; episodesCreated: number; episodeNames: number; recoveredYears: number; protectedTitles: number; taggedTitleSources: number; merged: number; uncertainGroups: number }
interface Candidate extends Row { canonical: string; canonicalName: string; tagged: boolean; decorated: boolean; languages: Set<string>; episodeCount: number; locked: boolean; conflict: string | null }
const yieldWork = () => new Promise<void>(resolve => setImmediate(resolve));
const score = (row: Candidate) => Number(row.published) * 10000 + ['synopsis', 'poster', 'backdrop', 'director'].filter(key => !!row[key]).length * 100 + Number(row.featured) * 10 + (row.name === row.canonicalName ? 1 : 0);

/** Recover explicit per-source languages from saved imports without fetching providers. */
export async function backfillSourceLanguages(db: DB, onProgress?: (updated: number) => void | Promise<void>) {
  const playlists = await db.all('SELECT id,content_encrypted FROM playlists'); let updated = 0;
  for (const playlist of playlists) {
    const snapshot = await db.get('SELECT content_encrypted FROM playlist_versions WHERE playlist_id=? ORDER BY created_at DESC LIMIT 1', [playlist.id]);
    const encrypted = snapshot?.content_encrypted || playlist.content_encrypted; if (!encrypted) continue;
    const { entries } = parseM3U(decrypt(encrypted));
    const labels = new Map<string, { language: string | null; name: string }[]>();
    for (const entry of entries) {
      const urlHash = hash(entry.url), previous = labels.get(urlHash) || [];
      if (!previous.some(label => label.language === entry.language && label.name === entry.name)) previous.push({ language: entry.language, name: entry.name });
      labels.set(urlHash, previous);
    }
    const sourceRows = await db.all('SELECT id,url_hash,language,original_name FROM sources WHERE playlist_id=?', [playlist.id]);
    for (let start = 0; start < sourceRows.length; start += 200) {
      await db.transaction(async tx => {
        for (const source of sourceRows.slice(start, start + 200)) {
          const possible = labels.get(source.url_hash) || [];
          const matches = source.original_name ? possible.filter(label => label.name === source.original_name) : source.language ? possible.filter(label => normalizeLanguage(label.language) === normalizeLanguage(source.language)) : possible;
          const label = matches.length === 1 ? matches[0] : null; if (!label || source.original_name != null && (source.language != null || !label.language)) continue;
          await tx.run('UPDATE sources SET language=COALESCE(language,?),original_name=COALESCE(original_name,?) WHERE id=?', [label.language, label.name, source.id]); updated++;
        }
      });
      await yieldWork();
    }
    await onProgress?.(updated);
  }
  return updated;
}

/** Recover clear channel classifications from saved imports without a provider request. */
export async function repairImportedClassifications(db: DB) {
  const sourceRows = await db.all('SELECT id,title_id,playlist_id,url_hash,original_name FROM sources WHERE removed=0');
  const scanned = new Map(sourceRows.map(source => [source.id, source]));
  const byPlaylist = new Map<string, Row[]>(); const byTitle = new Map<string, Row[]>(); const hints = new Map<string, string>();
  for (const source of sourceRows) {
    const related = byTitle.get(source.title_id) || []; related.push(source); byTitle.set(source.title_id, related);
    if (source.playlist_id) { const rows = byPlaylist.get(source.playlist_id) || []; rows.push(source); byPlaylist.set(source.playlist_id, rows); }
  }
  for (const [playlistId, sources] of byPlaylist) {
    const snapshot = await db.get('SELECT content_encrypted FROM playlist_versions WHERE playlist_id=? ORDER BY created_at DESC LIMIT 1', [playlistId]);
    const saved = snapshot || await db.get('SELECT content_encrypted FROM playlists WHERE id=?', [playlistId]); if (!saved?.content_encrypted) continue;
    let entries; try { entries = parseM3U(decrypt(saved.content_encrypted)).entries; } catch { continue; }
    const labels = new Map<string, { name: string; type: string }[]>();
    for (const entry of entries) { const key = hash(entry.url), rows = labels.get(key) || []; rows.push({ name: entry.name, type: entry.type }); labels.set(key, rows); }
    for (const source of sources) {
      const possible = labels.get(source.url_hash) || [], exact = source.original_name ? possible.filter(label => label.name === source.original_name) : possible;
      const types = new Set(exact.map(label => label.type)); if (types.size === 1) hints.set(source.id, [...types][0]);
    }
    await yieldWork();
  }
  let reclassified = 0, renamed = 0;
  const candidates = await db.all("SELECT id FROM titles t WHERE type='movie' AND year IS NULL AND NOT EXISTS(SELECT 1 FROM title_metadata_locks l WHERE l.title_id=t.id) AND NOT EXISTS(SELECT 1 FROM metadata_identifiers m WHERE m.title_id=t.id) AND NOT EXISTS(SELECT 1 FROM episodes e WHERE e.title_id=t.id)");
  for (const candidate of candidates) {
    const sources = byTitle.get(candidate.id); if (!sources?.length || !sources.every(source => hints.get(source.id) === 'live')) continue;
    await db.transaction(async tx => {
      const current = await tx.get('SELECT * FROM titles WHERE id=?' + (tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), [candidate.id]);
      if (!current || current.type !== 'movie' || current.year != null || await tx.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [candidate.id]) || await tx.get('SELECT id FROM metadata_identifiers WHERE title_id=?', [candidate.id]) || await tx.get('SELECT id FROM episodes WHERE title_id=?', [candidate.id])) return;
      const active = await tx.all('SELECT id,url_hash,original_name,playlist_id FROM sources WHERE title_id=? AND removed=0 ORDER BY id' + (tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), [candidate.id]);
      if (!active.length || !active.every(source => { const previous = scanned.get(source.id); return !!previous && hints.get(source.id) === 'live' && previous.url_hash === source.url_hash && previous.original_name === source.original_name && previous.playlist_id === source.playlist_id; })) return;
      const cleaned = cleanMediaTitle(current.name).title;
      if (cleaned !== current.name) { await tx.run('INSERT INTO title_aliases(id,title_id,name,normalized) VALUES(?,?,?,?) ON CONFLICT(title_id,normalized) DO NOTHING', [id(), candidate.id, current.name, current.normalized]); renamed++; }
      await tx.run("UPDATE titles SET type='live',name=?,normalized=?,updated_at=? WHERE id=?", [cleaned, normalizeTitle(cleaned), Date.now(), candidate.id]); reclassified++;
    });
    await yieldWork();
  }
  return { reclassified, renamed };
}

/** Replace only empty/decorative provider episode labels, preserving narrative and manual names. */
export async function repairEpisodeNames(db: DB) {
  const episodes = await db.all("SELECT e.id,e.title_id,e.number,e.name FROM episodes e WHERE NOT EXISTS(SELECT 1 FROM title_metadata_locks l WHERE l.title_id=e.title_id) AND NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.entity_id=e.id AND a.action IN ('episode.update','episode.create'))");
  let updated = 0;
  for (let start = 0; start < episodes.length; start += 100) {
    await db.transaction(async tx => {
      for (const episode of episodes.slice(start, start + 100)) {
        const fallback = `Episode ${episode.number}`;
        if (episode.name === fallback || episode.name.trim() && cleanMediaTitle(`${fallback} | ${episode.name}`).title !== fallback) continue;
        const current = await tx.get('SELECT name,title_id FROM episodes WHERE id=?' + (tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), [episode.id]);
        if (!current || current.name !== episode.name || await tx.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [current.title_id]) || await tx.get("SELECT id FROM audit_log WHERE entity_id=? AND action IN ('episode.update','episode.create') LIMIT 1", [episode.id])) continue;
        await tx.run('UPDATE episodes SET name=? WHERE id=?', [fallback, episode.id]); updated++;
      }
    });
    await yieldWork();
  }
  return updated;
}

interface SeriesHint { title: string; normalized: string; year: number | null; season: number; episode: number; episodeName: string; language: string | null; originalName: string; }
function seriesLabel(name: string): SeriesHint | null {
  const outer = cleanMediaTitle(name, {}, false), coordinates = parseEpisodeTitle(outer.title);
  if (!coordinates || coordinates.episode < 1 || coordinates.episode > 999 || coordinates.season > 99) return null;
  const identity = cleanMediaTitle(coordinates.title);
  return { title: identity.title, normalized: normalizeTitle(identity.title), year: identity.year, season: coordinates.season, episode: coordinates.episode, episodeName: coordinates.episodeName, language: outer.language || identity.language, originalName: name };
}
function seriesEntry(entry: PlaylistEntry): SeriesHint | null {
  return entry.type === 'series' && entry.season !== null && entry.episode !== null && !entry.ambiguous ? { title: entry.title, normalized: entry.normalized, year: entry.year, season: entry.season, episode: entry.episode, episodeName: entry.episodeName, language: entry.language, originalName: entry.name } : null;
}

function episodeMarkerSQL(db: DB, column: string) {
  // A broad SQL prefilter keeps memory bounded; the conservative parser makes
  // the actual decision. Include season badges to recover duplicated show names.
  if (db.dialect === 'postgres') return `COALESCE(${column},'') ~* '(^|[^[:alnum:]])(s(eason){0,1}[[:space:]._-]*[0-9]{1,2}([[:space:]._:-]*(episode|ep|e)[[:space:]._-]*[0-9]{1,3}){0,1}|[0-9]{1,2}x[0-9]{1,3})([^[:alnum:]]|$)'`;
  return '(' + ['%season%', ...Array.from({ length: 10 }, (_, digit) => `%s${digit}%`), ...Array.from({ length: 10 }, (_, digit) => `%${digit}x%`)].map(pattern => `LOWER(COALESCE(${column},'')) LIKE '${pattern}'`).join(' OR ') + ')';
}
async function missingSeriesLabels(db: DB) {
  const missing = await db.all(`SELECT s.id,s.playlist_id,s.url_hash FROM sources s JOIN titles t ON t.id=s.title_id WHERE s.removed=0 AND s.original_name IS NULL AND s.playlist_id IS NOT NULL AND (t.type='series' OR t.type='movie' AND ${episodeMarkerSQL(db, 't.name')})`);
  const byPlaylist = new Map<string, Row[]>(), hints = new Map<string, SeriesHint>();
  for (const source of missing) { const list = byPlaylist.get(source.playlist_id) || []; list.push(source); byPlaylist.set(source.playlist_id, list); }
  // Parse each needed saved snapshot once, retaining only the missing sources.
  for (const [playlistId, related] of byPlaylist) {
    const snapshot = await db.get('SELECT content_encrypted FROM playlist_versions WHERE playlist_id=? ORDER BY created_at DESC LIMIT 1', [playlistId]);
    const saved = snapshot || await db.get('SELECT content_encrypted FROM playlists WHERE id=?', [playlistId]);
    if (!saved?.content_encrypted) continue;
    let entries: PlaylistEntry[]; try { entries = parseM3U(decrypt(saved.content_encrypted)).entries; } catch { continue; }
    const wanted = new Set(related.map(source => source.url_hash)), byHash = new Map<string, PlaylistEntry[]>();
    for (const entry of entries) { const key = hash(entry.url); if (!wanted.has(key)) continue; const list = byHash.get(key) || []; list.push(entry); byHash.set(key, list); }
    for (const source of related) {
      const exact = byHash.get(source.url_hash) || [];
      if (!exact.length) continue;
      const recovered = exact.map(seriesEntry);
      // Reused URLs are not sufficient evidence when their saved labels disagree.
      if (recovered.some(hint => !hint) || new Set(recovered.map(hint => JSON.stringify([hint!.normalized, hint!.year, hint!.season, hint!.episode]))).size !== 1) { hints.delete(source.id); continue; }
      const first = recovered[0]!;
      hints.set(source.id, { ...first, language: new Set(recovered.map(hint => hint!.language)).size === 1 ? first.language : null });
    }
    await yieldWork();
  }
  return hints;
}

export interface SeriesRepairOptions { concurrency?: number; }
/** Drain every in-flight transaction before reporting failure or starting merges. */
async function repairBatch<T>(items: T[], concurrency: number, process: (item: T, stopped: () => boolean) => Promise<void>) {
  let next = 0, failed = false, failure: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try { await process(item, () => failed); }
      catch (error) { if (!failed) { failure = error; failed = true; } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failed) throw failure;
}
function repairConcurrency(db: DB, options: SeriesRepairOptions) {
  // A PostgreSQL transaction adapter looks like the pool adapter. Callers must
  // opt in only when supplying the pool; previews explicitly stay sequential.
  return db.dialect === 'postgres' && Number.isFinite(options.concurrency) ? Math.max(1, Math.min(8, Math.floor(options.concurrency!))) : 1;
}

/** Recover explicit episode structure locally, in bounded batches of candidate titles. */
export async function repairImportedSeries(db: DB, onIdentity?: (identity: Row) => void, onProgress?: (report: { seriesRepaired: number; episodesCreated: number }) => void | Promise<void>, options: SeriesRepairOptions = {}) {
  const concurrency = repairConcurrency(db, options);
  const result = { renamed: 0, reclassified: 0, seriesRepaired: 0, episodesCreated: 0, recoveredYears: 0, uncertainGroups: 0 };
  const missingHints = await missingSeriesLabels(db);
  const review = async (titleId: string, reason: string) => {
    if (!(await db.get("SELECT id FROM review_queue WHERE title_id=? AND reason=? AND status='pending'", [titleId, reason]))) await db.run('INSERT INTO review_queue(id,title_id,reason,created_at) VALUES(?,?,?,?)', [id(), titleId, reason, Date.now()]);
    result.uncertainGroups++;
  };
  let cursor = '';
  while (true) {
  const titles = await db.all(`SELECT t.id,t.name,t.normalized,t.type,t.year,t.published FROM titles t WHERE t.type IN ('movie','series') AND t.id>? AND (${episodeMarkerSQL(db, 't.name')} OR EXISTS(SELECT 1 FROM sources s WHERE s.title_id=t.id AND s.removed=0 AND (${episodeMarkerSQL(db, 's.original_name')} OR t.type='series' AND s.original_name IS NULL))) ORDER BY t.id LIMIT 200`, [cursor]);
  if (!titles.length) break;
  cursor = titles[titles.length - 1].id;
  const sources = await db.all(`SELECT id,title_id,episode_id,playlist_id,url_hash,original_name,language FROM sources WHERE removed=0 AND title_id IN (${titles.map(() => '?').join(',')})`, titles.map(title => title.id));
  const byTitle = new Map<string, Row[]>(), hints = new Map<string, SeriesHint>();
  for (const source of sources) {
    const list = byTitle.get(source.title_id) || []; list.push(source); byTitle.set(source.title_id, list);
    const hint = source.original_name ? seriesLabel(source.original_name) : missingHints.get(source.id); if (hint) hints.set(source.id, hint);
  }
  await repairBatch(titles, concurrency, async title => {
    const related = byTitle.get(title.id) || [], recovered = related.map(source => hints.get(source.id));
    if (!related.length || recovered.some(hint => !hint)) return;
    const labels = recovered as SeriesHint[], parent = labels[0], labeledTitle = seriesLabel(title.name);
    // A bound English/display name must not be replaced by a provider's localized
    // title. Only raw coordinate labels or the same clean show identity are eligible.
    const currentIdentity = labeledTitle?.normalized || normalizeTitle(cleanMediaTitle(cleanSeriesTitle(title.name, parent.season)).title);
    if (currentIdentity !== parent.normalized) return;
    const years = new Set(labels.map(hint => hint.year).filter(year => year !== null));
    if (labels.some(hint => hint.normalized !== parent.normalized) || years.size > 1 || title.year != null && years.size && !years.has(Number(title.year))) { await review(title.id, 'Saved episode labels have conflicting show identities or release years; confirm the series before repair'); return; }
    if (title.type === 'series' && title.name === parent.title && title.normalized === parent.normalized && related.every(source => source.episode_id && source.original_name != null && (source.language != null || !hints.get(source.id)?.language)) && (title.year != null || !years.size)) { onIdentity?.(title); return; }
    let failure: string | null = null, identity: Row | null = null;
    await db.transaction(async tx => {
      const current = await tx.get('SELECT * FROM titles WHERE id=?' + (tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), [title.id]);
      if (!current || current.name !== title.name || current.type !== title.type || Number(current.year || 0) !== Number(title.year || 0)) return;
      if (await tx.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [title.id])) { failure = 'Administrator metadata locks protect this episode identity; confirm its series repair manually'; return; }
      if (current.type !== 'series' && await tx.get('SELECT id FROM metadata_identifiers WHERE title_id=? LIMIT 1', [title.id])) { failure = 'A bound movie identity conflicts with explicit episode labels; confirm its classification manually'; return; }
      const active = await tx.all('SELECT id,episode_id,url_hash,original_name,playlist_id,language FROM sources WHERE title_id=? AND removed=0 ORDER BY id' + (tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), [title.id]);
      const original = new Map(related.map(source => [source.id, source]));
      if (active.length !== related.length || active.some(source => { const old = original.get(source.id); return !old || old.url_hash !== source.url_hash || old.original_name !== source.original_name || old.episode_id !== source.episode_id || old.playlist_id !== source.playlist_id; })) return;
      const existingEpisodes = await tx.all('SELECT * FROM episodes WHERE title_id=?', [title.id]), episodesById = new Map(existingEpisodes.map(episode => [episode.id, episode]));
      if (active.some(source => { const old = source.episode_id && episodesById.get(source.episode_id), hint = hints.get(source.id)!; return source.episode_id && (!old || Number(old.season) !== hint.season || Number(old.number) !== hint.episode); })) { failure = 'Stored episode coordinates conflict with saved labels; confirm episode assignment manually'; return; }
      let changed = current.type !== 'series' || current.name !== parent.title || current.normalized !== parent.normalized;
      if (current.name !== parent.title) {
        await tx.run('INSERT INTO title_aliases(id,title_id,name,normalized) VALUES(?,?,?,?) ON CONFLICT(title_id,normalized) DO NOTHING', [id(), title.id, current.name, current.normalized]); result.renamed++;
      }
      if (current.type !== 'series') result.reclassified++;
      const releaseYear = current.year ?? (years.size === 1 ? [...years][0] : null);
      if (current.year == null && releaseYear != null) result.recoveredYears++;
      changed ||= Number(current.year || 0) !== Number(releaseYear || 0);
      if (changed || current.normalized !== parent.normalized) await tx.run("UPDATE titles SET name=?,normalized=?,type='series',year=?,updated_at=? WHERE id=?", [parent.title, parent.normalized, releaseYear, Date.now(), title.id]);
      const episodes = new Map(existingEpisodes.map(episode => [`${episode.season}:${episode.number}`, episode.id]));
      for (const source of active) {
        const hint = hints.get(source.id)!, key = `${hint.season}:${hint.episode}`;
        let episodeId = episodes.get(key);
        if (!episodeId) {
          let season = await tx.get('SELECT id FROM seasons WHERE title_id=? AND number=?', [title.id, hint.season]);
          if (!season) { const seasonId = id(); await tx.run('INSERT INTO seasons(id,title_id,number) VALUES(?,?,?)', [seasonId, title.id, hint.season]); season = { id: seasonId }; }
          episodeId = id(); await tx.run('INSERT INTO episodes(id,title_id,season_id,season,number,name) VALUES(?,?,?,?,?,?)', [episodeId, title.id, season.id, hint.season, hint.episode, hint.episodeName || `Episode ${hint.episode}`]);
          episodes.set(key, episodeId); result.episodesCreated++; changed = true;
        }
        if (source.episode_id !== episodeId || source.original_name == null || source.language == null && hint.language) { await tx.run('UPDATE sources SET episode_id=?,language=COALESCE(language,?),original_name=COALESCE(original_name,?) WHERE id=?', [episodeId, hint.language, hint.originalName, source.id]); changed = true; }
      }
      const coordinates = new Set(labels.map(hint => `${hint.season}:${hint.episode}`));
      if ((labeledTitle || cleanSeriesTitle(title.name, parent.season) !== title.name) && coordinates.size === 1) {
        const episodeId = episodes.get([...coordinates][0])!;
        // An old split title also identifies its single episode for guest history.
        await tx.run('INSERT INTO episode_redirects(alias_id,episode_id,created_at) VALUES(?,?,?) ON CONFLICT(alias_id) DO UPDATE SET episode_id=excluded.episode_id', [title.id, episodeId, Date.now()]);
        const progress = await tx.all('SELECT * FROM playback_progress WHERE title_id=? AND episode_id IS NULL', [title.id]);
        for (const item of progress) {
          await tx.run('INSERT INTO playback_progress(user_id,profile_id,title_id,episode_id,item_key,position,duration,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,item_key) DO UPDATE SET title_id=excluded.title_id,episode_id=excluded.episode_id,position=excluded.position,duration=excluded.duration,updated_at=excluded.updated_at WHERE excluded.updated_at>=playback_progress.updated_at', [item.user_id, item.profile_id, title.id, episodeId, episodeId, item.position, item.duration, item.updated_at]);
          await tx.run('DELETE FROM playback_progress WHERE user_id=? AND item_key=? AND title_id=? AND episode_id IS NULL', [item.user_id, item.item_key, title.id]);
        }
        await tx.run('UPDATE watch_history SET episode_id=? WHERE title_id=? AND episode_id IS NULL', [episodeId, title.id]);
      }
      const pending = await tx.all("SELECT id,reason FROM review_queue WHERE title_id=? AND status='pending'", [title.id]);
      if (pending.length && pending.every(row => row.reason === 'Content classification requires administrator review')) {
        await tx.run('UPDATE titles SET published=1 WHERE id=?', [title.id]);
        await tx.run("UPDATE review_queue SET status='resolved' WHERE title_id=? AND status='pending'", [title.id]); changed = true;
      }
      if (changed) result.seriesRepaired++;
      identity = { ...current, name: parent.title, normalized: parent.normalized, type: 'series', year: releaseYear };
    });
    if (failure) await review(title.id, failure);
    if (identity) onIdentity?.(identity);
    await yieldWork();
  });
  await onProgress?.({ seriesRepaired: result.seriesRepaired, episodesCreated: result.episodesCreated });
  }
  // Some old imports already have complete episode structure but kept only a
  // season label in original_name. Their stored coordinates are sufficient to
  // clean the parent name; no episode/source assignments need to be invented.
  cursor = '';
  while (true) {
    const titles = await db.all(`SELECT t.* FROM titles t WHERE t.type='series' AND t.id>? AND ${episodeMarkerSQL(db, 't.name')} AND EXISTS(SELECT 1 FROM episodes e WHERE e.title_id=t.id) ORDER BY t.id LIMIT 200`, [cursor]);
    if (!titles.length) break;
    cursor = titles[titles.length - 1].id;
    await repairBatch(titles, concurrency, async title => {
      const raw = cleanSeriesTitle(title.name), tags = cleanMediaTitle(raw);
      if (raw === title.name || tags.title === title.name) return;
      if (tags.year && title.year != null && Number(title.year) !== tags.year) { await review(title.id, 'Stored and labeled release years conflict; confirm the correct series'); return; }
      let identity: Row | null = null;
      await db.transaction(async tx => {
        const current = await tx.get('SELECT * FROM titles WHERE id=?' + (tx.dialect === 'postgres' ? ' FOR UPDATE' : ''), [title.id]);
        if (!current || current.name !== title.name || current.type !== 'series' || Number(current.year || 0) !== Number(title.year || 0) || await tx.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [title.id]) || !await tx.get('SELECT id FROM episodes WHERE title_id=? LIMIT 1', [title.id])) return;
        const normalized = normalizeTitle(tags.title), year = current.year ?? tags.year;
        const sourceLabels = await tx.all('SELECT s.original_name,s.episode_id,e.season,e.number FROM sources s LEFT JOIN episodes e ON e.id=s.episode_id AND e.title_id=s.title_id WHERE s.title_id=? AND s.removed=0', [title.id]);
        if (sourceLabels.some(source => {
          const hint = source.original_name && seriesLabel(source.original_name);
          return hint && (hint.normalized !== normalized || hint.year != null && year != null && hint.year !== Number(year) || source.episode_id && (Number(source.season) !== hint.season || Number(source.number) !== hint.episode));
        })) return;
        await tx.run('INSERT INTO title_aliases(id,title_id,name,normalized) VALUES(?,?,?,?) ON CONFLICT(title_id,normalized) DO NOTHING', [id(), title.id, current.name, current.normalized]);
        await tx.run('UPDATE titles SET name=?,normalized=?,year=?,updated_at=? WHERE id=?', [tags.title, normalized, year, Date.now(), title.id]);
        result.renamed++; result.seriesRepaired++;
        if (current.year == null && year != null) result.recoveredYears++;
        identity = { ...current, name: tags.title, normalized, year };
      });
      if (identity) onIdentity?.(identity);
      await yieldWork();
    });
    await onProgress?.({ seriesRepaired: result.seriesRepaired, episodesCreated: result.episodesCreated });
  }
  return result;
}

/** A bounded episode-only repair for large catalogs; unrelated movies are untouched. */
export async function repairSeriesCatalog(db: DB, onProgress?: (report: Record<string, number>) => void | Promise<void>, options: SeriesRepairOptions = {}) {
  const concurrency = repairConcurrency(db, options);
  const identities = new Set<string>(), confirmed = new Set<string>();
  const structure = await repairImportedSeries(db, row => { identities.add(row.normalized); confirmed.add(row.id); }, onProgress, options);
  const result = { ...structure, merged: 0 };
  const names = [...identities];
  const review = async (rows: Row[], reason: string) => {
    result.uncertainGroups++;
    const target = [...rows].sort((a, b) => score(b as Candidate) - score(a as Candidate) || Number(a.created_at) - Number(b.created_at))[0];
    for (const row of rows) if (row.id !== target.id && !(await db.get("SELECT id FROM review_queue WHERE title_id=? AND reason=? AND status='pending'", [row.id, reason]))) await db.run('INSERT INTO review_queue(id,title_id,candidate_id,reason,created_at) VALUES(?,?,?,?,?)', [id(), row.id, target.id, reason, Date.now()]);
  };
  const merge = async (fromId: string, toId: string, stopped: () => boolean) => {
    for (let attempt = 0; ; attempt++) {
      try { await mergeTitles(db, fromId, toId, { automatic: true }); return; }
      catch (error) {
        // mergeTitles owns its transaction: its rejection has already rolled
        // back. Never retry arbitrary errors or a transaction-scoped preview.
        if (concurrency === 1 || db.dialect !== 'postgres' || (error as { code?: string } | null)?.code !== '40P01' || attempt >= 2 || stopped()) throw error;
        await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
        if (stopped()) throw error;
      }
    }
  };
  const consolidate = async (rows: Row[], stopped: () => boolean) => {
    const ordered = [...rows].sort((a, b) => score(b as Candidate) - score(a as Candidate) || Number(a.created_at) - Number(b.created_at)), target = ordered[0];
    for (const from of ordered.slice(1)) {
      if (stopped()) break;
      const conflict = await automaticMergeConflict(db, from, target);
      if (stopped()) break;
      if (conflict) { await review([from, target], conflict); continue; }
      try { await merge(from.id, target.id, stopped); result.merged++; }
      catch (error) { if (!(error instanceof AppError) || error.status !== 409) throw error; await review([from, target], error.message); }
      await yieldWork();
    }
    return target;
  };
  for (let offset = 0; offset < names.length; offset += 100) {
    const batch = names.slice(offset, offset + 100);
    const rows = await db.all(`SELECT t.*,(SELECT COUNT(*) FROM episodes e WHERE e.title_id=t.id) AS episode_count FROM titles t WHERE t.type='series' AND t.normalized IN (${batch.map(() => '?').join(',')})`, batch);
    const groups = new Map<string, Row[]>();
    for (const row of rows) { const group = groups.get(row.normalized) || []; group.push(row); groups.set(row.normalized, group); }
    // This query returns each title ID once. Grouping by its normalized name
    // gives disjoint families; all merges within one family stay sequential.
    await repairBatch([...groups.values()], concurrency, async (group, stopped) => {
      if (group.length < 2) return;
      if (group.some(row => !Number(row.episode_count) || row.year == null && !confirmed.has(row.id))) { await review(group, 'Missing episode or release identity is insufficient for automatic series consolidation'); return; }
      const dated = new Map<number, Row[]>(), undated: Row[] = [];
      for (const row of group) { if (row.year == null) undated.push(row); else { const subset = dated.get(Number(row.year)) || []; subset.push(row); dated.set(Number(row.year), subset); } }
      if (!dated.size) await consolidate(undated, stopped);
      else {
        const survivors: Row[] = []; for (const subset of dated.values()) { if (stopped()) return; survivors.push(await consolidate(subset, stopped)); }
        if (stopped()) return;
        if (undated.length && dated.size === 1) await consolidate([...survivors, ...undated], stopped);
        else if (undated.length) await review([...survivors, ...undated], 'The show name has multiple release years; confirm the undated episode identity before merging');
      }
    });
    await onProgress?.({ ...result }); await yieldWork();
  }
  return result;
}

export async function previewSeriesRepair(db: DB) {
  const rollback = new Error('Series repair preview rollback'); let report!: Awaited<ReturnType<typeof repairSeriesCatalog>>;
  try { await db.transaction(async tx => { report = await repairSeriesCatalog(tx, undefined, { concurrency: 1 }); throw rollback; }); }
  catch (error) { if (error !== rollback) throw error; }
  return report;
}

/** Consolidate explicit language versions without guessing translated titles or remakes. */
export async function repairLanguageCatalog(db: DB, onProgress?: (report: LanguageRepairReport) => void | Promise<void>, options: SeriesRepairOptions = {}) {
  const classified = await repairImportedClassifications(db);
  const series = await repairImportedSeries(db, undefined, undefined, options);
  const report: LanguageRepairReport = { renamed: classified.renamed + series.renamed, reclassified: classified.reclassified + series.reclassified, seriesRepaired: series.seriesRepaired, episodesCreated: series.episodesCreated, episodeNames: await repairEpisodeNames(db), recoveredYears: series.recoveredYears, protectedTitles: 0, taggedTitleSources: 0, merged: 0, uncertainGroups: series.uncertainGroups };
  const languageRows = await db.all('SELECT DISTINCT title_id,language FROM sources WHERE language IS NOT NULL');
  const languageMap = new Map<string, Set<string>>();
  for (const row of languageRows) { const language = normalizeLanguage(row.language); if (!language) continue; const set = languageMap.get(row.title_id) || new Set<string>(); set.add(language); languageMap.set(row.title_id, set); }
  const episodeRows = await db.all('SELECT title_id,COUNT(*) AS count FROM episodes GROUP BY title_id');
  const episodes = new Map(episodeRows.map(row => [row.title_id, Number(row.count)]));
  const identifierRows = await db.all('SELECT title_id,provider,external_id FROM metadata_identifiers');
  const identifiers = new Map<string, Row[]>();
  for (const row of identifierRows) { const rows = identifiers.get(row.title_id) || []; rows.push(row); identifiers.set(row.title_id, rows); }
  const locked = new Set((await db.all('SELECT title_id FROM title_metadata_locks')).map(row => row.title_id));
  const rows: Candidate[] = (await db.all("SELECT id,name,normalized,type,year,published,synopsis,poster,backdrop,director,featured,created_at FROM titles WHERE type IN ('movie','series')")).map(row => {
    const tags = cleanMediaTitle(row.name), languages = languageMap.get(row.id) || new Set<string>(); if (tags.language) languages.add(tags.language);
    const conflict = tags.year && row.year != null && Number(row.year) !== tags.year ? 'Stored and labeled release years conflict; confirm the correct work' : null;
    return { ...row, year: row.year ?? tags.year, canonical: normalizeTitle(tags.title), canonicalName: tags.title, tagged: tags.languageExplicit, decorated: tags.decorated, languages, episodeCount: episodes.get(row.id) || 0, locked: locked.has(row.id), conflict };
  });
  const byId = new Map(rows.map(row => [row.id, row])); const sourceYears = new Map<string, Set<number>>();
  // Descriptor-only reads contain no stream URLs. Grouping remains linear in the
  // catalog size rather than comparing every source or title with every other one.
  const descriptions = await db.all("SELECT s.title_id,s.original_name FROM sources s JOIN titles t ON t.id=s.title_id WHERE s.removed=0 AND s.original_name IS NOT NULL AND t.type IN ('movie','series')");
  for (let offset = 0; offset < descriptions.length; offset++) {
    const source = descriptions[offset], row = byId.get(source.title_id); if (!row) continue;
    const identityName = row.type === 'series' ? parseEpisodeTitle(cleanMediaTitle(source.original_name, {}, false).title)?.title || source.original_name : source.original_name;
    const tags = cleanMediaTitle(identityName); if (normalizeTitle(tags.title) !== row.canonical) continue;
    row.decorated ||= tags.decorated; row.tagged ||= tags.languageExplicit; if (tags.language) row.languages.add(tags.language);
    if (tags.year) { const values = sourceYears.get(row.id) || new Set<number>(); values.add(tags.year); sourceYears.set(row.id, values); }
    if (offset % 2000 === 0) await yieldWork();
  }
  for (const row of rows) {
    const years = sourceYears.get(row.id);
    if (years && (years.size > 1 || row.year != null && !years.has(Number(row.year)))) row.conflict = 'Source release years conflict; keep identities for review';
    if (row.year == null && years?.size === 1) row.year = [...years][0];
  }
  const groups = new Map<string, Candidate[]>();
  for (let start = 0; start < rows.length; start += 100) {
    await db.transaction(async tx => {
      for (const row of rows.slice(start, start + 100)) {
        const tags = cleanMediaTitle(row.name);
        if (tags.language) { await tx.run('UPDATE sources SET language=COALESCE(language,?),original_name=COALESCE(original_name,?) WHERE title_id=?', [tags.language, row.name, row.id]); report.taggedTitleSources++; }
        // Recheck current locks inside each commit, not only the initial scan.
        row.locked ||= !!(await tx.get('SELECT title_id FROM title_metadata_locks WHERE title_id=?', [row.id]));
        if (row.locked) report.protectedTitles++;
        else if (!row.conflict) {
          const current = await tx.get('SELECT name,normalized,year FROM titles WHERE id=?', [row.id]); if (!current) continue;
          if (current.name !== row.name || current.year != null && Number(current.year) !== Number(row.year)) { row.conflict = 'Title was edited during repair; confirm its identity'; continue; }
          if (current.year == null && row.year != null) { await tx.run('UPDATE titles SET year=?,updated_at=? WHERE id=? AND year IS NULL', [row.year, Date.now(), row.id]); report.recoveredYears++; }
          if (row.name !== row.canonicalName) {
          await tx.run('INSERT INTO title_aliases(id,title_id,name,normalized) VALUES(?,?,?,?) ON CONFLICT(title_id,normalized) DO NOTHING', [id(), row.id, row.name, row.normalized]);
          await tx.run('UPDATE titles SET name=?,normalized=?,updated_at=? WHERE id=?', [row.canonicalName, row.canonical, Date.now(), row.id]); report.renamed++;
          }
        }
        const key = `${row.type}\0${row.canonical}`; const group = groups.get(key) || []; group.push(row); groups.set(key, group);
      }
    });
    await yieldWork();
  }
  const conflicts = (candidates: Candidate[]) => {
    const external = new Map<string, Set<string>>();
    for (const candidate of candidates) for (const identity of identifiers.get(candidate.id) || []) { const values = external.get(identity.provider) || new Set<string>(); values.add(identity.external_id); external.set(identity.provider, values); }
    return [...external.values()].some(values => values.size > 1);
  };
  const reviewGroup = async (group: Candidate[], reason: string) => {
    report.uncertainGroups++;
    const target = [...group].sort((a, b) => score(b) - score(a) || Number(a.created_at) - Number(b.created_at))[0];
    for (const row of group) if (row.id !== target.id && !(await db.get("SELECT id FROM review_queue WHERE title_id=? AND reason=? AND status='pending'", [row.id, reason]))) {
      await db.run('INSERT INTO review_queue(id,title_id,candidate_id,reason,created_at) VALUES(?,?,?,?,?)', [id(), row.id, target.id, reason, Date.now()]);
    }
  };
  const consolidate = async (candidates: Candidate[]) => {
    if (candidates.length < 2) return candidates[0];
    if (candidates.some(row => row.locked || row.conflict)) { await reviewGroup(candidates, candidates.find(row => row.conflict)?.conflict || 'Administrator metadata locks protect these identities; confirm any merge manually'); return; }
    if (conflicts(candidates)) { await reviewGroup(candidates, 'Language versions have conflicting external identities; confirm the correct work'); return; }
    const ordered = [...candidates].sort((a, b) => score(b) - score(a) || Number(a.created_at) - Number(b.created_at));
    const target = ordered[0];
    for (const from of ordered.slice(1)) {
      const conflict = await automaticMergeConflict(db, from, target);
      if (conflict) { await reviewGroup([from, target], conflict); continue; }
      try { await mergeTitles(db, from.id, target.id, { automatic: true }); report.merged++; }
      catch (error) { if (!(error instanceof AppError) || error.status !== 409) throw error; await reviewGroup([from, target], error.message); }
      await yieldWork();
    }
    return target;
  };
  let processed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const known = new Map<number, Candidate[]>(); const unknown: Candidate[] = [];
    for (const row of group) { if (row.year == null) unknown.push(row); else { const sameYear = known.get(Number(row.year)) || []; sameYear.push(row); known.set(Number(row.year), sameYear); } }
    if (group.some(row => row.locked || row.conflict)) { await reviewGroup(group, group.find(row => row.conflict)?.conflict || 'Administrator metadata locks protect these identities; confirm any merge manually'); continue; }
    const datedSurvivors: Candidate[] = [];
    for (const sameYear of known.values()) { const survivor = await consolidate(sameYear); if (survivor) datedSurvivors.push(survivor); }
    const explicitLanguages = new Set(unknown.flatMap(row => [...row.languages].filter(language => language !== 'mul')));
    if (known.size === 0) {
      const seriesEvidence = group[0].type === 'series' && unknown.every(row => row.episodeCount > 0);
      const seen = new Set<string>(); let overlappingLanguage = false;
      for (const row of unknown) for (const language of row.languages) { if (seen.has(language)) overlappingLanguage = true; seen.add(language); }
      const movieEvidence = explicitLanguages.size > 1 && unknown.every(row => row.languages.size > 0 && !row.languages.has('mul')) && (!overlappingLanguage || unknown.every(row => row.decorated));
      const decoratedEvidence = unknown.some(row => row.decorated) && unknown.filter(row => !row.decorated).length <= 1;
      if (movieEvidence || seriesEvidence || decoratedEvidence) await consolidate(unknown);
      else if (unknown.length > 1 && group.some(row => row.tagged || row.languages.size || row.decorated)) await reviewGroup(unknown, 'Undated copies have overlapping or unspecified identities; confirm before merging');
    } else if (unknown.length) {
      // A single dated identity plus explicit version tags is a title-based match;
      // multiple stated release years still require a human to select the remake.
      if (known.size === 1 && datedSurvivors.length === 1 && !conflicts(group) && unknown.every(row => row.tagged || row.decorated || row.languages.size > 0)) await consolidate([datedSurvivors[0], ...unknown]);
      else await reviewGroup([...unknown, ...datedSurvivors], 'Missing release year has conflicting or insufficient version identity; confirm before merging');
    }
    if (++processed % 100 === 0) await onProgress?.({ ...report });
  }
  await onProgress?.({ ...report });
  return report;
}

/** Preview the exact repair with rollback, including language backfill and redirects. */
export async function previewLanguageRepair(db: DB) {
  const rollback = new Error('Catalog repair preview rollback'); let result!: { sources: number; report: LanguageRepairReport };
  try {
    await db.transaction(async tx => { const sources = await backfillSourceLanguages(tx); const report = await repairLanguageCatalog(tx, undefined, { concurrency: 1 }); result = { sources, report }; throw rollback; });
  } catch (error) { if (error !== rollback) throw error; }
  return result;
}
