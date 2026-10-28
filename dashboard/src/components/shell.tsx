'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, useRef, type ReactNode } from 'react';
import { Grid2X2, RefreshCw, Sun, Moon, Menu, LogOut, ArrowUpRight } from 'lucide-react';
import { Sheet } from './ui';
interface DashboardContext { tick: number; refresh: () => void; reportFetch: (date: string) => void }
const Context = createContext<DashboardContext>({ tick: 0, refresh: () => {}, reportFetch: () => {} });
export const useDashboard = () => useContext(Context);
const links = [['/', 'Overview'], ['/runs', 'Runs'], ['/compare', 'Compare'], ['/exports', 'Exports'], ['/methodology', 'Methodology']];
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname(), router = useRouter();
  const [tick, setTick] = useState(0), [fetched, setFetched] = useState(''), [interval, setIntervalValue] = useState(0), [dark, setDark] = useState(false), [user, setUser] = useState<{ email: string; mode: string } | null>(null);
  const refresh = useCallback(() => setTick(x => x + 1), []), reportFetch = useCallback((v: string) => setFetched(v), []);
  useEffect(() => { setDark(document.documentElement.dataset.theme === 'dark'); }, []);
  useEffect(() => { if (!interval) return; const timer = window.setInterval(refresh, interval * 60000); return () => window.clearInterval(timer); }, [interval, refresh]);
  useEffect(() => { if (path === '/login') return; let active = true; fetch('/api/auth/session').then(async r => { if (r.status === 401) { router.replace(`/login?next=${encodeURIComponent(path)}`); return; } if (r.ok && active) setUser(await r.json()); }).catch(() => {}); return () => { active = false; }; }, [path, router]);
  return <Context.Provider value={{ tick, refresh, reportFetch }}><div className="app-shell"><header className="site-header"><div className="header-inner"><Link href="/" className="brand"><span className="brand-mark"><Grid2X2 size={22} /></span><span>Capstone<span className="brand-sub">QA Observatory</span></span></Link><nav className="desktop-nav" aria-label="Main navigation">{links.map(([href, label]) => <Link key={href} href={href} className={(href === '/' ? path === '/' : path.startsWith(href)) ? 'active' : ''}>{label}</Link>)}</nav><div className="header-actions"><button className="icon-button" title="Refresh data" aria-label="Refresh data" onClick={refresh}><RefreshCw size={17} /></button><button className="icon-button" aria-label="Toggle color theme" onClick={() => { const value = !dark; setDark(value); document.documentElement.dataset.theme = value ? 'dark' : 'light'; localStorage.setItem('dashboard-theme', value ? 'dark' : 'light'); }}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button><span className="user-avatar" title={user?.email || 'Workspace'}>C</span><div className="mobile-nav"><Sheet title="Navigate" trigger={<button className="icon-button" aria-label="Open navigation"><Menu size={22} /></button>}><nav className="sheet-nav">{links.map(([href, label]) => <Link key={href} href={href}>{label}<ArrowUpRight size={16} /></Link>)}</nav></Sheet></div></div></div></header><main className="main-content">{children}</main><footer className="site-footer"><span><span className={`connection-dot ${fetched ? 'connected' : ''}`} />{fetched ? `Last fetched ${new Date(fetched).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Waiting for data'}<span className="footer-divider">/</span>{user?.mode === 'local' ? 'Local workspace' : 'Team workspace'}</span><div className="footer-tools"><label>Auto-refresh <select aria-label="Auto-refresh interval" value={interval} onChange={e => setIntervalValue(Number(e.target.value))}><option value={0}>Off</option><option value={1}>1 min</option><option value={5}>5 min</option><option value={15}>15 min</option></select></label>{user?.mode === 'supabase' && <button className="text-button" onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/login'; }}><LogOut size={14} /> Sign out</button>}</div></footer></div></Context.Provider>;
}
export function useApi<T>(url: string) {
  const { tick, reportFetch, refresh } = useDashboard(); const router = useRouter();
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const previousPath = useRef(url.split('?')[0]);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError('');
    if (previousPath.current !== url.split('?')[0]) setData(null);
    previousPath.current = url.split('?')[0];
    fetch(url, { signal: controller.signal }).then(async response => {
      if (response.status === 401) { router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`); throw new Error('Please sign in.'); }
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Request failed.');
      setData(body); if (body.fetchedAt) reportFetch(body.fetchedAt);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message || 'Connection failed.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [url, tick, router, reportFetch]);
  return { data, error, loading, refresh };
}
