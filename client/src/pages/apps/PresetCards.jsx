import { Check, ExternalLink } from 'lucide-react';
import { Button } from '../../components/Form.jsx';
import { KINDS, KIND_LABELS, KindBadge, FALLBACK_PRESETS, startLabel } from './Shared.jsx';

// What a preset sets on a new application, as label/value rows.
export function presetFields(p) {
  const rows = [['Kind', KIND_LABELS[p.kind] || p.kind]];
  rows.push(['Install', p.install === 'npm' ? 'npm install' : p.install === 'pip' ? 'pip install -r requirements.txt' : 'nothing']);
  rows.push(['Build', p.build?.script ? `npm run ${p.build.script}${p.build.optional ? ' (when the script exists)' : ''}` : 'none']);
  if (p.kind === 'static') {
    rows.push(['Serves', p.outputDir || '.']);
    rows.push(['SPA fallback', p.spaFallback ? 'index.html' : 'off']);
  } else {
    rows.push(['Start', startLabel(p.start, p.kind) || '—']);
    rows.push(['Websockets', p.websockets ? 'passed through' : 'off']);
  }
  if (p.scaffold) rows.push(['Scaffold', 'can create a starter project']);
  if (p.defaults?.runtimeVersion) rows.push(['Runtime', p.defaults.runtimeVersion]);
  if (p.defaults?.extraPackages?.length) rows.push(['Extra packages', p.defaults.extraPackages.join(', ')]);
  return rows;
}

function presetSummary(p) {
  if (p.kind === 'static') return `${p.install ? 'npm install' : 'no install'}${p.build?.script ? ` · npm run ${p.build.script}` : ''} · serves ${p.outputDir || '.'}`;
  if (!p.start && !p.install) return '';
  return `${p.install ? `${p.install} install` : 'no install'}${p.build?.script ? ` · npm run ${p.build.script}` : ''}${p.start ? ` · ${startLabel(p.start, p.kind)}` : ''}`;
}

// Selectable cards for the create form's "What" step.
export function PresetCards({ presets, kind, value, onChange, loading = false }) {
  const list = (presets?.length ? presets : FALLBACK_PRESETS).filter((p) => !kind || p.kind === kind);
  return (
    <div className="tool-grid" role="radiogroup" aria-label="Preset">
      {list.map((p) => {
        const selected = value === p.id;
        return (
          <div key={p.id} className="tool-card" style={selected ? { borderColor: 'var(--primary)', boxShadow: '0 0 0 2px var(--primary-soft)' } : undefined}>
            <button type="button" role="radio" aria-checked={selected} className="tool-link" onClick={() => onChange(p)} style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit' }}>
              <strong>{p.label}{p.custom && <span className="pill pill-muted" style={{ marginLeft: 6 }}>custom</span>}</strong>
              <small>{p.description || (loading ? 'Loading preset details…' : '')}</small>
              {!loading && presetSummary(p) && <small><code className="small">{presetSummary(p)}</code></small>}
            </button>
            {selected && <Check size={16} style={{ position: 'absolute', top: 10, right: 10, color: 'var(--primary)' }} aria-hidden="true" />}
          </div>
        );
      })}
      {!list.length && <p className="muted">No preset for this kind; the fields below describe the application.</p>}
    </div>
  );
}

// Read-only catalog grouped by kind, each card listing the fields it sets.
export function PresetCatalog({ presets, onUse, useLabel = 'Use template' }) {
  const list = presets || [];
  if (!list.length) return <p className="muted">No presets.</p>;
  return (
    <>
      {KINDS.map((kind) => {
        const group = list.filter((p) => p.kind === kind);
        if (!group.length) return null;
        return (
          <section key={kind} className="tool-section">
            <h3><KindBadge kind={kind} /> <span className="count">{group.length}</span></h3>
            <div className="tool-grid">
              {group.map((p) => (
                <div key={p.id} className="tool-card">
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: 12, minWidth: 0 }}>
                    <div>
                      <strong>{p.label}</strong>{p.framework && p.framework !== p.label && <span className="muted small"> · {p.framework}</span>}{p.custom && <span className="pill pill-muted" style={{ marginLeft: 6 }}>custom</span>}
                      {p.description && <p className="muted small" style={{ margin: '4px 0 0' }}>{p.description}</p>}
                    </div>
                    <dl className="kv">
                      {presetFields(p).map(([k, v]) => <div key={k}><dt>{k}</dt><dd><code className="small">{v}</code></dd></div>)}
                    </dl>
                    <div className="row-actions" style={{ justifyContent: 'space-between' }}>
                      {p.docs ? <a className="small" href={p.docs} target="_blank" rel="noreferrer noopener"><ExternalLink size={12} /> Docs</a> : <span />}
                      {onUse && <Button size="sm" variant="primary" onClick={() => onUse(p.id)}>{useLabel}</Button>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
