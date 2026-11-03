import { Link } from 'react-router-dom';
import { Home, ChevronRight, AlertTriangle } from 'lucide-react';
import { ErrorBanner } from '../../../../components/Form.jsx';
import { isCapabilityError, isFeatureDisabled, segmentsOf } from './paths.js';

export function RequestError({ error, onRetry }) {
  if (!error || isCapabilityError(error) || isFeatureDisabled(error)) return null;
  if (error.code === 'exists') {
    return <div className="banner banner-warning" role="alert"><AlertTriangle size={18} /><div><strong>Already exists</strong><p>{error.message}</p></div></div>;
  }
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

// The folder trail: home, then one button per segment. `hrefFor` makes the
// segments links (disk usage); `onNavigate` makes them buttons (file manager).
export function PathBar({ path, onNavigate, hrefFor, homeDir, trailing }) {
  const segments = segmentsOf(path);
  const Item = ({ to, children, current }) => {
    const cls = `btn btn-sm ${current ? '' : 'btn-ghost'}`;
    if (hrefFor) return <Link className={cls} to={hrefFor(to)} aria-current={current ? 'location' : undefined}>{children}</Link>;
    return <button type="button" className={cls} onClick={() => onNavigate?.(to)} aria-current={current ? 'location' : undefined}>{children}</button>;
  };
  return (
    <nav aria-label="Folder path" style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', minWidth: 0 }}>
      <Item to="" current={segments.length === 0}><Home size={14} /> <span title={homeDir || 'Home directory'}>Home</span></Item>
      {segments.map((s, i) => (
        <span key={s.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <ChevronRight size={14} className="muted" aria-hidden="true" />
          <Item to={s.path} current={i === segments.length - 1}>{s.name}</Item>
        </span>
      ))}
      {trailing}
    </nav>
  );
}
