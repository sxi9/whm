import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Server, Settings2, Boxes, Download, CheckCircle2 } from 'lucide-react';
import { api } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, Loading, CapabilityNotice } from '../components/Common.jsx';
import { Field, TextInput, Button, ErrorBanner, FormActions } from '../components/Form.jsx';
import { ProgressLog } from '../components/ProgressLog.jsx';
import { useToast } from '../components/Toast.jsx';
import { LICENSE_PATH } from '../components/Layout.jsx';

export const PRODUCT = { name: 'HST Panel', vendor: 'Hostingsignal' };

export const SETUP_STEPS = [
  { key: 'welcome', label: 'Welcome', icon: Server },
  { key: 'basics', label: 'Server basics', icon: Settings2 },
  { key: 'services', label: 'Services', icon: Boxes },
  { key: 'install', label: 'Install', icon: Download },
  { key: 'done', label: 'Done', icon: CheckCircle2 },
];

// First-run wizard for root. The shell routes here while /api/auth/me reports
// setupPending; completing (or skipping) it sets the setup.completed setting.
export default function SetupPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [selection, setSelection] = useState({ profile: 'full', components: [] });
  const [jobId, setJobId] = useState(null);
  const [jobResult, setJobResult] = useState(null);
  const [completing, setCompleting] = useState(false);

  const finish = async (skipped) => {
    setCompleting(true);
    try {
      await api.post('/system/setup/complete', { skipped });
      await refresh();
      toast.success(skipped ? 'Setup skipped; you can install services later from Service Manager' : 'Setup complete');
      navigate('/', { replace: true });
    } catch (err) { toast.error(err); } finally { setCompleting(false); }
  };

  if (user && user.role !== 'root') return <Card><p>Only the root administrator runs the first-time setup.</p></Card>;
  const current = SETUP_STEPS[step];
  const next = () => setStep((s) => Math.min(s + 1, SETUP_STEPS.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));
  return (
    <>
      <PageHeader title={`${PRODUCT.name} setup`} description={`Get this server ready to host accounts. Everything here can be changed later; "Skip for now" takes you straight to the dashboard.`}
        actions={current.key !== 'done' && <Button onClick={() => finish(true)} loading={completing}>Skip for now</Button>} />
      <LicenseGateCard license={user?.license} />
      <StepBar steps={SETUP_STEPS} current={step} />
      {current.key === 'welcome' && <WelcomeStep onNext={next} />}
      {current.key === 'basics' && <BasicsStep onNext={next} onBack={back} />}
      {current.key === 'services' && <ServicesStep selection={selection} onChange={setSelection} onNext={next} onBack={back} />}
      {current.key === 'install' && <InstallStep selection={selection} jobId={jobId} onStarted={setJobId} result={jobResult} onResult={setJobResult} onNext={next} onBack={back} />}
      {current.key === 'done' && <DoneStep result={jobResult} onFinish={() => finish(false)} busy={completing} />}
    </>
  );
}

// An enforced license that is not active makes the API refuse the wizard's
// mutations (settings, installs); the only way out is the License tab, which the
// shell keeps reachable while this card is shown.
export function LicenseGateCard({ license }) {
  if (!license || !license.enforce || !license.degraded) return null;
  const status = license.status || 'unlicensed';
  return (
    <Card title="Activate the license first" className="setup-license-gate">
      <p>This panel enforces licensing and its license is <strong>{status}</strong>{license.reason ? ` (${license.reason.replace(/_/g, ' ')})` : ''}, so the server is read-only: the setup cannot save settings or install services until a license is active. Activate the license, then come back here, or skip the setup and run the installer from Service Manager later.</p>
      <FormActions><Link className="btn btn-primary" to={license.action || LICENSE_PATH}>Open the License tab</Link></FormActions>
    </Card>
  );
}

export function StepBar({ steps, current }) {
  return (
    <ol className="setup-steps" style={{ display: 'flex', gap: 12, listStyle: 'none', padding: 0, margin: '0 0 16px', flexWrap: 'wrap' }}>
      {steps.map((s, i) => {
        const Icon = s.icon;
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={s.key} className={`setup-step setup-step-${state}`} aria-current={state === 'current' ? 'step' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: state === 'todo' ? 0.6 : 1, fontWeight: state === 'current' ? 600 : 400 }}>
            <span className={`pill ${state === 'done' ? 'pill-ok' : state === 'current' ? 'pill-info' : 'pill-muted'}`}>{i + 1}</span>
            <Icon size={16} /> {s.label}
          </li>
        );
      })}
    </ol>
  );
}

export function WelcomeStep({ onNext }) {
  return (
    <Card title={`Welcome to ${PRODUCT.name}`} subtitle={`by ${PRODUCT.vendor}`}>
      <p>{PRODUCT.name} administers this Linux server for you: Linux users and disk quotas, Apache and PHP-FPM, BIND DNS, Exim and Dovecot mail, MariaDB, FTP, TLS certificates, firewall, backups and resellers.</p>
      <p>This short setup collects the server basics, lets you choose which services this server should run and installs them with the distribution's package manager. It takes a few minutes on a fresh server.</p>
      <ul>
        <li><strong>Server basics</strong>: hostname, contact address, nameservers and main IP.</li>
        <li><strong>Services</strong>: the full hosting stack, web + database only, or your own selection.</li>
        <li><strong>Install</strong>: watch the installation run; nothing else is needed from you.</li>
      </ul>
      <FormActions><Button variant="primary" onClick={onNext}>Get started</Button></FormActions>
    </Card>
  );
}

const BASIC_KEYS = ['basic.hostname', 'basic.contact_email', 'basic.main_ip', 'basic.nameservers'];

const draftFrom = (data) => {
  if (!data) return null;
  const ns = Array.isArray(data['basic.nameservers']) ? data['basic.nameservers'] : [];
  return { hostname: data['basic.hostname'] || '', contactEmail: data['basic.contact_email'] || '', mainIp: data['basic.main_ip'] || '', ns1: ns[0] || '', ns2: ns[1] || '' };
};

export function BasicsStep({ onNext, onBack }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/system/settings?prefix=basic.');
  const [draft, setDraft] = useState(() => draftFrom(data));
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) setDraft(draftFrom(data)); }, [data]);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    const nameservers = [draft.ns1, draft.ns2].map((s) => s.trim().toLowerCase()).filter(Boolean);
    const body = { 'basic.hostname': draft.hostname.trim().toLowerCase(), 'basic.contact_email': draft.contactEmail.trim(), 'basic.main_ip': draft.mainIp.trim(), 'basic.nameservers': nameservers };
    try { await api.put('/system/settings', body); toast.success('Server basics saved'); onNext(); } catch (err) { setSaveError(err); } finally { setSaving(false); }
  };
  return (
    <Card title="Server basics" subtitle="Written to Basic WebHost Manager Setup; the system hostname itself is changed under Networking Setup › Change Hostname.">
      <ErrorBanner error={error} onRetry={refetch} />
      {loading && !draft && <Loading />}
      {draft && (
        <form className="form-narrow" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <ErrorBanner error={saveError} />
          <Field label="Hostname" help="Fully qualified, e.g. server1.example.com" required><TextInput value={draft.hostname} onChange={set('hostname')} placeholder="server1.example.com" required /></Field>
          <Field label="Server contact email" help="Receives alerts, reports and license notices."><TextInput type="email" value={draft.contactEmail} onChange={set('contactEmail')} placeholder="admin@example.com" /></Field>
          <Field label="Main server IP address" help="The primary IPv4 address accounts are created on; leave blank to let the panel detect it."><TextInput value={draft.mainIp} onChange={set('mainIp')} placeholder="203.0.113.10" /></Field>
          <Field label="Primary nameserver"><TextInput value={draft.ns1} onChange={set('ns1')} placeholder="ns1.example.com" /></Field>
          <Field label="Secondary nameserver"><TextInput value={draft.ns2} onChange={set('ns2')} placeholder="ns2.example.com" /></Field>
          <FormActions>
            <Button onClick={onBack}>Back</Button>
            <Button type="submit" variant="primary" loading={saving}>Save and continue</Button>
          </FormActions>
        </form>
      )}
    </Card>
  );
}

export function ServicesStep({ selection, onChange, onNext, onBack }) {
  const stack = useApi('/system/stack');
  const d = stack.data;
  const components = d?.components || [];
  const missing = components.filter((c) => !c.installed);
  const profiles = d?.profiles || [];
  const choose = (profile) => onChange({ profile, components: profile === 'manual' ? selection.components : (profiles.find((p) => p.key === profile)?.components || []).filter((k) => missing.some((c) => c.key === k)) });
  const toggle = (key, on) => onChange({ profile: 'manual', components: on ? [...new Set([...selection.components, key])] : selection.components.filter((k) => k !== key) });
  const chosen = selection.profile === 'manual' ? selection.components : (profiles.find((p) => p.key === selection.profile)?.components || []).filter((k) => missing.some((c) => c.key === k));
  return (
    <Card title="Which services should this server run?" subtitle={d ? `${components.length - missing.length} of ${components.length} components are already installed · package manager: ${d.packageManager || 'none detected'}` : undefined}>
      <ErrorBanner error={stack.error} onRetry={stack.refetch} />
      {stack.loading && !d && <Loading />}
      {d && !d.pkgAvailable && <CapabilityNotice error={{ code: 'capability_missing', message: 'No supported package manager (apt-get, dnf or yum) was found, so the panel cannot install software on this server. You can continue; install the services by hand and the panel detects them.' }} onRetry={stack.refetch} />}
      {d && (
        <>
          <div className="stat-grid" style={{ marginBottom: 12 }}>
            {profiles.map((p) => {
              const active = selection.profile === p.key;
              const toInstall = p.key === 'manual' ? selection.components.length : p.components.filter((k) => missing.some((c) => c.key === k)).length;
              return (
                <button type="button" key={p.key} className={`card profile-card ${active ? 'is-selected' : ''}`} aria-pressed={active} onClick={() => choose(p.key)} style={{ textAlign: 'left', cursor: 'pointer', margin: 0, border: active ? '2px solid var(--primary, #2563eb)' : undefined }}>
                  <div className="card-body">
                    <strong>{p.label}</strong>
                    <p className="muted" style={{ margin: '6px 0' }}>{p.description}</p>
                    <small className="muted">{p.key === 'manual' ? `${toInstall} selected` : `${toInstall} component(s) to install`}</small>
                  </div>
                </button>
              );
            })}
          </div>
          {selection.profile === 'manual' && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
              {missing.map((c) => (
                <li key={c.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0' }}>
                  <input type="checkbox" id={`setup-${c.key}`} checked={selection.components.includes(c.key)} onChange={(e) => toggle(c.key, e.target.checked)} disabled={!d.pkgAvailable} />
                  <label htmlFor={`setup-${c.key}`}><strong>{c.label}</strong>{c.recommended && <span className="pill pill-info" style={{ marginLeft: 6 }}>recommended</span>}<div className="muted" style={{ fontSize: 12 }}>{c.description}{c.requires && <div className="field-message">{c.requires}</div>}</div></label>
                </li>
              ))}
              {missing.length === 0 && <li className="muted">Everything in the catalog is already installed.</li>}
            </ul>
          )}
          {selection.profile !== 'manual' && chosen.length > 0 && <p className="muted">Will install: {chosen.map((k) => components.find((c) => c.key === k)?.label || k).join(', ')}.</p>}
          {selection.profile !== 'manual' && chosen.length === 0 && <p className="muted">Nothing to install for this profile; every component is already present.</p>}
        </>
      )}
      <FormActions>
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" onClick={onNext} disabled={stack.loading && !d}>Continue</Button>
      </FormActions>
    </Card>
  );
}

export function InstallStep({ selection, jobId, onStarted, result, onResult, onNext, onBack }) {
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  // One package installation runs at a time (the API answers 409 otherwise);
  // a job started elsewhere can be followed from here instead.
  const stack = useApi('/system/stack');
  const active = !jobId && stack.data?.activeJob ? stack.data.activeJob : null;
  const nothing = selection.profile === 'manual' && selection.components.length === 0;
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const body = selection.profile === 'manual' ? { components: selection.components } : { profile: selection.profile };
      const { data } = await api.post('/system/stack/install', body);
      onStarted(data.job.id);
    } catch (err) { setError(err); } finally { setStarting(false); }
  };
  const finished = (event) => onResult({ status: event.type, result: event.result, error: event.error });
  return (
    <Card title="Install" subtitle={nothing ? 'No components were selected.' : `Installing ${selection.profile === 'manual' ? `${selection.components.length} selected component(s)` : `the "${selection.profile}" profile`}.`}>
      {error?.status === 501 ? <CapabilityNotice error={error} /> : <ErrorBanner error={error} />}
      {active && (
        <div className="banner banner-info" role="status">
          <div>
            <strong>An installation is already running</strong>
            <p>Job #{active.id} ({active.type}) is {active.status}{active.message ? `: ${active.message}` : ''}. Wait for it to finish before starting another, or follow it here.</p>
          </div>
          <Button size="sm" onClick={() => onStarted(active.id)}>Follow it</Button>
        </div>
      )}
      {!jobId && !nothing && !active && <p>The package manager runs on the server; output appears below. You can leave this page, the job keeps running and Service Manager shows its progress.</p>}
      {jobId && <ProgressLog jobId={jobId} onFinished={finished} />}
      {result && (
        <p>
          <StatusPill status={result.status === 'done' ? 'ok' : 'failed'}>{result.status}</StatusPill>{' '}
          {result.result?.failed?.length ? `Failed: ${result.result.failed.join(', ')}; the log above says why. The rest installed.` : result.status === 'done' ? 'All selected components installed.' : result.error}
        </p>
      )}
      <FormActions>
        <Button onClick={onBack} disabled={Boolean(jobId) && !result}>Back</Button>
        {!jobId && !nothing && <Button variant="primary" onClick={start} loading={starting} disabled={Boolean(active)}>Start installation</Button>}
        {(nothing || result || (error && error.status === 501)) && <Button variant="primary" onClick={onNext}>Continue</Button>}
        {jobId && !result && <Button onClick={onNext}>Continue in the background</Button>}
      </FormActions>
    </Card>
  );
}

export function DoneStep({ result, onFinish, busy }) {
  return (
    <Card title="All set">
      <p>{PRODUCT.name} is ready. {result?.status === 'done' ? 'The services you chose are installed and enabled.' : result ? 'Some components did not install; Service Manager lists what is missing and lets you retry.' : 'Install or repair services any time from Service Manager.'}</p>
      <ul>
        <li>Create your first hosting account under <strong>Account Functions › Create a New Account</strong>.</li>
        <li>Add packages (plans) under <strong>Packages</strong> and nameservers under <strong>DNS Functions</strong>.</li>
        <li>Enable AutoSSL under <strong>SSL/TLS</strong> once DNS points at this server.</li>
      </ul>
      <FormActions><Button variant="primary" onClick={onFinish} loading={busy}>Go to the dashboard</Button></FormActions>
    </Card>
  );
}
