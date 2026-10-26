import { PageHeader } from '../../../components/Common.jsx';
import { ContactManager } from '../../contacts/ContactManager.jsx';

export default function ContactManagerPage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Who the server tells when something happens: email, SMS gateway, Slack, Pushover and webhook contacts, the events each one receives, the outgoing mail transport and the scheduled service/disk/certificate checks." />
      <ContactManager />
    </>
  );
}
