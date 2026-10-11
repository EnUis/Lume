import '../lib/server/env';
import { database } from '../lib/server/db';
import { encrypt, id, sanitizeError } from '../lib/server/security';
import { synchronizePlaylist } from '../lib/server/pipeline';

async function main() {
  const db = await database();
  if (!process.argv.includes('--no-seed') && !(await db.get("SELECT id FROM playlists WHERE name='Blender Open Movies · development samples'"))) {
    const playlistId = id();
    const content = `#EXTM3U
#EXTINF:-1 type="movie" group-title="Movies Animation Comedy Adventure" tvg-logo="/images/bunny-poster.jpg" imdb-id="tt1254207",Big Buck Bunny (2008)
https://media.w3.org/2010/05/bunny/movie.mp4
#EXTINF:-1 type="movie" group-title="Movies Animation Comedy Adventure" imdb-id="tt1254207",Big Buck Bunny (2008) HLS
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 type="movie" group-title="Movies Sci-Fi Action Drama" tvg-logo="/images/tears-poster.png" imdb-id="tt2285752",Tears of Steel (2012)
https://test-streams.mux.dev/tos_ismc/main.m3u8
#EXTINF:-1 type="movie" group-title="Movies Animation Fantasy Adventure" tvg-logo="/images/sintel-poster.jpg",Sintel — Official Trailer (2010)
https://media.w3.org/2010/05/sintel/trailer.mp4
`;
    await db.run('INSERT INTO playlists(id,name,content_encrypted,interval_hours,next_sync,created_at) VALUES(?,?,?,?,?,?)', [playlistId, 'Blender Open Movies · development samples', encrypt(content), 24, Date.now(), Date.now()]);
    const report = await synchronizePlaylist(db, playlistId);
    const catalog = [
      { normalized: 'big buck bunny', synopsis: 'A gentle giant finds his day interrupted by a mischievous trio of forest creatures. Blender’s celebrated open animated short is a warm, wonderfully detailed tale of taking a stand.', year: 2008, duration: 596, director: 'Sacha Goedegebure', poster: '/images/bunny-poster.jpg', backdrop: '/images/bunny-backdrop.jpg', genres: ['Animation', 'Comedy', 'Adventure'], attribution: 'Big Buck Bunny © 2008 Blender Foundation · CC BY 3.0. Official open movie: https://peach.blender.org · W3C/Mux sample delivery.' },
      { normalized: 'tears of steel', synopsis: 'In a future Amsterdam, a group of scientists and soldiers reunite for one last attempt to save the world. Live action and ambitious visual effects meet in Blender’s open science fiction short.', year: 2012, duration: 734, director: 'Ian Hubert', poster: '/images/tears-poster.png', backdrop: '/images/tears-backdrop.jpg', genres: ['Sci-Fi', 'Action', 'Drama'], attribution: 'Tears of Steel © 2012 Blender Foundation · CC BY 3.0. Official open movie: https://mango.blender.org · Authorized Mux test stream.' },
      { normalized: 'sintel official trailer', synopsis: 'The official 52-second trailer for Sintel, Blender’s open fantasy adventure about a young woman searching for a lost dragon. This development sample is a trailer, rather than the full film.', year: 2010, duration: 52, director: 'Colin Levy', poster: '/images/sintel-poster.jpg', backdrop: '/images/sintel-backdrop.png', genres: ['Animation', 'Fantasy', 'Adventure'], attribution: 'Sintel trailer © 2010 Blender Foundation · CC BY 3.0. Official open movie: https://durian.blender.org · W3C sample delivery.' },
    ];
    for (const film of catalog) await db.run('UPDATE titles SET synopsis=?,poster=?,backdrop=?,genres=?,duration=?,director=?,demo=1,featured=?,attribution=? WHERE normalized=? AND year=?', [film.synopsis, film.poster, film.backdrop, JSON.stringify(film.genres), film.duration, film.director, film.normalized === 'tears of steel' ? 1 : 0, film.attribution, film.normalized, film.year]);
    // The second BBB entry keeps the same external identity; it is deliberately another source.
    const bunny = await db.get("SELECT id FROM titles WHERE normalized='big buck bunny' AND year=2008");
    if (bunny) await db.run('UPDATE sources SET name=? WHERE title_id=? AND format=?', ['Mux · HLS', bunny.id, 'hls']);
    await db.run('UPDATE sources SET name=? WHERE playlist_id=? AND format=?', ['W3C · MP4', playlistId, 'mp4']);
    console.log(JSON.stringify({ event: 'sample.imported', report, notice: 'Sources remain unknown until the independent worker verifies actual manifests and media bytes.' }));
  }
  await db.close(); console.log('Database initialized. npm run dev starts local background verification automatically; production uses its separate worker service.');
}
main().catch(error => { console.error(sanitizeError(error)); process.exitCode = 1; });
