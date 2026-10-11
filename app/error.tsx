'use client';
export default function Error({reset}:{reset:()=>void}){return <main className="empty-state detail-empty"><h1>A brief intermission.</h1><p>Something went wrong loading this page.</p><button className="button primary" onClick={reset}>Try again</button></main>}
