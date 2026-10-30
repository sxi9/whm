-- Branding: the starter locales seeded by 011 translate the hosted-account
-- category with the legacy vendor name. Rows that still carry that seed value
-- follow client/src/brand.js (product "HST Panel"); a translation the operator
-- edited, and every other string of the row, is kept.
UPDATE locales SET strings_json = json_set(strings_json, '$."category.cpanel"', 'HST Panel')
  WHERE code IN ('es', 'de', 'fr', 'pt_br') AND json_valid(strings_json)
    AND json_extract(strings_json, '$."category.cpanel"') = 'cPanel';
