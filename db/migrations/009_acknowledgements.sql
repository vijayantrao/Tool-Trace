-- Acknowledgements: when a storekeeper issues something to someone else, that
-- person confirms they really received it (in the app, or with the single-use
-- link in their email), or says they didn't. Until then it shows as pending.
-- Taking a tool yourself (phone, station, offline) needs no acknowledgement.
--
-- One table for every kind of issue: a tool check-out, a stock issue (PPE,
-- consumables) or a whole kit. subject_id points into the matching table.

CREATE TABLE acknowledgements (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_type  text NOT NULL CHECK (subject_type IN ('checkout', 'stock_issue', 'kit_issue')),
    subject_id    uuid NOT NULL,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_by  uuid NOT NULL REFERENCES users(id),
    summary       text NOT NULL CHECK (length(summary) BETWEEN 1 AND 200),
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'disputed')),
    token_hash    bytea UNIQUE CHECK (length(token_hash) = 32),
    responded_at  timestamptz,
    responded_via text CHECK (responded_via IN ('app', 'email')),
    note          text CHECK (length(note) <= 300),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (subject_type, subject_id),
    CHECK (user_id <> requested_by),
    CHECK ((status = 'pending') = (responded_at IS NULL)),
    CHECK ((responded_at IS NULL) = (responded_via IS NULL)),
    -- The link works once: answered means it is gone.
    CHECK (status = 'pending' OR token_hash IS NULL)
);
CREATE INDEX acknowledgements_user_idx ON acknowledgements (user_id) WHERE status = 'pending';

ALTER TABLE acknowledgements ENABLE ROW LEVEL SECURITY;
CREATE POLICY acknowledgements_read ON acknowledgements FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'auditor') OR user_id = app_user());
CREATE POLICY acknowledgements_request ON acknowledgements FOR INSERT TO tooltrace_app
    WITH CHECK (app_role() IN ('admin', 'storekeeper') AND requested_by = app_user());
-- Only the person it was issued to can answer.
CREATE POLICY acknowledgements_answer ON acknowledgements FOR UPDATE TO tooltrace_app
    USING (user_id = app_user()) WITH CHECK (user_id = app_user());
GRANT SELECT (id, subject_type, subject_id, user_id, requested_by, summary, status, responded_at, responded_via, note, created_at)
    ON acknowledgements TO tooltrace_app;
GRANT INSERT ON acknowledgements TO tooltrace_app;
GRANT UPDATE (status, token_hash, responded_at, responded_via, note) ON acknowledgements TO tooltrace_app;

CREATE FUNCTION audit_acknowledgements() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF OLD.status = 'pending' AND NEW.status <> 'pending' THEN
        PERFORM audit_append(
            CASE NEW.status WHEN 'acknowledged' THEN 'issue.acknowledged' ELSE 'issue.disputed' END,
            NEW.subject_type, NEW.subject_id::text,
            jsonb_build_object('acknowledgementId', NEW.id, 'summary', NEW.summary, 'via', NEW.responded_via, 'note', NEW.note),
            NEW.user_id);
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER acknowledgements_audit AFTER UPDATE ON acknowledgements
    FOR EACH ROW EXECUTE FUNCTION audit_acknowledgements();

-- The board shows "awaiting confirmation" live.
CREATE FUNCTION notify_acknowledgement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('tooltrace_floor', jsonb_build_object('kind', 'acknowledgement', 'userId', NEW.user_id)::text);
    RETURN NULL;
END;
$$;
CREATE TRIGGER acknowledgements_live AFTER INSERT OR UPDATE ON acknowledgements
    FOR EACH ROW EXECUTE FUNCTION notify_acknowledgement();
