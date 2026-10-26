import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../../components/Common.jsx';
import { TicketForm, TicketList, TicketDetail } from '../../support/Tickets.jsx';

export default function CreateSupportTicket({ fn }) {
  const [params, setParams] = useSearchParams();
  const [tick, setTick] = useState(0);
  const openId = params.get('ticket');
  const open = (id) => { const p = new URLSearchParams(params); if (id) p.set('ticket', String(id)); else p.delete('ticket'); setParams(p); };
  return (
    <>
      <PageHeader fn={fn} description="Open a support request. The ticket is kept on this server and emailed to the configured support address together with a redacted snapshot of the system." />
      <TicketForm onCreated={() => setTick((t) => t + 1)} />
      <TicketList refreshKey={tick} onOpen={open} />
      <TicketDetail id={openId ? Number(openId) : null} onClose={() => open(null)} onChanged={() => setTick((t) => t + 1)} />
    </>
  );
}
