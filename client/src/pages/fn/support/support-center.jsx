import { PageHeader } from '../../../components/Common.jsx';
import { SupportCenter } from '../../support/SupportCenter.jsx';

export default function SupportCenterPage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Documentation, vendor and community resources, the in-app API reference, a diagnostics download and the state of open tickets and support access." />
      <SupportCenter />
    </>
  );
}
