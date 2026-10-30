import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';

// A render error in one page must not blank the whole shell: the sidebar, top
// bar and footer keep working and the page area shows what went wrong. Mount
// it with key={location.pathname} so navigating away gives the next page a
// fresh boundary instead of the stale error.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.props.onError?.(error, info);
    if (!this.props.onError) console.error('Page render failed', error, info?.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <ErrorFallback error={error} title={this.props.title} onReload={this.props.onReload} onRetry={this.reset} />;
  }
}

export function errorText(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

export function ErrorFallback({ error, title = 'This page failed to render', onReload, onRetry }) {
  const reload = () => { if (onReload) onReload(); else window.location.reload(); };
  return (
    <section className="card error-boundary" role="alert">
      <header className="card-header">
        <div>
          <h2><AlertTriangle size={18} /> {title}</h2>
          <p className="muted">The rest of the panel keeps working. Reload the page, or open another function from the sidebar.</p>
        </div>
      </header>
      <div className="card-body">
        <pre className="log">{errorText(error)}</pre>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={reload}>Reload</button>
          {onRetry && <button type="button" className="btn" onClick={onRetry}>Try again</button>}
        </div>
      </div>
    </section>
  );
}

export default ErrorBoundary;
