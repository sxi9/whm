import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Megaphone, X } from 'lucide-react';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { renderMarkdown } from '../plugins/PluginPage.jsx';

const DISMISS_KEY = 'whm.news.dismissed';
const readDismissed = () => { try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]'); } catch { return []; } };

const TONE = { info: 'banner-info', warning: 'banner-warning', critical: 'banner-error' };

// Active news items (cPanel › Modify cPanel & WHM News) for the signed-in role.
// Dismissals are per browser; critical items cannot be dismissed.
export function NewsBanner() {
  const { user } = useAuth();
  const { data } = useApi('/cpanel/news/active', { refreshMs: 5 * 60 * 1000 });
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => { try { localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed.slice(-100))); } catch { /* storage unavailable */ } }, [dismissed]);
  const items = (data || []).filter((n) => n.severity === 'critical' || !dismissed.includes(`${n.id}:${n.updatedAt}`));
  if (items.length === 0) return null;
  return (
    <div className="news-banners">
      {items.map((n) => (
        <div key={n.id} className={`banner ${TONE[n.severity] || 'banner-info'}`} role={n.severity === 'critical' ? 'alert' : 'status'}>
          <Megaphone size={18} />
          <div style={{ flex: 1 }}>
            <strong>{n.title}</strong>
            {n.body && <div className="markdown">{renderMarkdown(n.body)}</div>}
            {(user?.role === 'root' || (user?.role === 'reseller' && n.audience === 'own')) && <small><Link to="/cpanel/modify-cpanel-and-whm-news">Edit news</Link></small>}
          </div>
          {n.severity !== 'critical' && (
            <button className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed((d) => [...d, `${n.id}:${n.updatedAt}`])}><X size={16} /></button>
          )}
        </div>
      ))}
    </div>
  );
}
