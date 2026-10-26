-- Server Configuration: update checks are scheduled by the Software category
-- (os-update-check -> software.update.check), which also records the last
-- check. The duplicate weekly check and its private record go away.
DELETE FROM schedules WHERE name = 'update-preferences-check';
DELETE FROM settings WHERE key = 'updates.last_check';
