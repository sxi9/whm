import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Textarea } from '../../components/Form.jsx';

export const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;

export const envToRows = (env) => Object.entries(env || {}).map(([key, value]) => ({ key, value: String(value ?? '') }));

export function rowsToEnv(rows) {
  const out = {};
  for (const r of rows || []) {
    const key = String(r.key || '').trim();
    if (!key) continue;
    out[key] = String(r.value ?? '');
  }
  return out;
}

export function envErrors(rows) {
  const errors = [];
  const seen = new Set();
  (rows || []).forEach((r, i) => {
    const key = String(r.key || '').trim();
    if (!key && !r.value) return;
    if (!ENV_KEY.test(key)) errors.push(`Row ${i + 1}: "${key || '(empty)'}" is not a valid name (UPPER_CASE letters, digits and _, max 64)`);
    else if (seen.has(key)) errors.push(`Row ${i + 1}: ${key} is set twice`);
    seen.add(key);
    if (/[\0\r\n]/.test(r.value || '')) errors.push(`${key || `Row ${i + 1}`}: values are a single line`);
    if ((r.value || '').length > 4096) errors.push(`${key || `Row ${i + 1}`}: at most 4096 characters`);
  });
  if (seen.size > 64) errors.push('At most 64 variables');
  return errors;
}

// KEY=value lines (dotenv style); quotes around the value and an "export "
// prefix are stripped, comments and blank lines skipped.
export function parseDotenv(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    rows.push({ key, value });
  }
  return rows;
}

export function EnvEditor({ rows, onChange, disabled = false }) {
  const [paste, setPaste] = useState(null);
  const list = rows || [];
  const set = (i, patch) => onChange(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const errors = envErrors(list);
  const applyPaste = () => {
    const parsed = parseDotenv(paste);
    const keys = new Set(parsed.map((r) => r.key));
    onChange([...list.filter((r) => !keys.has(r.key.trim())), ...parsed]);
    setPaste(null);
  };
  return (
    <div>
      <div className="table-wrap">
        <table className="dense">
          <thead><tr><th style={{ width: '35%' }}>Variable</th><th>Value</th><th /></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={3} className="table-state">No environment variables. PORT, HOST and NODE_ENV are set by the panel.</td></tr>}
            {list.map((r, i) => (
              <tr key={i}>
                <td><input className="input mono" value={r.key} onChange={(e) => set(i, { key: e.target.value.toUpperCase() })} placeholder="DATABASE_URL" disabled={disabled} aria-label="Variable name" /></td>
                <td><input className="input mono" value={r.value} onChange={(e) => set(i, { value: e.target.value })} placeholder="value" disabled={disabled} aria-label="Value" autoComplete="off" /></td>
                <td className="actions-col"><button type="button" className="icon-button" onClick={() => onChange(list.filter((_, j) => j !== i))} aria-label="Remove variable" disabled={disabled}><Trash2 size={16} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="action-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" icon={Plus} onClick={() => onChange([...list, { key: '', value: '' }])} disabled={disabled}>Add variable</Button>
        <Button size="sm" onClick={() => setPaste(paste === null ? '' : null)} disabled={disabled}>{paste === null ? 'Paste .env lines' : 'Cancel paste'}</Button>
      </div>
      {paste !== null && (
        <div style={{ marginBottom: 12 }}>
          <Textarea mono rows={5} value={paste} onChange={setPaste} placeholder={'KEY=value\nANOTHER="quoted value"'} aria-label="dotenv lines" />
          <div className="form-actions"><Button size="sm" variant="primary" onClick={applyPaste} disabled={!paste.trim()}>Add these variables</Button></div>
        </div>
      )}
      {errors.map((e) => <div key={e} className="field-message">{e}</div>)}
      <p className="field-help">Values are stored encrypted, written to the service environment file (root-only) and redacted in the audit log.</p>
    </div>
  );
}
