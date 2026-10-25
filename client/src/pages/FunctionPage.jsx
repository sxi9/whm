import { Link } from 'react-router-dom';
import { Hammer } from 'lucide-react';
import { PageHeader, Card, EmptyState } from '../components/Common.jsx';

// Every function in nav.js routes here until it has a dedicated page in the
// registry, so the whole WHM surface is navigable from day one.
export function FunctionPage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} />
      <Card>
        <EmptyState icon={Hammer} title={`This screen is scheduled for build phase ${fn.phase}`}>
          <p>{fn.description}</p>
          <p className="muted">It is wired into the navigation, search and favorites now; its API and interface land in Phase {fn.phase}. See <code>CHECKLIST.md</code> in the repository for progress.</p>
          <p><Link to="/">Back to Home</Link></p>
        </EmptyState>
      </Card>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <Card><EmptyState title="There is no such page"><Link to="/">Back to Home</Link></EmptyState></Card>
    </>
  );
}
