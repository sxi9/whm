import { PageHeader } from '../../../components/Common.jsx';
import { MailPreferences } from '../../contacts/MailPreferences.jsx';

export default function EditSystemMailPreferencesPage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Where mail addressed to root ends up (the root entry in /etc/aliases) and which panel events are mailed to root in addition to the contacts in Contact Manager." />
      <MailPreferences />
    </>
  );
}
