'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from '@tanstack/react-table';
import { ArrowDownUp, ArrowUpRight } from 'lucide-react';
import type { Summary } from '@/lib/types';
import { explorationLabel, executionLabel, rateLabel } from '@/lib/metrics';
import { Badge, DateLabel, NotRecorded, RunId } from './ui';
export function RunsTable({ rows, selected = [], onSelect, onSort }: { rows: Summary[]; selected?: string[]; onSelect?: (id: string) => void; onSort?: (sort: string) => void }) {
  const router = useRouter();
  const columns = useMemo<ColumnDef<Summary>[]>(() => [
    ...(onSelect ? [{ id: 'select', header: 'Select', cell: ({ row }: { row: { original: Summary } }) => <input type="checkbox" aria-label={`Select run ${row.original.run_id}`} checked={selected.includes(row.original.run_id)} onClick={e => e.stopPropagation()} onChange={() => onSelect(row.original.run_id)} /> }] : []),
    { accessorKey: 'created_at', header: () => <button className="sort-button" onClick={() => onSort?.('date_desc')}>Date <ArrowDownUp size={12} /></button>, cell: ({ row }) => <div className="date-cell"><DateLabel date={row.original.created_at} /><RunId id={row.original.run_id} /></div> },
    { accessorKey: 'app_id', header: 'Application', cell: ({ row }) => <div className="app-cell"><strong>{row.original.app_id}</strong><span title={row.original.comparison_id}>{row.original.comparison_id}</span></div> },
    { id: 'architecture', header: 'Architecture', cell: ({ row }) => <Badge tone={row.original.architecture === 'B' ? 'purple' : 'blue'}>{row.original.platform === 'web' ? 'Web' : 'Mobile'} {row.original.architecture}</Badge> },
    { accessorKey: 'model', header: 'Model', cell: ({ row }) => row.original.model ? <span className="model-name">{row.original.model}</span> : <NotRecorded /> },
    { id: 'exploration', header: 'Exploration', cell: ({ row }) => <Badge title={`stop_reason: ${row.original.exploration_stop_reason ?? 'null'}; exploration_complete: ${row.original.exploration_complete ?? 'null'}`} tone={row.original.exploration_complete === true ? 'green' : row.original.exploration_complete === false ? 'amber' : 'neutral'}>{explorationLabel(row.original)}</Badge> },
    { id: 'execution', header: 'Execution', cell: ({ row }) => <span className="execution-cell" title={`execution_state: ${row.original.execution_state}`}>{executionLabel(row.original)}</span> },
    ...(['generated', 'executed', 'passed', 'failed'] as const).map(key => ({ accessorKey: key, header: () => <button className="sort-button" onClick={() => onSort?.(key === 'generated' ? 'generated_desc' : key === 'executed' ? 'executed_desc' : 'date_desc')}>{key === 'generated' ? 'Gen.' : key === 'executed' ? 'Exec.' : key === 'passed' ? 'Pass' : 'Fail'}{(key === 'generated' || key === 'executed') && <ArrowDownUp size={11} />}</button>, cell: ({ row }: { row: { original: Summary } }) => <span className={key === 'failed' && row.original.failed ? 'failed-text numeric' : 'numeric'}>{row.original[key].toLocaleString()}</span> })),
    { id: 'rate', header: () => <button className="sort-button" onClick={() => onSort?.('rate_desc')}>Rate <ArrowDownUp size={12} /></button>, cell: ({ row }) => <div className="rate-cell"><span>{rateLabel(row.original.passed, row.original.executed)}</span>{row.original.executed > 0 && <span className="mini-bar"><i style={{ width: `${row.original.passed / row.original.executed * 100}%` }} /></span>}</div> },
    { id: 'open', header: '', cell: ({ row }) => <Link className="open-run" href={`/runs/${encodeURIComponent(row.original.run_id)}`} onClick={e => e.stopPropagation()} aria-label={`Open run ${row.original.run_id}`}>Open <ArrowUpRight size={13} /></Link> }
  ], [selected, onSelect, onSort]);
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  return <div className="table-scroll run-table"><table><thead>{table.getHeaderGroups().map(g => <tr key={g.id}>{g.headers.map(h => <th key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map(row => <tr key={row.original.run_id} className={selected.includes(row.original.run_id) ? 'selected' : ''} onClick={() => router.push(`/runs/${encodeURIComponent(row.original.run_id)}`)}>{row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table></div>;
}
