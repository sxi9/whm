-- Resellers: a users.role = 'reseller' row with no reseller_acls rows is
-- unrestricted by ACLs (integration contract 10). Every API path writes the
-- full set, so such rows only come from hand edits or pre-015 data; give them
-- the default ACL list instead of every privilege.
INSERT OR IGNORE INTO reseller_acls (reseller_id, acl_key, value)
SELECT u.id, k.value, 1
  FROM users u, json_each((SELECT acls_json FROM reseller_acl_lists WHERE name = 'standard')) k
 WHERE u.role = 'reseller'
   AND NOT EXISTS (SELECT 1 FROM reseller_acls a WHERE a.reseller_id = u.id);
