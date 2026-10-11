'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Film, LoaderCircle, X } from 'lucide-react';
import type { User } from '../lib/types';
import { migrateGuestProgress, readGuestProgress } from '../lib/progress';
import { api, RequestError } from '../lib/client';
import './auth.css';

interface Props { open: boolean; onClose: () => void; onAuthenticated?: (user: User) => void | Promise<void>; }

export default function AuthModal({ open, onClose, onAuthenticated }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [hasGuestProgress, setHasGuestProgress] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [signedInUser, setSignedInUser] = useState<User | null>(null);
  const [migrationError, setMigrationError] = useState('');
  const [followUp, setFollowUp] = useState<'migration' | 'account'>('migration');
  const requestRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(pending);
  const closeRef = useRef(onClose);
  pendingRef.current = pending;
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) { setPassword(''); return; }
    setHasGuestProgress(readGuestProgress().length > 0);
    setConsent(false);
    setError(''); setSignedInUser(null); setMigrationError('');
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingRef.current) closeRef.current();
      if (event.key !== 'Tab') return;
      const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]');
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { requestRef.current?.abort(); document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, [open]);

  async function finish(user: User) {
    try { await onAuthenticated?.(user); }
    catch {
      setSignedInUser(user); setFollowUp('account');
      setMigrationError('You are signed in, but your account page could not refresh. You can retry opening it.');
      return;
    }
    onClose();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (pendingRef.current) return; pendingRef.current = true; setError(''); setPending(true);
    const controller = new AbortController(); requestRef.current = controller;
    let authenticated: User | null = null;
    try {
      const data = await api<{ user: User }>(`/auth/${mode}`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ email: email.trim(), password, ...(mode === 'register' ? { name: name.trim() } : {}) }) });
      if (!data.user || typeof data.user.id !== 'string' || typeof data.user.name !== 'string' || typeof data.user.email !== 'string' || !['admin', 'editor', 'user'].includes(data.user.role)) throw new RequestError('Sign-in returned an incomplete account response. Please try again.', 200, 'invalid_response');
      authenticated = data.user;
      setPassword('');
      setSignedInUser(data.user); setFollowUp(consent && hasGuestProgress ? 'migration' : 'account');
      window.dispatchEvent(new CustomEvent('luma-auth', { detail: data.user }));
      if (consent && hasGuestProgress) {
        setSignedInUser(data.user); setFollowUp('migration');
        try {
          await migrateGuestProgress();
          if (readGuestProgress().length > 0) { setSignedInUser(data.user); setMigrationError('Some viewing records could not be transferred and remain saved in this browser. You can retry or continue to your account.'); return; }
        }
        catch (reason) {
          setSignedInUser(data.user);
          setMigrationError(reason instanceof Error ? reason.message : 'Watch history could not be transferred. Your local progress is still saved.');
          return;
        }
      }
      await finish(data.user);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (authenticated) { setSignedInUser(authenticated); setFollowUp('account'); setMigrationError('You are signed in, but the page could not finish loading. You can continue to your account.'); }
      else setError(reason instanceof Error ? reason.message : 'We could not sign you in. Please try again.');
    }
    finally { pendingRef.current = false; setPending(false); if (requestRef.current === controller) requestRef.current = null; }
  }

  async function retryMigration() {
    if (pendingRef.current) return; pendingRef.current = true;
    setPending(true); setMigrationError('');
    try { await migrateGuestProgress(); if (readGuestProgress().length > 0) { setMigrationError('Some viewing records remain saved in this browser. You can retry or continue without transferring them.'); return; } if (signedInUser) await finish(signedInUser); }
    catch (reason) { setMigrationError(reason instanceof Error ? reason.message : 'Transfer failed. Your local progress remains saved.'); }
    finally { pendingRef.current = false; setPending(false); }
  }

  async function retryAccount() {
    if (pendingRef.current || !signedInUser) return; pendingRef.current = true; setPending(true); setMigrationError('');
    try { await finish(signedInUser); }
    finally { pendingRef.current = false; setPending(false); }
  }

  if (!open) return null;
  return <div className="auth-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <div className="auth-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-busy={pending} aria-labelledby="auth-heading">
      <button className="auth-close" onClick={onClose} disabled={pending} aria-label="Close sign in"><X size={20} /></button>
      <div className="auth-mark"><Film size={26} /> <span>lume<span className="auth-dot">.</span></span></div>
      <div className="auth-eyebrow">YOUR NEXT GREAT WATCH</div>
      <h2 id="auth-heading">{signedInUser ? 'You’re signed in.' : mode === 'login' ? 'Welcome back.' : 'Make yourself at home.'}</h2>
      <p className="auth-description">{signedInUser ? followUp === 'migration' ? 'Your browser history is safe. Transferring it is optional.' : 'Your sign-in succeeded. Your account data can be loaded separately.' : 'Keep your place, save your favorites, and pick up on any device.'}</p>
      {signedInUser ? <div className="auth-transfer">
        {migrationError && <div className="auth-error" role="alert">{migrationError}</div>}
        <button className="auth-submit" disabled={pending} onClick={() => followUp === 'migration' ? retryMigration() : retryAccount()}>{pending ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />} {pending ? 'One moment…' : followUp === 'migration' ? 'Retry history transfer' : 'Open my account'}</button>
        <button className="auth-secondary" disabled={pending} onClick={() => followUp === 'migration' ? finish(signedInUser) : onClose()}>{followUp === 'migration' ? 'Continue without transferring' : 'Continue browsing'}</button>
      </div> : <>
        <div className="auth-tabs"><button disabled={pending} className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>Sign in</button><button disabled={pending} className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>Create account</button></div>
        <form onSubmit={submit}>
          {mode === 'register' && <label className="auth-field">Your name<input name="name" required maxLength={80} autoComplete="name" placeholder="Alex" value={name} onChange={event => setName(event.target.value)} disabled={pending} /></label>}
          <label className="auth-field">Email address<input name="email" type="email" required maxLength={254} autoComplete="email" placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)} disabled={pending} /></label>
          <label className="auth-field">Password<input name="password" type="password" required minLength={mode === 'register' ? 12 : 1} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} placeholder={mode === 'register' ? 'At least 12 characters' : 'Your password'} value={password} onChange={event => setPassword(event.target.value)} disabled={pending} /></label>
          {hasGuestProgress && <label className="auth-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={pending} /><span>Transfer my watch progress from this browser to my account.</span></label>}
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button className="auth-submit" type="submit" disabled={pending}>{pending ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />} {pending ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <div className="auth-guest"><Check size={15} /><span>You can always browse and watch as a guest.</span></div>
      </>}
    </div>
  </div>;
}
