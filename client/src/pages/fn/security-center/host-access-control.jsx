import { useEffect, useState } from 'react';
import { ArrowUp, ArrowDown, Trash2, Plus } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading } from '../../../components/Common.jsx';
import { Select, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError } from '../../security/Shared.jsx';

const EMPTY = { service: 'sshd', source: '', action: 'allow', comment: '' };

export default function HostAccessControl({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/security/host-access');
  const [rules, setRules] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setRules(data.rules.map((r) => ({ service: r.service, source: r.source, action: r.action, comment: r.comment || '' }))); }, [data]);

  const update = (i, patch) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i, d) => setRules((rs) => { const n = [...rs]; const [r] = n.splice(i, 1); n.splice(i + d, 0, r); return n; });
  const remove = (i) => setRules((rs) => rs.filter((_r, j) => j !== i));
  const save = async () => {
    setBusy(true);
    try {
      const payload = rules.map((r) => ({ service: r.service.trim(), source: r.source.trim(), action: r.action, ...(r.comment.trim() ? { comment: r.comment.trim() } : {}) }));
      const { data: result } = await api.put('/security/host-access', { rules: payload });
      toast.success('/etc/hosts.allow written');
      if (result?.written?.denyUntouched) toast.info('/etc/hosts.deny already holds rules that were not written by the panel; it was left in place and those rules still apply.');
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const dirty = data && JSON.stringify(rules) !== JSON.stringify(data.rules.map((r) => ({ service: r.service, source: r.source, action: r.action, comment: r.comment || '' })));

  return (
    <>
      <PageHeader fn={fn} description="TCP wrappers rules (hosts.allow) for daemons compiled with libwrap such as sshd, vsftpd and dovecot. Rules are matched top to bottom; the first match wins, and a connection that matches nothing is allowed." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          {data.files && !data.files.supported && <div className="banner banner-info"><div>libwrap was not detected on this host; the files are still written but only daemons linked against TCP wrappers honour them.</div></div>}
          {data.files && data.files.denyManaged === false && <div className="banner banner-warning"><div><strong>/etc/hosts.deny contains rules the panel did not write.</strong> They keep applying after every save here (the panel only rewrites that file once it manages it). Review them below and move them into this list if they should be managed from the panel.</div></div>}
          <Card title="Rules" actions={<Button size="sm" icon={Plus} onClick={() => setRules((rs) => [...rs, { ...EMPTY }])}>Add rule</Button>} padded={false}>
            <div className="table-wrap">
              <table>
                <thead><tr><th style={{ width: 160 }}>Daemon</th><th>Access list (host, IP, network/mask, ALL, LOCAL…)</th><th style={{ width: 120 }}>Action</th><th>Comment</th><th style={{ width: 130 }} /></tr></thead>
                <tbody>
                  {rules.length === 0 && <tr><td colSpan={5} className="table-state">No rules. Every connection is allowed.</td></tr>}
                  {rules.map((r, i) => (
                    <tr key={i}>
                      <td><TextInput value={r.service} onChange={(v) => update(i, { service: v })} list="whm-known-services" /></td>
                      <td><TextInput value={r.source} onChange={(v) => update(i, { source: v })} placeholder="192.0.2.0/24 or [2001:db8::]/32" /></td>
                      <td><Select value={r.action} onChange={(v) => update(i, { action: v })} options={[{ value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }]} /></td>
                      <td><TextInput value={r.comment} onChange={(v) => update(i, { comment: v })} placeholder="optional" /></td>
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-sm btn-icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp size={14} /></button>
                          <button className="btn btn-sm btn-icon" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown size={14} /></button>
                          <button className="btn btn-sm btn-icon btn-danger-ghost" onClick={() => remove(i)} aria-label="Remove"><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <datalist id="whm-known-services">{data.services.map((s) => <option key={s} value={s} />)}</datalist>
            <div className="card-body">
              <FormActions>
                <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>Save and write /etc/hosts.allow</Button>
                <Button disabled={!dirty} onClick={() => refetch()}>Reset</Button>
              </FormActions>
              <p className="muted">Tip: to lock SSH down, add <code>sshd</code> allow rules for your networks first, then an <code>sshd ALL deny</code> rule at the end.</p>
              <p className="muted">IPv6 addresses and networks are written in libwrap's bracketed form (<code>[2001:db8::]/32</code>) automatically. For IPv4 networks the <code>n.n.n.n/m.m.m.m</code> mask form works on every distribution; <code>n.n.n.n/prefix</code> is honoured by Debian/Ubuntu's libwrap but not by RHEL-family builds.</p>
            </div>
          </Card>
          <Card title="Current files">
            <div className="form-grid">
              <div><h3>/etc/hosts.allow</h3><pre className="log">{data.files?.allow ?? '(missing)'}</pre></div>
              <div><h3>/etc/hosts.deny</h3><pre className="log">{data.files?.deny ?? '(missing)'}</pre></div>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
