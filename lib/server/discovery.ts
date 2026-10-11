import type { DB } from './db';
import type { Title } from '../types';
import { publicCatalogSQL, publicTitleSQL, titleRecord } from './catalog';

export interface DiscoveryFeeds {
  featured: Title[];
  trending: Title[];
  recent: Title[];
  popularMovies: Title[];
  popularSeries: Title[];
}

const FEED_LIMIT = 12;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const visible = publicTitleSQL;

/** Aggregate registered viewing activity; never invent popularity for an empty history. */
export async function discovery(db: DB, now = Date.now()): Promise<DiscoveryFeeds> {
  const ranked = (type: 'movie' | 'series' | null, recent: boolean) => db.all(`
    SELECT t.*,COUNT(DISTINCT h.user_id) AS viewer_count,MAX(h.updated_at) AS last_viewed
    FROM watch_history h JOIN titles t ON t.id=h.title_id
    WHERE ${visible} AND h.position>0 AND h.duration>0
      ${type ? 'AND t.type=?' : ''} ${recent ? 'AND h.updated_at>=?' : ''}
    GROUP BY t.id
    ORDER BY viewer_count DESC,last_viewed DESC,t.created_at DESC,t.id ASC
    LIMIT ${FEED_LIMIT}
  `, [...(type ? [type] : []), ...(recent ? [now - WEEK_MS] : [])]);

  const [featured, trending, recent, popularMovies, popularSeries] = await Promise.all([
    db.all(`SELECT t.* FROM titles t WHERE ${visible} AND t.featured=1 ORDER BY t.created_at DESC,t.id ASC LIMIT ${FEED_LIMIT}`),
    ranked(null, true),
    db.all(`SELECT t.* FROM titles t WHERE ${publicCatalogSQL} ORDER BY t.created_at DESC,t.id ASC LIMIT ${FEED_LIMIT}`),
    ranked('movie', false),
    ranked('series', false),
  ]);
  // Only public title metadata crosses the boundary. Viewer identities and counts stay server-side.
  return {
    featured: featured.map(titleRecord), trending: trending.map(titleRecord), recent: recent.map(titleRecord),
    popularMovies: popularMovies.map(titleRecord), popularSeries: popularSeries.map(titleRecord),
  };
}
