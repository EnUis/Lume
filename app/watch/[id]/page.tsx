import Player from '@/components/Player';

export default async function WatchPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ episodeId?: string; episode?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <Player titleId={id} initialEpisodeId={query.episodeId ?? query.episode} />;
}
