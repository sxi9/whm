-- Accounts created before 034 have no manager; the owner created them and
-- already sees the thread, so it becomes the manager until someone is picked.
UPDATE accounts SET manager_user_id = owner_id WHERE manager_user_id IS NULL;
