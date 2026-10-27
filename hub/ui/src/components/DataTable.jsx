import { useState } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown, Search, ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';

export function DataTable({
  columns, rows = [], loading = false, error = null, emptyText = 'Nothing to show',
  total = null, page = 1, pageSize = 50, onPageChange, sort, dir = 'asc', onSortChange,
  searchable = false, q = '', onSearch, searchPlaceholder = 'Search…',
  rowKey = (r) => r.id, rowActions, selectable = false, selected = [], onSelectedChange, toolbar, dense = false,
}) {
  const [draftQ, setDraftQ] = useState(q);
  const pageCount = total != null ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const allKeys = rows.map(rowKey);
  const allSelected = selectable && rows.length > 0 && allKeys.every((k) => selected.includes(k));

  const toggleAll = () => onSelectedChange?.(allSelected ? selected.filter((k) => !allKeys.includes(k)) : [...new Set([...selected, ...allKeys])]);
  const toggleOne = (k) => onSelectedChange?.(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]);

  const header = (col) => {
    const sortable = col.sortable && onSortChange;
    const active = sort === col.key;
    const Icon = !sortable ? null : active ? (dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
    return (
      <th key={col.key} style={{ width: col.width }} className={`${sortable ? 'sortable' : ''} ${col.align ? `align-${col.align}` : ''}`}
        onClick={sortable ? () => onSortChange(col.key, active && dir === 'asc' ? 'desc' : 'asc') : undefined} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        <span>{col.label}{Icon && <Icon size={14} className="sort-icon" />}</span>
      </th>
    );
  };

  return (
    <div className={`datatable ${dense ? 'dense' : ''}`}>
      {(searchable || toolbar) && (
        <div className="datatable-toolbar">
          {searchable && (
            <form className="search" onSubmit={(e) => { e.preventDefault(); onSearch?.(draftQ); }}>
              <Search size={16} />
              <input className="input" placeholder={searchPlaceholder} value={draftQ} onChange={(e) => setDraftQ(e.target.value)} />
              <button className="btn btn-sm" type="submit">Search</button>
              {q && <button className="btn btn-sm btn-ghost" type="button" onClick={() => { setDraftQ(''); onSearch?.(''); }}>Clear</button>}
            </form>
          )}
          {toolbar && <div className="datatable-actions">{toolbar}</div>}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {selectable && <th className="select-col"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" /></th>}
              {columns.map(header)}
              {rowActions && <th className="actions-col" />}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && <tr><td colSpan={columns.length + 2} className="table-state"><span className="spinner" /> Loading…</td></tr>}
            {error && <tr><td colSpan={columns.length + 2} className="table-state error">{error.message}</td></tr>}
            {!loading && !error && rows.length === 0 && <tr><td colSpan={columns.length + 2} className="table-state">{emptyText}</td></tr>}
            {rows.map((row) => {
              const k = rowKey(row);
              return (
                <tr key={k} className={selected.includes(k) ? 'is-selected' : ''}>
                  {selectable && <td className="select-col"><input type="checkbox" checked={selected.includes(k)} onChange={() => toggleOne(k)} aria-label={`Select ${k}`} /></td>}
                  {columns.map((col) => <td key={col.key} className={col.align ? `align-${col.align}` : ''}>{col.render ? col.render(row) : row[col.key] ?? <span className="muted">—</span>}</td>)}
                  {rowActions && <td className="actions-col"><RowActions actions={rowActions(row)} /></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pageCount != null && (
        <div className="datatable-footer">
          <span className="muted">{total === 0 ? 'No results' : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}</span>
          <div className="pager">
            <button className="btn btn-sm btn-icon" disabled={page <= 1} onClick={() => onPageChange?.(page - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>
            <span>Page {page} of {pageCount}</span>
            <button className="btn btn-sm btn-icon" disabled={page >= pageCount} onClick={() => onPageChange?.(page + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

function RowActions({ actions }) {
  const [open, setOpen] = useState(false);
  const visible = (actions || []).filter(Boolean);
  if (!visible.length) return null;
  const primary = visible.filter((a) => a.primary);
  const rest = visible.filter((a) => !a.primary);
  return (
    <div className="row-actions">
      {primary.map((a) => <button key={a.label} className={`btn btn-sm ${a.danger ? 'btn-danger-ghost' : ''}`} onClick={a.onClick} disabled={a.disabled}>{a.label}</button>)}
      {rest.length > 0 && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          <button className="btn btn-sm btn-icon" onClick={() => setOpen((o) => !o)} aria-label="More actions"><MoreHorizontal size={16} /></button>
          {open && (
            <div className="menu-items">
              {rest.map((a) => <button key={a.label} className={`menu-item ${a.danger ? 'danger' : ''}`} onClick={() => { setOpen(false); a.onClick(); }} disabled={a.disabled}>{a.label}</button>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function useTableState(initial = {}) {
  const [state, setState] = useState({ page: 1, pageSize: 50, q: '', sort: undefined, dir: 'asc', ...initial });
  return {
    state,
    setPage: (page) => setState((s) => ({ ...s, page })),
    setSearch: (q) => setState((s) => ({ ...s, q, page: 1 })),
    setSort: (sort, dir) => setState((s) => ({ ...s, sort, dir })),
    set: (patch) => setState((s) => ({ ...s, ...patch })),
  };
}
