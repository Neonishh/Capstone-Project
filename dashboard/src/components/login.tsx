'use client';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LockKeyhole, ArrowRight } from 'lucide-react';
import { safeReturnPath } from '@/lib/navigation';
export function Login() {
  const params = useSearchParams(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <div id="page-content" className="login-wrap"><section className="panel login-panel"><span className="export-icon"><LockKeyhole size={25} /></span><div className="eyebrow">TEAM WORKSPACE</div><h1>Back to the evidence.</h1><p className="muted">Sign in with your authorized project account.</p><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); const form = new FormData(e.currentTarget); try { const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); const next = params.get('next') || '/'; window.location.href = safeReturnPath(next, window.location.origin); } catch (e) { setError(e instanceof Error ? e.message : 'Sign-in failed.'); } finally { setBusy(false); } }}><label>Email<input name="email" type="email" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label>{error && <p className="failed-text" role="alert">{error}</p>}<button className="button" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={15} /></button></form><p className="small muted">Local demos use the loopback-only workspace. Hosted access requires a configured team account.</p></section></div>;
}
