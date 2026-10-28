'use client';
import { useState } from 'react';
import { Search } from 'lucide-react';
import { CopyButton } from './ui';
export function JsonViewer({ value }: { value: unknown }) {
  const [query, setQuery] = useState(''); const text = JSON.stringify(value, null, 2) ?? 'null';
  function node(v: unknown, name: string, depth: number): React.ReactNode {
    if (query && !`${name} ${JSON.stringify(v)}`.toLowerCase().includes(query.toLowerCase())) return null;
    if (v && typeof v === 'object') {
      const entries = Object.entries(v); return <details key={name} open={depth < 1 || !!query} className="json-node"><summary><strong>{name}</strong> <span>{Array.isArray(v) ? `[${entries.length} items]` : `{${entries.length} fields}`}</span></summary><div>{entries.length ? entries.map(([key, val]) => node(val, key, depth + 1)) : <code>{Array.isArray(v) ? '[]' : '{}'}</code>}</div></details>;
    }
    return <div key={name} className="json-leaf"><span>{name}:</span> <code>{JSON.stringify(v)}</code></div>;
  }
  return <div className="json-viewer"><div className="table-toolbar"><label className="search-control"><Search size={15} /><input value={query} onChange={e => setQuery(e.target.value)} aria-label="Search JSON" placeholder="Search fields and values…" /></label><CopyButton value={text} label="Copy JSON" /></div><div className="json-tree">{query && !text.toLowerCase().includes(query.toLowerCase()) ? <p className="muted">No matching values.</p> : node(value, 'run', 0)}</div></div>;
}
