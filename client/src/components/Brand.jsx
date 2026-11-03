import { Link } from 'react-router-dom';
import { useBranding, logoSrc } from '../pages/cpanel/branding.js';

// The product mark: the operator's logo when one is uploaded (cPanel › Customization),
// otherwise a rounded tile with the first letter of the company name.
export function BrandMark({ size }) {
  const branding = useBranding();
  const logo = logoSrc(branding);
  const style = size ? { width: size, height: size, borderRadius: Math.round(size * 0.29), fontSize: Math.round(size / 2) } : undefined;
  if (logo) return <img src={logo} alt={branding.companyName} className="brand-logo" style={{ height: size || 34, maxWidth: 180, objectFit: 'contain' }} />;
  return <span className="brand-mark" style={style} aria-hidden="true">{(branding.companyName || 'K').trim()[0]?.toUpperCase()}</span>;
}

export function Brand({ to = '/', withText = true }) {
  const branding = useBranding();
  return (
    <Link to={to} className="brand" aria-label={`${branding.companyName} home`}>
      <BrandMark />
      {withText && (
        <span className="brand-text">
          <span className="brand-name">{branding.companyName}</span>
          <span className="brand-sub">{branding.tagline}</span>
        </span>
      )}
    </Link>
  );
}
