-- The product's own default identity. Only installs still on the original
-- placeholder are moved; an operator's custom branding is left alone.
UPDATE settings SET value = '"Keel"' WHERE key = 'branding.company_name' AND value = '"WHM"';
UPDATE settings SET value = '"Hosting control panel"' WHERE key = 'branding.tagline' AND value = '"WebHost Manager"';
