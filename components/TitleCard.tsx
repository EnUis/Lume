'use client';
import Link from 'next/link';
import TitleArtwork from './TitleArtwork';
import { Play, Plus, Check } from 'lucide-react';
import type { Progress, Title } from '@/lib/types';
import { minutes } from '@/lib/client';
export default function TitleCard({title,index,onSave,saved,progress,landscape=false}:{title:Title;index?:number;onSave?:(id:string)=>void;saved?:boolean;progress?:Progress;landscape?:boolean}) {
  const live=title.type==='live';
  landscape ||= live;
  return <article className={`title-card ${landscape?'landscape':''} ${live?'channel-card':''}`}><Link href={`/title/${title.id}`} className="card-art" aria-label={`View ${title.name}`}><TitleArtwork title={title} landscape={landscape}/>{live&&<span className="card-tag live-tag"><i/>LIVE</span>}{title.demo&&<span className="card-tag">OPEN FILM</span>}{index!==undefined&&<span className="card-rank">{String(index+1).padStart(2,'0')}</span>}<div className="card-hover"><span className="card-play"><Play size={22} fill="currentColor"/></span><span>{live?'Watch channel':'Explore title'}</span></div>{progress&&<div className="card-progress"><i style={{width:`${Math.min(100,progress.position/progress.duration*100)}%`}}/></div>}</Link><div className="card-caption"><div><Link href={`/title/${title.id}`}><h3>{title.name}</h3></Link><p>{live?'Live channel':progress?`${Math.max(0,Math.round((progress.duration-progress.position)/60))} min left`:[title.year,title.type==='series'?'Series':minutes(title.duration),title.genres?.[0]].filter(Boolean).join(' · ')}</p></div>{onSave&&<button className={`card-save ${saved?'saved':''}`} aria-label={saved?`Remove ${title.name} from My List`:`Add ${title.name} to My List`} onClick={()=>onSave(title.id)}>{saved?<Check size={16}/>:<Plus size={17}/>}</button>}</div></article>;
}
