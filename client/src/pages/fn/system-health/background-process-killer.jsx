import { PageHeader } from '../../../components/Common.jsx';
import { BackgroundProcessKiller } from '../../server/BackgroundProcessKiller.jsx';

export default function BackgroundProcessKillerPage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Processes on the disallowed list that run as a non-root user are killed on a schedule and logged here. Root is never touched." />
      <BackgroundProcessKiller />
    </>
  );
}
