import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { PageHeader, Card, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { RequestError, useLocales, LocalePills, TranslationProgress } from '../../locales/Shared.jsx';

export default function DeleteALocale({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { reload } = useT();
  const { locales, loading, error, refetch } = useLocales();
  const deletable = locales.filter((l) => !l.builtin);

  const remove = async (l) => {
    if (l.isDefault) { toast.warning(`"${l.code}" is the default locale; pick another default first.`); return; }
    if (!(await confirm({ title: `Delete locale "${l.name}" (${l.code})?`, message: `All ${l.stats.translated} translated strings are removed permanently. Download its XML first if you may want it back.`, confirmLabel: 'Delete locale', danger: true, typeToConfirm: l.code }))) return;
    try {
      await api.delete(`/locales/${l.code}`);
      toast.success(`Locale "${l.code}" deleted`);
      await refetch();
      reload();
    } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      <Card title="Custom locales" subtitle="The built-in English locale cannot be deleted, and the current default must be changed under Configure Application Locales before it can go." padded={false}>
        <DataTable loading={loading} rows={deletable} rowKey={(l) => l.code} emptyText="There are no custom locales to delete."
          columns={[
            { key: 'code', label: 'Code', width: 110, render: (l) => <code>{l.code}</code> },
            { key: 'name', label: 'Name', render: (l) => <strong>{l.name}</strong> },
            { key: 'state', label: 'State', render: (l) => <LocalePills locale={l} /> },
            { key: 'progress', label: 'Translated', render: (l) => <TranslationProgress stats={l.stats} /> },
            { key: 'updated', label: 'Updated', render: (l) => <span className="small">{formatDate(l.updatedAt)}</span> },
          ]}
          rowActions={(l) => [
            { label: 'Download XML first', onClick: () => navigate(`/locales/locale-xml-download?code=${l.code}`) },
            { label: 'Delete', primary: true, danger: true, disabled: l.isDefault, onClick: () => remove(l) },
          ]} />
      </Card>
      <p className="muted small"><Link to="/locales/view-available-locales">Back to available locales</Link></p>
      {deletable.some((l) => l.isDefault) && <p className="muted small">The default locale is greyed out: <Link to="/locales/configure-application-locales">change the default</Link> and come back.</p>}
    </>
  );
}
