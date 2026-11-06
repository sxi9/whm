import { PanelLeftOpen } from 'lucide-react';

export const SIDEBAR_ID = 'app-sidebar';

// The control that brings a collapsed sidebar back. It lives outside the <aside>
// (the aside's backdrop-filter makes it the containing block of any fixed
// descendant, so a button inside it is clipped away with the 0-width aside):
// the layouts render it floating above the footer and the top bars next to the brand.
export function SidebarExpand({ onClick, label = 'Show sidebar', controls = SIDEBAR_ID, className = 'sidebar-expand', size = 18 }) {
  return (
    <button type="button" className={className} onClick={onClick} aria-label={label} title={label} aria-expanded="false" aria-controls={controls}>
      <PanelLeftOpen size={size} aria-hidden="true" />
    </button>
  );
}
