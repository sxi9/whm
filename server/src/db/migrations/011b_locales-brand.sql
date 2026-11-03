-- The product's own name in the seeded starter locales. Only strings still on the
-- original seed text are moved; an operator's edited translations are left alone.
UPDATE locales SET strings_json = replace(strings_json, '"shell.starting":"Iniciando WHM…"', '"shell.starting":"Iniciando Keel…"') WHERE code = 'es' AND strings_json LIKE '%"shell.starting":"Iniciando WHM…"%';
UPDATE locales SET strings_json = replace(strings_json, '"shell.starting":"WHM wird gestartet…"', '"shell.starting":"Keel wird gestartet…"') WHERE code = 'de' AND strings_json LIKE '%"shell.starting":"WHM wird gestartet…"%';
UPDATE locales SET strings_json = replace(strings_json, '"shell.starting":"Démarrage de WHM…"', '"shell.starting":"Démarrage de Keel…"') WHERE code = 'fr' AND strings_json LIKE '%"shell.starting":"Démarrage de WHM…"%';
UPDATE locales SET strings_json = replace(strings_json, '"shell.starting":"Iniciando o WHM…"', '"shell.starting":"Iniciando o Keel…"') WHERE code = 'pt_br' AND strings_json LIKE '%"shell.starting":"Iniciando o WHM…"%';
