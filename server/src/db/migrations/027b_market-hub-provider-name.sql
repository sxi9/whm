-- The plugin hub provider's seeded display name under the product's own name. Only
-- rows still on the original seed text are moved; a renamed provider is left alone.
UPDATE market_providers SET display_name = 'Keel Marketplace (plugin hub)' WHERE name = 'whm-hub' AND display_name = 'WHM Marketplace (plugin hub)';
