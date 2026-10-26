-- Email: outbound source addresses applied through "Configure Remote Service
-- IPs" (ctx.mail.setOutboundAddresses). Empty = Exim picks the interface.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('mail.outbound.ipv4', '""'),
  ('mail.outbound.ipv6', '""');
