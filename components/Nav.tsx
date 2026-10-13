'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Search, Menu, X, UserRound, ArrowUpRight } from 'lucide-react';
import AuthModal from './AuthModal';
import type { User } from '@/lib/types';
import { api } from '@/lib/client';
export default function Nav({active='home',onSearch,query=''}:{active?:string;onSearch?:(value:string)=>void;query?:string}) {
  const [user,setUser]=useState<User|null>(null),[auth,setAuth]=useState(false),[search,setSearch]=useState(Boolean(query)),[mobile,setMobile]=useState(false),[value,setValue]=useState(query);
  const headerRef=useRef<HTMLElement>(null);
  useEffect(()=>{let active=true,revision=0;api<{user:User|null}>('/auth/me').then(r=>{if(active&&revision===0)setUser(r.user);}).catch(()=>{});const refresh=(event:Event)=>{revision++;setUser((event as CustomEvent<User|null>).detail);};window.addEventListener('luma-auth',refresh);return()=>{active=false;window.removeEventListener('luma-auth',refresh);};},[]);
  useEffect(()=>setValue(query),[query]);
  useEffect(()=>{
    if(!mobile&&!search)return;
    const closeOnEscape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMobile(false);setSearch(false);}};
    const closeOutside=(event:PointerEvent)=>{if(!headerRef.current?.contains(event.target as Node))setMobile(false);};
    document.addEventListener('keydown',closeOnEscape);
    document.addEventListener('pointerdown',closeOutside);
    return()=>{document.removeEventListener('keydown',closeOnEscape);document.removeEventListener('pointerdown',closeOutside);};
  },[mobile,search]);
  return <><header className="site-header" ref={headerRef}><Link href="/" className="wordmark" aria-label="Lume home">lume<span>✦</span></Link><nav id="main-navigation" className={mobile?'main-nav open':'main-nav'} aria-label="Main navigation">{[['home','Discover','/'],['movie','Movies','/?view=movie'],['series','TV Shows','/?view=series'],['live','Live TV','/?view=live'],['list','My List','/?view=list']].map(([key,name,href])=><Link key={key} className={active===key?'active':''} aria-current={active===key?'page':undefined} href={href} onClick={()=>setMobile(false)}>{name}</Link>)}</nav><div className="header-actions">{search?<form className="nav-search" role="search" onSubmit={e=>{e.preventDefault();if(!onSearch)window.location.href=`/?q=${encodeURIComponent(value)}`;}}><Search size={17}/><input autoFocus type="search" enterKeyHint="search" aria-label="Search titles" value={value} placeholder={active==='live'?'Search channels':'Titles, genres, people'} onChange={e=>{setValue(e.target.value);onSearch?.(e.target.value);}}/><button type="button" aria-label="Close search" onClick={()=>{setSearch(false);setValue('');onSearch?.('');}}><X size={16}/></button></form>:<button className="icon-button search-toggle" aria-label="Search" onClick={()=>{setMobile(false);setSearch(true);}}><Search size={21}/></button>}<span className="header-divider"/><button className="profile-button" onClick={()=>{setMobile(false);setSearch(false);if(user)window.location.assign('/account');else setAuth(true);}} aria-label={user?'Your account':'Sign in'}><UserRound size={17}/><span>{user?user.name.split(' ')[0]:'Sign in'}</span></button><button className="mobile-menu icon-button" aria-label={mobile?"Close menu":"Open menu"} aria-controls="main-navigation" aria-expanded={mobile} onClick={()=>{setSearch(false);setMobile(!mobile);}}>{mobile?<X/>:<Menu/>}</button></div></header><AuthModal open={auth} onClose={()=>setAuth(false)} onAuthenticated={authenticated=>{setUser(authenticated);setAuth(false);}}/></>;
}
export function Footer(){return <footer className="site-footer"><div><Link className="wordmark" href="/">lume<span>✦</span></Link><p>A little wonder. A lot to watch.</p></div><div className="footer-links"><Link href="/about">About & credits <ArrowUpRight size={13}/></Link><Link href="/account">Your account</Link><Link href="/admin">Manage library</Link></div><div className="footer-meta"><span>© {new Date().getFullYear()} Lume</span><span>Made for the love of stories.</span></div></footer>}
