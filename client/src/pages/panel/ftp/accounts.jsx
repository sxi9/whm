import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Plus, AlertTriangle, Download, Info } from 'lucide-react';
import { Card, KeyValue, StatusPill, Loading, formatMb, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, PasswordInput, Button, FormActions, ErrorBanner, passwordStrength } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm, Modal } from '../../../components/Modal.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi, percentOf, meterTone } from '../../../panel/hooks/usePanel.js';

const MIN_STRENGTH = 65;
const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

export function isFeatureDisabled(error) {
  return Boolean(error) && error.status === 403 && error.code === 'feature_disabled';
}

// The daemon-side login the API derives (design §9.12): the name plus a fixed suffix.
export function loginSuffix(daemon, account) {
  if (!account) return '';
  return daemon === 'proftpd' ? `_${account.username}` : `@${account.domain}`;
}

export function homePrefix(account) {
  return `${account?.homeDir || `/home/${account?.username || ''}`}/`;
}

export function relativeDir(dir, account) {
  const home = homePrefix(account);
  if (!dir) return '';
  if (dir.startsWith(home)) return dir.slice(home.length) || '.';
  return dir === home.slice(0, -1) ? '.' : dir;
}

export function encryptionText(value) {
  return { required: 'TLS required (FTPS)', optional: 'TLS when the client asks for it', off: 'None' }[value] || value || '—';
}

export function filterAccounts(rows, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => r.login.toLowerCase().includes(needle) || (r.dir || '').toLowerCase().includes(needle));
}

function RequestError({ error, onRetry }) {
  if (!error || isCapabilityError(error) || isFeatureDisabled(error)) return null;
  if (error.code === 'limit_reached') {
    return <div className="banner banner-warning" role="alert"><AlertTriangle size={18} /><div><strong>Plan limit reached</strong><p>{error.message}</p><p className="muted">Delete an FTP account you no longer need or ask your hosting provider about a larger plan.</p></div></div>;
  }
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

function SuffixedInput({ id, value, onChange, suffix, placeholder, disabled }) {
  return (
    <div className="input-group">
      <TextInput id={id} value={value} onChange={(v) => onChange(v.toLowerCase().replace(/[^a-z0-9._-]/g, ''))} placeholder={placeholder} maxLength={32} disabled={disabled} autoCapitalize="none" spellCheck={false} />
      {suffix && <input className="input" value={suffix} readOnly tabIndex={-1} aria-label="Fixed suffix" style={{ flex: '0 0 auto', width: `calc(${suffix.length}ch + 32px)` }} />}
    </div>
  );
}

function ClientConfigModal({ row, onClose }) {
  const { data, loading, error } = usePanelApi(row ? `/ftp/accounts/${row.id}/client-config` : null, { enabled: Boolean(row) });
  const href = data?.filezilla ? `data:text/xml;charset=utf-8,${encodeURIComponent(data.filezilla)}` : null;
  return (
    <Modal open={Boolean(row)} title={row ? `Connection settings for ${row.login}` : ''} onClose={onClose} size="md" footer={<>{href && <a className="btn" href={href} download={`${row?.login}.xml`}><Download size={16} /> FileZilla settings</a>}<Button variant="primary" onClick={onClose}>Done</Button></>}>
      {loading && !data && <Loading />}
      <PanelCapabilityState error={error} />
      <RequestError error={error} />
      {data && (
        <>
          <KeyValue items={[
            ['Server', <code key="h">{data.host}</code>],
            ['Port', <code key="p">{data.port}</code>],
            ['Protocol', data.protocol === 'sftp' ? 'SFTP' : 'FTP'],
            ['Encryption', encryptionText(data.encryption)],
            ['User name', <code key="u">{data.login}</code>],
            ['Password', data.authentication || 'the FTP account password'],
            ['Folder', <code key="d">{data.dir}</code>],
            ['Transfer mode', data.passiveMode ? 'Passive' : 'Active'],
          ]} />
          <p className="muted small" style={{ marginTop: 10 }}>Import the FileZilla settings file through File › Import, then enter the password when you connect.</p>
        </>
      )}
    </Modal>
  );
}

export default function FtpAccounts({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = usePanelMe();
  const { data, meta, loading, error, refetch } = usePanelApi('/ftp/accounts');
  const account = me?.account;
  const [form, setForm] = useState({ login: '', password: '', dir: 'public_html', quotaMb: null });
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [lastResult, setLastResult] = useState(null);
  const [pwFor, setPwFor] = useState(null);
  const [pw, setPw] = useState('');
  const [pwError, setPwError] = useState(null);
  const [quotaFor, setQuotaFor] = useState(null);
  const [quotaMb, setQuotaMb] = useState(null);
  const [quotaError, setQuotaError] = useState(null);
  const [configFor, setConfigFor] = useState(null);
  const capability = isCapabilityError(error);
  const daemon = meta?.daemon || 'pure-ftpd';
  const suffix = loginSuffix(daemon, account);
  const quota = meta?.quota || { max: account?.plan?.max_ftp ?? null, used: me?.counts?.ftp ?? 0 };
  const limitReached = quota.max != null && quota.max > 0 && quota.used >= quota.max;
  const percent = quota.max > 0 ? percentOf(quota.used, quota.max) : null;
  const quotasSupported = daemon === 'pure-ftpd';
  const rows = useMemo(() => filterAccounts(data || [], q), [data, q]);
  const home = homePrefix(account);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const create = async (e) => {
    e.preventDefault();
    const login = form.login.trim();
    if (!LOGIN_RE.test(login)) { setFormError({ message: 'Choose a login of letters, digits, ".", "_" or "-" that starts with a letter or digit', fields: { login: ['Up to 32 characters'] } }); return; }
    if (passwordStrength(form.password) < MIN_STRENGTH) { setFormError({ message: `Choose a stronger password (minimum strength ${MIN_STRENGTH})`, fields: { password: ['Too weak'] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const body = { login, password: form.password, dir: form.dir.trim().replace(/^\/+/, '') || 'public_html', quotaMb: quotasSupported ? form.quotaMb : null };
      const { data: res } = await panelApi.post('/ftp/accounts', body);
      setLastResult(res);
      toast.success(`FTP account ${res.login} created`);
      setForm({ login: '', password: '', dir: 'public_html', quotaMb: null });
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const remove = async (row) => {
    const ok = await confirm({ title: `Delete ${row.login}?`, message: `The login stops working immediately. The files in ${relativeDir(row.dir, account)} stay where they are.`, confirmLabel: 'Delete FTP account', danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/ftp/accounts/${row.id}`); toast.success(`${row.login} deleted`); refetch(); } catch (err) { toast.error(err); }
  };

  const changePassword = async () => {
    if (passwordStrength(pw) < MIN_STRENGTH) { setPwError({ message: `Choose a stronger password (minimum strength ${MIN_STRENGTH})` }); return; }
    setBusy(true); setPwError(null);
    try { await panelApi.put(`/ftp/accounts/${pwFor.id}/password`, { password: pw }); toast.success(`Password changed for ${pwFor.login}`); setPwFor(null); setPw(''); } catch (err) { setPwError(err); } finally { setBusy(false); }
  };

  const changeQuota = async () => {
    setBusy(true); setQuotaError(null);
    try { const { data: res } = await panelApi.put(`/ftp/accounts/${quotaFor.id}/quota`, { quotaMb }); toast.success(`${res.login} may now use ${formatMb(res.quotaMb)}`); setQuotaFor(null); refetch(); } catch (err) { setQuotaError(err); } finally { setBusy(false); }
  };

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>Refresh</Button>}>
      <div className="grid-2">
        <Card title="Connection settings" subtitle="What every FTP client needs. Your main login has access to the whole account.">
          <KeyValue items={[
            ['Server', <code key="h">{meta?.host || account?.domain || '—'}</code>],
            ['Port', <code key="p">{meta?.port ?? 21}</code>],
            ['Encryption', encryptionText(meta?.encryption)],
            ['Main login', <code key="m">{meta?.mainLogin || account?.username || '—'}</code>],
            ['Main password', 'Your account password'],
            ['Extra logins', `${quota.used ?? 0}${quota.max > 0 ? ` of ${quota.max}` : ''}`],
          ]} />
          {percent != null && <div className={`meter ${meterTone(percent)}`}><span style={{ width: `${percent}%` }} /></div>}
          {meta && meta.supported === false && (
            <div className="banner banner-warning" style={{ marginTop: 14, marginBottom: 0 }}>
              <AlertTriangle size={18} />
              <div><strong>Extra FTP logins are not enabled on this server</strong><p>{meta.hint || `${meta.daemon} serves the main login only.`}</p><p className="muted">Your main login works as usual. Ask your hosting provider to enable per-folder FTP accounts.</p></div>
            </div>
          )}
        </Card>

        <form onSubmit={create}>
          <Card title="Create an FTP account" subtitle="A login limited to one folder, for a designer, a developer or a device.">
            <PanelCapabilityState error={isCapabilityError(formError) ? formError : null} />
            <RequestError error={formError} />
            {limitReached && <div className="banner banner-info"><Info size={18} /><div>Your plan allows {quota.max} FTP account{quota.max === 1 ? '' : 's'} and all of them exist. Delete one you no longer need or ask your hosting provider about a larger plan.</div></div>}
            <Field label="Login" required error={formError?.fields?.login} help={form.login ? <>Signs in as <code>{form.login}{suffix}</code></> : 'Lowercase letters, digits, ".", "_" or "-"'} htmlFor="ftp-login">
              <SuffixedInput id="ftp-login" value={form.login} onChange={(v) => setForm((f) => ({ ...f, login: v }))} suffix={suffix} placeholder="designer" disabled={limitReached} />
            </Field>
            <Field label="Password" required error={formError?.fields?.password} htmlFor="ftp-password">
              <PasswordInput id="ftp-password" value={form.password} onChange={(v) => setForm((f) => ({ ...f, password: v }))} minStrength={MIN_STRENGTH} disabled={limitReached} />
            </Field>
            <Field label="Folder" required error={formError?.fields?.dir} help="The login sees this folder and everything below it; it is created if missing" htmlFor="ftp-dir">
              <div className="input-group">
                <input className="input" value={home} readOnly tabIndex={-1} aria-label="Home directory" style={{ flex: '0 0 auto', width: `calc(${home.length}ch + 32px)` }} />
                <TextInput id="ftp-dir" value={form.dir} onChange={(v) => setForm((f) => ({ ...f, dir: v }))} placeholder="public_html" disabled={limitReached} spellCheck={false} />
              </div>
            </Field>
            <Field label="Space limit (MB)" error={formError?.fields?.quotaMb} help={quotasSupported ? 'Leave empty for no limit beyond the account\'s disk space' : `${daemon} does not support per-login limits; the account's disk space applies`} htmlFor="ftp-quota">
              <NumberInput id="ftp-quota" value={form.quotaMb} onChange={(v) => setForm((f) => ({ ...f, quotaMb: v }))} min={0} placeholder="Unlimited" disabled={limitReached || !quotasSupported} />
            </Field>
            <FormActions>
              <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={busy || !form.login || !form.password || limitReached}>Create FTP account</Button>
              {lastResult && <span className="muted small">{lastResult.login} <PendingPill result={lastResult} />{lastResult.sync && lastResult.sync.synced === false && <StatusPill status="warning">not synced yet</StatusPill>}</span>}
            </FormActions>
          </Card>
        </form>
      </div>

      <Card title="FTP accounts" subtitle={data?.length ? `${data.length} on this account` : undefined} padded={false}>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        <DataTable
          columns={[
            { key: 'login', label: 'Login', render: (r) => <code>{r.login}</code> },
            { key: 'dir', label: 'Folder', render: (r) => <code>{relativeDir(r.dir, account)}</code> },
            { key: 'quotaMb', label: 'Space limit', align: 'right', render: (r) => (r.quotaMb == null ? <span className="muted">Unlimited</span> : formatMb(r.quotaMb)) },
            { key: 'created_at', label: 'Created', render: (r) => (r.created_at ? formatDate(r.created_at) : <span className="muted">—</span>) },
          ]}
          rows={rows} loading={loading} error={capability ? null : error} rowKey={(r) => r.id}
          searchable={Boolean(data?.length)} q={q} onSearch={setQ} searchPlaceholder="Search logins or folders"
          rowActions={(r) => [
            { label: 'Connection settings', primary: true, onClick: () => setConfigFor(r) },
            { label: 'Change password', onClick: () => { setPwFor(r); setPw(''); setPwError(null); } },
            r.daemon === 'pure-ftpd' ? { label: 'Change space limit', onClick: () => { setQuotaFor(r); setQuotaMb(r.quotaMb); setQuotaError(null); } } : null,
            { label: 'Delete', danger: true, onClick: () => remove(r) },
          ]}
          emptyText={capability ? 'FTP accounts appear here once the FTP server is available.' : q ? 'No FTP account matches the search.' : 'No extra FTP accounts yet. Create one above; it appears here with its folder and space limit. Your main login is always available with the settings shown above.'}
        />
      </Card>
      <p className="muted small">Prefer the <Link to="/panel/files/file-manager">file manager</Link> for occasional uploads; FTP accounts suit people and tools that need their own login.</p>

      <Modal open={Boolean(pwFor)} title={`Change password of ${pwFor?.login}`} onClose={() => setPwFor(null)} size="sm" footer={<><Button onClick={() => setPwFor(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={changePassword} disabled={!pw}>Change password</Button></>}>
        <PanelCapabilityState error={pwError} />
        <RequestError error={pwError} />
        <Field label="New password" required htmlFor="ftp-newpw"><PasswordInput id="ftp-newpw" value={pw} onChange={setPw} minStrength={MIN_STRENGTH} /></Field>
        <p className="muted">Anyone using this login needs the new password from now on.</p>
      </Modal>

      <Modal open={Boolean(quotaFor)} title={`Space limit of ${quotaFor?.login}`} onClose={() => setQuotaFor(null)} size="sm" footer={<><Button onClick={() => setQuotaFor(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={changeQuota}>Save limit</Button></>}>
        <PanelCapabilityState error={quotaError} />
        <RequestError error={quotaError} />
        <Field label="Space limit (MB)" help="Empty means no limit beyond the account's disk space" htmlFor="ftp-newquota"><NumberInput id="ftp-newquota" value={quotaMb} onChange={setQuotaMb} min={0} placeholder="Unlimited" /></Field>
      </Modal>

      <ClientConfigModal row={configFor} onClose={() => setConfigFor(null)} />
    </PanelPage>
  );
}
