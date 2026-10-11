'use client';
import { useState, type CSSProperties } from 'react';
import Image from 'next/image';
import { Film, Radio } from 'lucide-react';
import { artworkCandidates } from '@/lib/artwork';
import type { Title } from '@/lib/types';

interface Props { title: Pick<Title, 'id' | 'name' | 'type' | 'poster' | 'backdrop'>; landscape?: boolean; hero?: boolean; decorative?: boolean; }
export default function TitleArtwork(props: Props) {
  const candidates = artworkCandidates(props.title, props.landscape || props.hero);
  return <Artwork key={`${props.title.id}:${candidates.join('|')}`} {...props} candidates={candidates} />;
}
function Artwork({ title, candidates, hero, decorative, landscape }: Props & { candidates: string[] }) {
  const [attempt, setAttempt] = useState(0);
  const src = candidates[attempt];
  const hue = [...title.name].reduce((sum, letter) => (sum * 31 + letter.charCodeAt(0)) % 360, 0);
  return <div className={`title-artwork ${hero ? 'hero-artwork' : ''} ${title.type === 'live' ? 'channel-artwork' : ''} ${src ? 'has-artwork' : 'missing-artwork'}`} style={{ '--art-hue': hue } as CSSProperties} aria-hidden={decorative || undefined}>
    <div className="artwork-placeholder">{title.type === 'live' ? <Radio size={30} /> : <Film size={30} />}<span>{title.name}</span></div>
    {src && (src.startsWith('/images/') ? <Image src={src} alt={decorative ? '' : title.name} fill sizes={hero ? '100vw' : landscape ? '(max-width:760px) 80vw, 30vw' : '(max-width:760px) 44vw, 18vw'} quality={75} loading={hero ? 'eager' : 'lazy'} onError={() => setAttempt(value => value + 1)} />
      : <img key={src} src={src} alt={decorative ? '' : title.name} loading={hero ? 'eager' : 'lazy'} fetchPriority={hero ? 'high' : undefined} onError={() => setAttempt(value => value + 1)} />)}
  </div>;
}
