import { Link } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { StatusPill } from '../../components/Common.jsx';
import { Select } from '../../components/Form.jsx';

export { RequestError, Tabs } from '../security/Shared.jsx';

// All installed locales plus the server default; most Locales pages start from this.
export function useLocales() {
  const res = useApi('/locales');
  // The default comes from the row flags first: setData() replaces the rows
  // without touching meta, so meta.default can lag behind after a mutation.
  const locales = res.data || [];
  return { ...res, locales, defaultCode: locales.find((l) => l.isDefault)?.code || res.meta?.default || 'en', baseKeys: res.meta?.baseKeys ?? 0 };
}

export function LocaleSelect({ value, onChange, locales, filter = () => true, placeholder = 'Choose a locale…', ...rest }) {
  const options = (locales || []).filter(filter).map((l) => ({ value: l.code, label: `${l.name} (${l.code})${l.builtin ? ' · built-in' : ''}` }));
  return <Select value={value} onChange={onChange} options={options} placeholder={placeholder} {...rest} />;
}

export function LocalePills({ locale }) {
  if (!locale) return null;
  return (
    <span className="row-actions">
      {locale.builtin && <StatusPill status="info">built-in</StatusPill>}
      {locale.isDefault && <StatusPill status="ok">default</StatusPill>}
      <StatusPill status={locale.enabled ? 'enabled' : 'disabled'} />
    </span>
  );
}

export function TranslationProgress({ stats }) {
  if (!stats) return null;
  const tone = stats.percent >= 90 ? 'var(--ok)' : stats.percent >= 40 ? 'var(--warn)' : 'var(--bad)';
  return (
    <div title={`${stats.translated} of ${stats.total} base strings translated${stats.extra ? `, ${stats.extra} extra key(s)` : ''}`} style={{ minWidth: 140 }}>
      <div className="strength-bar"><span style={{ width: `${stats.percent}%`, background: tone }} /></div>
      <span className="small muted">{stats.translated}/{stats.total} · {stats.percent}%</span>
    </div>
  );
}

export function downloadXml(filename, content) {
  const blob = new Blob([content], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function LocaleLinks({ code, except }) {
  const links = [
    ['edit', `/locales/edit-a-locale?code=${code}`, 'Edit'],
    ['copy', `/locales/copy-a-locale?from=${code}`, 'Copy'],
    ['download', `/locales/locale-xml-download?code=${code}`, 'Download XML'],
  ].filter(([k]) => k !== except);
  return <span className="row-actions">{links.map(([k, to, label]) => <Link key={k} className="btn btn-sm" to={to}>{label}</Link>)}</span>;
}
