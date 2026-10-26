-- Database Services: source addresses for connections to remote profiles
-- (set from "Configure Remote Service IPs" via ctx.databases.setClientAddresses).
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('db.client.bind_address_ipv4', 'null'),
  ('db.client.bind_address_ipv6', 'null');
