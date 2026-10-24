'use client';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { cva } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Check, Copy, AlertCircle, ArrowRight, FileSearch, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
export function cn(...v: Parameters<typeof clsx>) { return twMerge(clsx(v)); }
const badgeVariants = cva('badge', { variants: { tone: { neutral: 'badge-neutral', green: 'badge-green', red: 'badge-red', amber: 'badge-amber', purple: 'badge-purple', blue: 'badge-blue' } }, defaultVariants: { tone: 'neutral' } });
export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'green' | 'red' | 'amber' | 'purple' | 'blue'; title?: string }) { return <span title={title} className={badgeVariants({ tone })}>{children}</span>; }
export function NotRecorded() { return <span className="not-recorded">Not recorded</span>; }
export function Value({ value }: { value: unknown }) { if (value === undefined || value === null || value === '') return <NotRecorded />; return typeof value === 'object' ? <pre className="inline-json">{JSON.stringify(value, null, 2)}</pre> : <span>{String(value)}</span>; }
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState(false);
  return <button className="icon-button" aria-label={copied ? 'Copied' : label} title={error ? 'Clipboard unavailable' : label} onClick={async e => { e.stopPropagation(); try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setError(true); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}
export function RunId({ id }: { id: string }) { return <span className="run-id"><span title={id} className="mono">{id.slice(0, 8)}</span><CopyButton value={id} label="Copy full run ID" /></span>; }
export function EmptyState({ title = 'No runs match these filters', description = 'Try another app or experiment, or clear your filters.', action }: { title?: string; description?: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-icon"><FileSearch size={25} /></div><h3>{title}</h3><p>{description}</p>{action}</div>; }
export function ErrorState({ message, retry }: { message: string; retry: () => void }) { return <div role="alert" className="error-banner"><AlertCircle size={18} /><div><strong>Couldn’t refresh the data</strong><p>{message} Previously loaded data, if any, remains below.</p></div><button className="button secondary" onClick={retry}>Retry</button></div>; }
export function Skeleton({ rows = 3 }: { rows?: number }) { return <div aria-label="Loading data" aria-busy="true" className="skeleton-group">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" />)}</div>; }
export function SectionHeading({ title, caption, action }: { title: string; caption?: string; action?: ReactNode }) { return <div className="section-heading"><div><h2>{title}</h2>{caption && <p>{caption}</p>}</div>{action}</div>; }
export function Sheet({ trigger, title, description, children }: { trigger: ReactNode; title: string; description?: string; children: ReactNode }) { const [open, setOpen] = useState(false); return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild>{trigger}</Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content"><div className="section-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><button className="icon-button" aria-label="Close dialog"><X size={20} /></button></Dialog.Close></div><Dialog.Description className="muted">{description || 'Select options below.'}</Dialog.Description><div onClickCapture={event => { if ((event.target as HTMLElement).closest("a[href]")) setOpen(false); }}>{children}</div></Dialog.Content></Dialog.Portal></Dialog.Root>; }
export function ArrowLink() { return <ArrowRight size={15} aria-hidden />; }
export function DateLabel({ date }: { date: string | null }) {
  if (!date) return <NotRecorded />; const d = new Date(date); if (Number.isNaN(d.valueOf())) return <NotRecorded />;
  const minutes = Math.max(0, Math.floor((Date.now() - d.valueOf()) / 60000));
  const text = minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : minutes < 10080 ? `${Math.floor(minutes / 1440)} d ago` : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return <time title={d.toLocaleString('en-IN', { timeZoneName: 'short' })} dateTime={date}>{text}</time>;
}
