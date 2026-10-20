-- An offline check-out can reach the server after its due-back time has passed
-- (taken at 22:00 for an 8-hour shift, phone back on the network the next morning).
-- The tool really is out, and late, so it must still be recorded: the due-back time
-- only has to come after the moment the tool was taken, which for an offline
-- check-out is offline_queued_at (itself bounded to the last 24 hours).

DO $$
DECLARE c text;
BEGIN
    SELECT conname INTO c FROM pg_constraint
    WHERE conrelid = 'checkouts'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) = 'CHECK ((due_back_at > checked_out_at))';
    IF c IS NOT NULL THEN
        EXECUTE format('ALTER TABLE checkouts DROP CONSTRAINT %I', c);
    END IF;
END $$;

ALTER TABLE checkouts ADD CONSTRAINT checkouts_due_after_taken
    CHECK (due_back_at > COALESCE(offline_queued_at, checked_out_at));
