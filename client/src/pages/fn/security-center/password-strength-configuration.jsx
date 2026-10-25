import { useState } from 'react';
import { api } from '../../../api/client.js';
import { ConfigPage } from '../../../components/ConfigPage.jsx';
import { Card } from '../../../components/Common.jsx';
import { Field, PasswordInput, Select, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';

const CONTEXTS = [['account', 'Hosting account passwords'], ['panel', 'Panel (WHM) logins'], ['email', 'Email accounts'], ['ftp', 'FTP accounts'], ['mysql', 'Database users'], ['ssh', 'SSH / shell users']];

function StrengthTester() {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [context, setContext] = useState('account');
  const [result, setResult] = useState(null);
  const check = async () => {
    try { const { data } = await api.post('/security/password-strength', { password, context }); setResult(data); } catch (err) { toast.error(err); }
  };
  return (
    <Card title="Test a password" subtitle="Scores with the same algorithm the server applies when passwords are set.">
      <div className="form-grid">
        <Field label="Password"><PasswordInput value={password} onChange={setPassword} showStrength={false} allowGenerate={false} autoComplete="off" /></Field>
        <Field label="Context"><Select value={context} onChange={setContext} options={CONTEXTS.map(([value, label]) => ({ value, label }))} /></Field>
      </div>
      <FormActions><Button onClick={check} disabled={!password}>Check</Button></FormActions>
      {result && (
        <div className={`strength strength-${result.ok ? 'good' : 'weak'}`} style={{ marginTop: 8 }}>
          <div className="strength-bar"><span style={{ width: `${result.score}%` }} /></div>
          <span className="strength-text">Score {result.score} / minimum {result.minimum} for {result.context}: {result.ok ? 'accepted' : 'rejected'}</span>
        </div>
      )}
    </Card>
  );
}

export default function PasswordStrengthConfiguration({ fn }) {
  return (
    <ConfigPage fn={fn} prefix="security." description="Minimum strength (0–100) a password must reach before it is accepted. Leave a context empty to use the default." extra={<StrengthTester />} groups={[
      { title: 'Default', fields: [
        { key: 'security.min_password_strength', label: 'Default minimum strength', type: 'number', min: 0, max: 100, help: '65 rejects dictionary words and short passwords; 80 requires mixed case, digits and symbols.' },
      ] },
      { title: 'Per-context overrides', description: 'Empty = use the default.', fields: CONTEXTS.map(([ctx, label]) => ({ key: `security.password.strength.${ctx}`, label, type: 'number', min: 0, max: 100, placeholder: 'default' })) },
    ]} />
  );
}
