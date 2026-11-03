-- The seeded support provider name under the product's own name. Only installs still
-- on the original seed value are moved; an operator's own provider name is left alone.
UPDATE settings SET value = '"Keel Support"' WHERE key = 'support.provider_name' AND value = '"cPanel Support"';
