'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Bookmark, Check, CircleAlert, Clock3, Globe2, History, LoaderCircle, LogOut, MonitorPlay, Play, Settings2, ShieldCheck, Star, Trash2 } from 'lucide-react';
import Nav, { Footer } from '../../components/Nav';
import AuthModal from '../../components/AuthModal';
import TitleCard from '../../components/TitleCard';
import { api } from '../../lib/client';
import { clearGuestProgress, migrateGuestProgress, readGuestProgress } from '../../lib/progress';
import type { Progress, Title, User } from '../../lib/types';
import '../../components/account.css';

interface HistoryEntry extends Progress { titleName: string; }
interface Preferences { autoplay: boolean; language: string; }
type AccountTitle = Title & { available?: boolean };
const time = (value: number) => `${Math.floor(value / 3600) ? `${Math.floor(value / 3600)}:` : ''}${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(Math.floor(value) % 60).padStart(2, '0')}`;

export default function AccountPage() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authOpen, setAuthOpen] = useState(false);
  const [tab, setTab] = useState<'watching' | 'list' | 'favorites' | 'history' | 'preferences'>('watching');
  const [progress, setProgress] = useState<Progress[]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [titles, setTitles] = useState<Record<string, AccountTitle>>({});
  const [preferences, setPreferences] = useState<Preferences>({ autoplay: true, language: 'en' });
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [migrationConsent, setMigrationConsent] = useState(false);
  const [guestCount, setGuestCount] = useState(0);
  const authRevisionRef = useRef(0);
  const authOpenRef = useRef(authOpen); authOpenRef.current = authOpen;
  const loadRevisionRef = useRef(0);

  const load = useCallback(async (accountUser: User | null) => {
    const revision = ++loadRevisionRef.current;
    setLoading(true); setError('');
    try {
    const guestProgress = readGuestProgress(); setGuestCount(guestProgress.length);
    let currentProgress = guestProgress, currentIds: string[] = [], currentHistory: HistoryEntry[] = [], currentFavorites: string[] = [];
    const library: Record<string, AccountTitle> = {};
    if (!accountUser) { try { const stored: unknown = JSON.parse(localStorage.getItem('luma.list.v1') || '[]'); if (Array.isArray(stored)) currentIds = stored.filter((value): value is string => typeof value === 'string'); } catch { /* Browser storage can be unavailable. */ } }
    if (accountUser) {
      const results = await Promise.allSettled([api<{ progress: Progress[] }>('/progress'), api<{ ids: string[] }>('/list'), api<{ history: HistoryEntry[] }>('/history'), api<{ preferences: Preferences }>('/preferences'), api<{ ids: string[] }>('/favorites'), api<{ titles: AccountTitle[] }>('/library')]);
      if (revision !== loadRevisionRef.current) return;
      if (results[0].status === 'fulfilled') currentProgress = results[0].value.progress; else currentProgress = [];
      if (results[1].status === 'fulfilled') currentIds = results[1].value.ids;
      if (results[2].status === 'fulfilled') currentHistory = results[2].value.history;
      if (results[3].status === 'fulfilled') { setPreferences(results[3].value.preferences); setPreferencesLoaded(true); }
      if (results[4].status === 'fulfilled') currentFavorites = results[4].value.ids;
      if (results[5].status === 'fulfilled') results[5].value.titles.forEach(title => { library[title.id] = title; });
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') setError(failed.reason instanceof Error ? failed.reason.message : 'Some account data could not be loaded.');
    }
    setProgress(currentProgress); setIds(currentIds); setHistory(currentHistory); setFavorites(currentFavorites);
    if (accountUser) { setTitles(library); setLoading(false); return; }
    const titleIds = [...new Set([...currentProgress.map(value => value.titleId), ...currentIds, ...currentFavorites, ...currentHistory.map(value => value.titleId)])].slice(0, 100);
    const fetched = await Promise.allSettled(titleIds.map(id => api<{ title: Title }>(`/titles/${id}`)));
    if (revision !== loadRevisionRef.current) return;
    const nextTitles: Record<string, Title> = {};
    fetched.forEach(result => { if (result.status === 'fulfilled') nextTitles[result.value.title.id] = result.value.title; });
    setTitles(nextTitles); setLoading(false);
    } catch (reason) { if (revision === loadRevisionRef.current) setError(reason instanceof Error ? reason.message : 'Your account data could not be loaded. Please try again.'); }
    finally { if (revision === loadRevisionRef.current) setLoading(false); }
  }, []);

  useEffect(() => {
    let mounted = true; const revision = authRevisionRef.current;
    const authenticated = (event: Event) => { if (!mounted) return; authRevisionRef.current++; const accountUser = (event as CustomEvent<User | null>).detail; setUser(accountUser); if (!authOpenRef.current) void load(accountUser); };
    window.addEventListener('luma-auth', authenticated);
    api<{ user: User | null }>('/auth/me').then(async data => { if (mounted && revision === authRevisionRef.current) { setUser(data.user); await load(data.user); } }).catch(reason => { if (mounted && revision === authRevisionRef.current) { setError(reason.message); setLoading(false); } });
    return () => { mounted = false; loadRevisionRef.current++; window.removeEventListener('luma-auth', authenticated); };
  }, [load]);
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 5000); return () => clearTimeout(timer); }, [message]);

  async function removeSaved(id: string) { setError(''); try { const next = ids.filter(value => value !== id); if (user) await api(`/list?titleId=${id}`, { method: 'DELETE' }); else localStorage.setItem('luma.list.v1', JSON.stringify(next)); setIds(next); setMessage('Removed from My List.'); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update My List.'); } }
  async function toggleFavorite(id: string) { if (!user) { setAuthOpen(true); return; } setError(''); const exists = favorites.includes(id); try { await api(`/favorites${exists ? `?titleId=${id}` : ''}`, { method: exists ? 'DELETE' : 'POST', ...(exists ? {} : { body: JSON.stringify({ titleId: id }) }) }); setFavorites(values => exists ? values.filter(value => value !== id) : [...values, id]); setMessage(exists ? 'Removed from favorites.' : 'Added to favorites.'); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update favorites.'); } }
  async function savePreferences(event: React.FormEvent) { event.preventDefault(); setPending(true); setError(''); try { const data = await api<{ preferences: Preferences }>('/preferences', { method: 'PATCH', body: JSON.stringify(preferences) }); setPreferences(data.preferences); setMessage('Your playback preferences are saved.'); window.dispatchEvent(new CustomEvent('luma-preferences', { detail: data.preferences })); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save preferences.'); } finally { setPending(false); } }
  async function logout() { setPending(true); setError(''); try { await api('/auth/logout', { method: 'POST' }); window.location.assign('/'); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not sign out.'); setPending(false); } }
  async function transfer() { if (!migrationConsent) return; setPending(true); setError(''); try { const count = await migrateGuestProgress(); setMessage(`${count} viewing ${count === 1 ? 'record' : 'records'} transferred.`); setMigrationConsent(false); await load(user); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not transfer progress.'); } finally { setPending(false); } }

  const watching = progress.filter(value => value.position > 0 && value.position / value.duration < .95).sort((a, b) => b.updatedAt - a.updatedAt);
  return <><Nav active="account" /><main className="account-main"><div className="account-heading"><div><div className="account-eyebrow">YOUR CORNER OF LUME</div><h1>{user ? `Good to see you, ${user.name.split(' ')[0]}.` : 'Great stories. Your own pace.'}</h1><p>{user ? 'Your collection, your place in the story, and your viewing preferences.' : 'Your progress stays in this browser. Create an account to pick up on any device.'}</p></div>{user ? <button className="account-button" disabled={pending} onClick={logout}><LogOut size={15} />Sign out</button> : <button className="account-button primary" onClick={() => setAuthOpen(true)}>Sign in or create an account <ArrowRight size={16} /></button>}</div>
    {error && <div className="account-alert" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
    {user && <div className="account-profile"><span className="account-avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><h2>{user.name}</h2><p>{user.email}</p></div><span className="account-member"><ShieldCheck size={14} />Your progress syncs across devices</span>{(user.role === 'admin' || user.role === 'editor') && <Link href="/admin" className="account-admin-link">Control room <ArrowRight size={13} /></Link>}</div>}
    {!user && <div className="account-guest-note"><MonitorPlay size={20} /><div><strong>Watching as a guest</strong><p>Watch history is saved on this device and may disappear if browser storage is cleared. You can transfer it to your account with your consent.</p></div></div>}
    <div className="account-tabs" role="tablist" aria-label="Account sections">{[{ id: 'watching', label: 'Continue watching', icon: Play }, { id: 'list', label: 'My List', icon: Bookmark }, { id: 'favorites', label: 'Favorites', icon: Star }, { id: 'history', label: 'Watch history', icon: History }, { id: 'preferences', label: 'Preferences', icon: Settings2 }].map(item => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id as typeof tab)}><item.icon size={15} />{item.label}{item.id === 'watching' && watching.length > 0 && <span>{watching.length}</span>}{item.id === 'list' && ids.length > 0 && <span>{ids.length}</span>}</button>)}</div>
    {loading ? <div className="account-loading"><LoaderCircle className="spin" size={24} /><span>Bringing your collection together…</span></div> : <>
      {tab === 'watching' && <>{watching.length ? <div className="account-card-grid">{watching.map(entry => titles[entry.titleId] && titles[entry.titleId].available !== false ? <div key={`${entry.titleId}-${entry.episodeId || ''}`}><TitleCard title={titles[entry.titleId]} progress={entry} landscape /><Link className="account-resume" href={`/watch/${entry.titleId}${entry.episodeId ? `?episodeId=${entry.episodeId}` : ''}`}><Play size={13} fill="currentColor" />Resume at {time(entry.position)} <ArrowRight size={13} /></Link></div> : <div key={`${entry.titleId}-${entry.episodeId || ''}`} className="account-unavailable"><CircleAlert size={22} /><h3>{titles[entry.titleId]?.name || history.find(value => value.titleId === entry.titleId)?.titleName || 'Title currently unavailable'}</h3><p>Your place at {time(entry.position)} is preserved. It will become playable when a verified source returns.</p></div>)}</div> : <AccountEmpty icon={Play} title="Your next story starts here." description="Start watching a title and your place in the story will appear here." />}</>}
      {tab === 'list' && <>{ids.length ? <div className="account-card-grid posters">{ids.map(id => titles[id] && titles[id].available !== false ? <div key={id}><TitleCard title={titles[id]} saved onSave={removeSaved} /><button className="account-favorite-button" onClick={() => toggleFavorite(id)}><Star size={13} fill={favorites.includes(id) ? 'currentColor' : 'none'} />{favorites.includes(id) ? 'Favorited' : 'Add to favorites'}</button></div> : <div className="account-unavailable" key={id}><Bookmark size={22} /><h3>{titles[id]?.name || 'Saved title unavailable'}</h3><p>This title stays saved while its sources are unavailable.</p><button onClick={() => removeSaved(id)}><Trash2 size={13} />Remove from My List</button></div>)}</div> : <AccountEmpty icon={Bookmark} title="Save a little inspiration." description="Add titles to My List while browsing. They’ll be waiting here." />}</>}
      {tab === 'favorites' && <>{!user ? <AccountEmpty icon={Star} title="The stories you love." description="Sign in to save favorites across your devices. Add favorites from titles in My List." action={() => setAuthOpen(true)} /> : favorites.length ? <div className="account-card-grid posters">{favorites.map(id => titles[id] && titles[id].available !== false ? <div key={id}><TitleCard title={titles[id]} /><button className="account-favorite-button" onClick={() => toggleFavorite(id)}><Star size={13} fill="currentColor" />Remove favorite</button></div> : <div className="account-unavailable" key={id}><Star size={22} /><h3>{titles[id]?.name || 'Favorite currently unavailable'}</h3><p>Your favorite stays saved while sources are unavailable.</p><button onClick={() => toggleFavorite(id)}>Remove favorite</button></div>)}</div> : <AccountEmpty icon={Star} title="Keep your favorites close." description="Mark a saved title as a favorite from My List and it will appear here." />}</>}
      {tab === 'history' && <>{(user ? history : progress).length ? <div className="account-history">{(user ? history : progress).map((entry, index) => <div key={`${entry.titleId}-${entry.updatedAt}-${index}`}><span className="account-history-icon"><Clock3 size={19} /></span><div><h3>{titles[entry.titleId]?.name || ('titleName' in entry ? String(entry.titleName) : 'Previously watched title')}</h3><p>{time(entry.position)} / {time(entry.duration)}{entry.episodeId ? ' · Episode progress' : ''}</p></div><time>{new Date(entry.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>{titles[entry.titleId] && titles[entry.titleId].available !== false && <Link href={`/title/${entry.titleId}`} aria-label={`View ${titles[entry.titleId].name}`}><ArrowRight size={17} /></Link>}</div>)}</div> : <AccountEmpty icon={History} title="Your story so far." description="Your recent viewing activity will appear here when you start watching." />}{!user && progress.length > 0 && <button className="account-clear-history" onClick={() => { if (window.confirm('Clear all guest watch progress from this browser?')) { clearGuestProgress(); load(null); } }}><Trash2 size={14} />Clear this browser’s watch history</button>}</>}
      {tab === 'preferences' && <>{user ? <form className="account-preferences" onSubmit={savePreferences}><div className="account-preference-row"><div><h3>Keep the story going</h3><p>Automatically play the next available episode when an episode ends.</p></div><label className="account-toggle"><input type="checkbox" checked={preferences.autoplay} onChange={event => setPreferences(value => ({ ...value, autoplay: event.target.checked }))} aria-label="Autoplay next episode" disabled={!preferencesLoaded} /><span /></label></div><div className="account-preference-row"><div><h3>Preferred subtitle language</h3><p>Used when the selected stream provides matching subtitle tracks.</p></div><select value={preferences.language} onChange={event => setPreferences(value => ({ ...value, language: event.target.value }))} aria-label="Preferred subtitle language" disabled={!preferencesLoaded}><option value="off">Subtitles off</option><option value="en">English</option><option value="hu">Hungarian</option><option value="de">German</option><option value="fr">French</option><option value="es">Spanish</option><option value="it">Italian</option><option value="pt">Portuguese</option><option value="ja">Japanese</option><option value="ko">Korean</option><option value="zh">Chinese</option></select></div><div className="account-preference-footer"><span><Globe2 size={14} />Saved to your account</span><button className="account-button primary" disabled={pending || !preferencesLoaded}>{pending && <LoaderCircle className="spin" size={14} />}Save preferences</button></div></form> : <AccountEmpty icon={Settings2} title="Make it your kind of movie night." description="Sign in to save playback preferences to your account." action={() => setAuthOpen(true)} />}</>}
    </>}
    {user && guestCount > 0 && <div className="account-migration"><div><MonitorPlay size={22} /><div><h3>You have watch progress on this browser.</h3><p>Transfer {guestCount} local viewing {guestCount === 1 ? 'record' : 'records'} to your account. The most recently updated progress is kept.</p></div></div><label><input type="checkbox" checked={migrationConsent} onChange={event => setMigrationConsent(event.target.checked)} />I agree to transfer my browser watch history.</label><button className="account-button primary" onClick={transfer} disabled={!migrationConsent || pending}>{pending ? <LoaderCircle className="spin" size={14} /> : <ArrowRight size={14} />}Transfer progress</button></div>}
  </main><Footer />{message && <div className="account-toast" role="status"><Check size={16} />{message}</div>}<AuthModal open={authOpen} onClose={() => setAuthOpen(false)} onAuthenticated={async authenticated => { setUser(authenticated); await load(authenticated); }} /></>;
}

function AccountEmpty({ icon: Icon, title, description, action }: { icon: typeof Play; title: string; description: string; action?: () => void }) { return <div className="account-empty"><span><Icon size={28} /></span><h2>{title}</h2><p>{description}</p>{action ? <button className="account-button primary" onClick={action}>Sign in <ArrowRight size={15} /></button> : <Link href="/" className="account-button">Find your next watch <ArrowRight size={15} /></Link>}</div>; }
