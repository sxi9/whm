import { PageHeader } from '../../../components/Common.jsx';
import { AccessGrants } from '../../support/AccessGrants.jsx';

export default function GrantCpanelSupportAccess({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Give a support engineer time-boxed access: a fresh SSH key authorized for root and an API token, both removed automatically when the grant expires and recorded in the audit log." />
      <AccessGrants />
    </>
  );
}
