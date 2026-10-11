import Link from 'next/link';
import { connection } from 'next/server';
import Nav, { Footer } from '@/components/Nav';
import { ArrowRight, Film, Heart, Languages } from 'lucide-react';
import '@/lib/server/env';

export default async function About() {
  await connection();
  const tmdbEnabled = !!(process.env.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_API_KEY);
  return <><Nav /><main className="about-page">
    <span className="eyebrow">A LITTLE WONDER. A LOT TO WATCH.</span>
    <h1>Great stories.<br />A place of your own.</h1>
    <p className="about-lead">Discover movies and series, keep your favorites close, and pick up where the story left you.</p>
    <div className="about-grid">
      <section><Film /><h2>Find your next favorite.</h2><p>A collection of movies and series, with artwork and story details to help you choose.</p></section>
      <section><Languages /><h2>Your preferred language.</h2><p>Available language versions sit together under one title. Choose a working version from the player’s language menu.</p></section>
      <section><Heart /><h2>Your story, your device.</h2><p>Watch as a guest or sign in to keep your progress and saved titles across devices.</p></section>
    </div>
    <div className="credit-panel">
      <h2>Artwork &amp; story credits</h2>
      <p>Title pages include the sources of automatically matched artwork and descriptions. Text may be shortened for display; artwork remains credited to its original source.</p>
      <div className="credit-links">
        <a href="https://www.tvmaze.com" target="_blank" rel="noreferrer">TVmaze · series information ↗</a>
        <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">TVmaze &amp; Wikipedia text · CC BY-SA ↗</a>
        <a href="https://www.wikidata.org" target="_blank" rel="noreferrer">Wikidata · CC0 data ↗</a>
        <a href="https://www.wikipedia.org" target="_blank" rel="noreferrer">Wikipedia · title information ↗</a>
        <a href="https://commons.wikimedia.org" target="_blank" rel="noreferrer">Wikimedia Commons · artwork credits ↗</a>
      </div>
      {tmdbEnabled && <div className="tmdb-credit"><a href="https://www.themoviedb.org" target="_blank" rel="noreferrer"><img src="/images/tmdb-logo.svg" width="82" height="60" style={{objectFit:'contain'}} alt="The Movie Database (TMDB)" /></a><p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p></div>}
      <p className="muted">Each image retains its source’s rights and license. Individual credits are available on the title page.</p>
    </div>
    <div className="credit-panel">
      <h2>Open film collection</h2>
      <p>Sample films retain their original creators’ credits and are labeled in the collection.</p>
      <div className="credit-links">
        <a href="https://peach.blender.org/about/" target="_blank" rel="noreferrer">Big Buck Bunny · CC BY 3.0 ↗</a>
        <a href="https://mango.blender.org/about/" target="_blank" rel="noreferrer">Tears of Steel · CC BY 3.0 ↗</a>
        <a href="https://durian.blender.org/about/" target="_blank" rel="noreferrer">Sintel · CC BY 3.0 ↗</a>
        <a href="https://orange.blender.org/" target="_blank" rel="noreferrer">Elephants Dream · CC BY 2.5 ↗</a>
      </div>
    </div>
    <Link href="/" className="button primary">Find your next story <ArrowRight size={18} /></Link>
  </main><Footer /></>;
}
