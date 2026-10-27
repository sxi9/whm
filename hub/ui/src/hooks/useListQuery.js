import { useMemo } from 'react';
import { queryString } from '../api/client.js';
import { useTableState } from '../components/DataTable.jsx';
import { useApi } from './useApi.js';

// Paginated list backed by the hub's ?page&pageSize&q&sort&dir convention.
// `filters` are extra query params; the DataTable props come back ready to spread.
export function useListQuery(path, { filters = {}, pageSize = 50, enabled = true, initialQ = '' } = {}) {
  const table = useTableState({ pageSize, q: initialQ });
  const { page, q, sort, dir } = table.state;
  const url = useMemo(() => `${path}${queryString({ page, pageSize, q, sort, dir, ...filters })}`, [path, page, pageSize, q, sort, dir, JSON.stringify(filters)]);
  const res = useApi(url, { enabled });
  const rows = Array.isArray(res.data) ? res.data : [];
  return {
    ...res,
    rows,
    tableProps: {
      rows, loading: res.loading, error: res.error,
      total: res.meta?.total ?? null, page: res.meta?.page ?? page, pageSize: res.meta?.pageSize ?? pageSize,
      onPageChange: table.setPage, sort, dir, onSortChange: table.setSort, q, onSearch: table.setSearch,
    },
    table,
  };
}
