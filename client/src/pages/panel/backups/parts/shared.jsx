import { AlertTriangle, Info, UserX } from 'lucide-react';
import { ErrorBanner } from '../../../../components/Form.jsx';
import { formatBytes } from '../../../../components/Common.jsx';
import { panelApi } from '../../../../panel/hooks/usePanel.js';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

export function isFeatureDisabled(error) {
  return Boolean(error) && error.status === 403 && error.code === 'feature_disabled';
}

export function isImpersonating(error) {
  return Boolean(error) && error.code === 'not_while_impersonating';
}

export const KIND_LABELS = { home: 'Home directory and mail', full: 'Full account', upload: 'Uploaded archive' };
export const kindLabel = (kind) => KIND_LABELS[kind] || kind || '—';

export const STATUS_TONE = { done: 'done', running: 'running', queued: 'queued', failed: 'failed', error: 'failed', pending: 'pending' };
export const statusTone = (status) => STATUS_TONE[status] || 'unknown';

// What the API says while logged in as the account: a read-only notice, not an error.
export function ImpersonationNotice({ actingAs, children }) {
  if (!actingAs) return null;
  return (
    <div className="banner banner-info" role="status">
      <UserX size={18} />
      <div>
        <strong>Read-only while logged in as {actingAs.account}</strong>
        <p>{children || 'Changes to this account are only made by the account user. You can look at everything here.'}</p>
      </div>
    </div>
  );
}

// Errors a form shows itself. Capability errors render through PanelCapabilityState
// next to the form, feature gates through FeatureDisabledState, never twice.
export function RequestError({ error, onRetry }) {
  if (!error || isCapabilityError(error) || isFeatureDisabled(error)) return null;
  if (isImpersonating(error)) {
    return <div className="banner banner-warning" role="alert"><UserX size={18} /><div><strong>Not available while logged in as the account</strong><p>{error.message}</p></div></div>;
  }
  if (error.code === 'busy') {
    return <div className="banner banner-info" role="status"><Info size={18} /><div><strong>A backup is already running</strong><p>{error.message}</p><p className="muted">Wait for it to finish; the list updates by itself.</p></div></div>;
  }
  if (error.code === 'limit_reached') {
    return <div className="banner banner-warning" role="alert"><AlertTriangle size={18} /><div><strong>Plan limit reached</strong><p>{error.message}</p><p className="muted">Delete a backup you no longer need or ask your hosting provider about a larger plan.</p></div></div>;
  }
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export function sizeText(bytes) {
  return bytes == null ? '—' : formatBytes(bytes);
}

export function filterBackups(rows, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => (r.name || '').toLowerCase().includes(needle) || kindLabel(r.kind).toLowerCase().includes(needle) || String(r.status || '').includes(needle));
}

// Joins the path the user walked into the archive ("homedir/public_html/css").
export function joinPrefix(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}

export function prefixCrumbs(prefix) {
  const parts = String(prefix || '').split('/').filter(Boolean);
  return parts.map((name, i) => ({ name, prefix: parts.slice(0, i + 1).join('/') }));
}

// Chunked upload of an archive (design §4.10): begin → base64 chunks → finish.
// `onProgress(received, size)` reports bytes acknowledged by the API.
export async function uploadArchive(file, { onProgress, signal } = {}) {
  const { data: upload } = await panelApi.post('/backups/uploads', { name: file.name, size: file.size });
  const chunkBytes = upload.chunkBytes || 1_310_720;
  try {
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      if (signal?.aborted) throw Object.assign(new Error('Upload cancelled'), { code: 'cancelled' });
      const slice = await file.slice(offset, Math.min(file.size, offset + chunkBytes)).arrayBuffer();
      const { data: state } = await panelApi.put(`/backups/uploads/${upload.id}/chunks`, { data: toBase64(slice) });
      onProgress?.(state.received, state.size);
    }
    const { data: archive } = await panelApi.post(`/backups/uploads/${upload.id}/finish`, {});
    return archive;
  } catch (err) {
    await panelApi.post(`/backups/uploads/${upload.id}/abort`, {}).catch(() => {});
    throw err;
  }
}

export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
