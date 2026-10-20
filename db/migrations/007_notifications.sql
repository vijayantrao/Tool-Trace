-- Notifications: in the app, and by email when the server has a mail account.
--
--   notifications            one row per person per message; the bell in the app
--   email_outbox             emails waiting to be sent, written in the same transaction
--                            as the change they report (so nothing is mailed for a
--                            change that rolled back), sent by the API's worker
--   notification_preferences each person's own "email me" choice
--
-- The API never inserts into these tables directly: it calls enqueue_notification(),
-- which runs as the owner, respects the person's preference and de-duplicates
-- (a reminder is created once per dedupe key, however often the job runs).

CREATE TABLE notifications (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind ~ '^[a-z_]+\.[a-z_]+$' AND length(kind) <= 60),
    title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    body        text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
    -- Where it leads inside the app: a path such as /tools/<id>, never an outside URL.
    link        text CHECK (link ~ '^/[A-Za-z0-9/_?=&%.#-]*$' AND length(link) <= 300),
    dedupe_key  text CHECK (length(dedupe_key) <= 200),
    created_at  timestamptz NOT NULL DEFAULT now(),
    read_at     timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE notification_preferences (
    user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email       boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_outbox (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id  uuid REFERENCES notifications(id) ON DELETE SET NULL,
    to_address       text NOT NULL CHECK (to_address LIKE '%_@_%' AND length(to_address) <= 254),
    subject          text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
    text_body        text NOT NULL CHECK (length(text_body) <= 20000),
    html_body        text NOT NULL CHECK (length(html_body) <= 100000),
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts         int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    last_error       text CHECK (length(last_error) <= 500),
    created_at       timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz
);
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';

-- ---------------------------------------------------------------- access
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_own_read ON notifications FOR SELECT TO tooltrace_app USING (user_id = app_user());
CREATE POLICY notifications_own_mark ON notifications FOR UPDATE TO tooltrace_app
    USING (user_id = app_user()) WITH CHECK (user_id = app_user());
GRANT SELECT ON notifications TO tooltrace_app;
GRANT UPDATE (read_at) ON notifications TO tooltrace_app;

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_own ON notification_preferences FOR ALL TO tooltrace_app
    USING (user_id = app_user()) WITH CHECK (user_id = app_user());
GRANT SELECT, INSERT, UPDATE ON notification_preferences TO tooltrace_app;

-- Admins see delivery health (counts and the last error), never the messages themselves.
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_outbox_admin_read ON email_outbox FOR SELECT TO tooltrace_app USING (app_role() = 'admin');
GRANT SELECT (id, status, attempts, last_error, created_at, sent_at, next_attempt_at) ON email_outbox TO tooltrace_app;

-- ---------------------------------------------------------------- enqueue
-- Returns the new notification's id, or NULL if this dedupe key was already used for
-- that person (or the person is inactive). An email is queued only when the caller says
-- email is available on this server AND the person hasn't switched it off.
CREATE FUNCTION enqueue_notification(
    p_user uuid, p_kind text, p_title text, p_body text, p_link text, p_dedupe text,
    p_email boolean, p_subject text, p_text text, p_html text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    nid uuid;
    addr text;
    wants boolean;
BEGIN
    SELECT email INTO addr FROM users WHERE id = p_user AND is_active;
    IF addr IS NULL THEN
        RETURN NULL;
    END IF;
    INSERT INTO notifications (user_id, kind, title, body, link, dedupe_key)
    VALUES (p_user, p_kind, left(p_title, 200), left(coalesce(p_body, ''), 2000), p_link, p_dedupe)
    ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id INTO nid;
    IF nid IS NULL THEN
        RETURN NULL;
    END IF;
    IF p_email THEN
        SELECT coalesce((SELECT email FROM notification_preferences WHERE user_id = p_user), true) INTO wants;
        IF wants THEN
            INSERT INTO email_outbox (notification_id, to_address, subject, text_body, html_body)
            VALUES (nid, addr, left(p_subject, 200), left(p_text, 20000), left(p_html, 100000));
        END IF;
    END IF;
    RETURN nid;
END;
$$;
REVOKE EXECUTE ON FUNCTION enqueue_notification(uuid, text, text, text, text, text, boolean, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_notification(uuid, text, text, text, text, text, boolean, text, text, text) TO tooltrace_app;

-- Live: the person's bell updates the moment a notification is committed.
CREATE FUNCTION notify_notification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('tooltrace_floor', jsonb_build_object('kind', 'notification', 'userId', NEW.user_id)::text);
    RETURN NULL;
END;
$$;
CREATE TRIGGER notifications_live AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notify_notification();

-- Turning email on or off is recorded (it decides whether someone was told about an overdue tool).
CREATE FUNCTION audit_notification_preferences() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' OR OLD.email IS DISTINCT FROM NEW.email THEN
        PERFORM audit_append('notifications.preferences_changed', 'user', NEW.user_id::text,
            jsonb_build_object('email', NEW.email));
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER notification_preferences_audit AFTER INSERT OR UPDATE ON notification_preferences
    FOR EACH ROW EXECUTE FUNCTION audit_notification_preferences();
