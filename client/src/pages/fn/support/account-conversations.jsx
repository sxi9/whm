import { PageHeader } from '../../../components/Common.jsx';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { ChatWorkspace } from '../../support/ChatWorkspace.jsx';

export default function AccountConversationsPage({ fn }) {
  const { user } = useAuth();
  const account = user?.role === 'user';
  return (
    <>
      <PageHeader fn={fn} title={account ? 'My support' : undefined} description={account
        ? 'Your conversation with the person who manages your hosting account. Messages stay in the panel; new replies appear here as they arrive.'
        : 'One thread per hosting account, shared by root, the account\'s owner and its assigned manager. The account sees the same thread from its own login and is notified of new replies.'} />
      <ChatWorkspace />
    </>
  );
}
