-- Phase 4: defense in depth inside PostgreSQL.
--
--   1. A least-privilege role, tooltrace_app. Every API request runs as this
--      role (SET LOCAL ROLE), so a bug in a route can only do what the role may do.
--   2. Row-level security policies decide, per row, what each app role
--      (admin, storekeeper, technician, auditor, station) may see and change.
--   3. A tamper-evident audit log: append-only, gapless and hash-chained,
--      written by triggers so no code path can forget to record a change.

-- ===========================================================================
-- 1. The application role
-- ===========================================================================
-- Roles are cluster-wide, so several databases on one server (parallel test
-- databases, staging next to production) may run this at the same moment.
-- "Someone else just created it" is success, not an error.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tooltrace_app') THEN
        BEGIN
            CREATE ROLE tooltrace_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        EXCEPTION WHEN duplicate_object OR unique_violation THEN
            NULL;
        END;
    END IF;
    -- The account the API connects with must be able to switch into it.
    BEGIN
        EXECUTE format('GRANT tooltrace_app TO %I', current_user);
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
END
$$;

-- Request context, set per transaction by the API (SET LOCAL semantics).
CREATE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT coalesce(nullif(current_setting('tooltrace.role', true), ''), 'none') $$;
CREATE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('tooltrace.user_id', true), '')::uuid $$;
CREATE FUNCTION app_station() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('tooltrace.station_id', true), '')::uuid $$;

GRANT USAGE ON SCHEMA public TO tooltrace_app;

-- Table privileges: only what the API needs. Passkeys, WebAuthn challenges and
-- most of the sessions table are not reachable at all; they are only touched
-- by the sign-in routes, which run as the owner.
GRANT SELECT ON users TO tooltrace_app;
GRANT UPDATE (role, is_active, badge_uid) ON users TO tooltrace_app;
GRANT SELECT, INSERT, DELETE ON invites TO tooltrace_app;
GRANT SELECT (id, user_id) ON sessions TO tooltrace_app;
GRANT DELETE ON sessions TO tooltrace_app;
GRANT SELECT, INSERT ON locations TO tooltrace_app;
GRANT SELECT, INSERT ON tools TO tooltrace_app;
GRANT UPDATE (name, category, home_location_id, status, rfid_uid, last_calibrated_on, calibration_due_on)
    ON tools TO tooltrace_app;
GRANT SELECT, INSERT ON calibration_records TO tooltrace_app;
GRANT SELECT, INSERT ON checkouts TO tooltrace_app;
GRANT UPDATE (returned_at, received_by, condition_on_return, notes, returned_via_station_id)
    ON checkouts TO tooltrace_app;
GRANT SELECT, INSERT ON stations TO tooltrace_app;
GRANT UPDATE (name, is_active, key_version, last_seq, last_seen_at, session_user_id, session_expires_at)
    ON stations TO tooltrace_app;
GRANT SELECT, INSERT ON station_events TO tooltrace_app;
GRANT USAGE ON SEQUENCE station_events_id_seq TO tooltrace_app;

-- ===========================================================================
-- 2. Tool status is maintained by the database, not by API code
-- ===========================================================================
-- Check-outs and returns move the tool's status here, as the table owner, so
-- the app role never needs (and never gets) a technician's write access to tools.
CREATE FUNCTION sync_tool_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE tools SET status = 'checked_out' WHERE id = NEW.tool_id;
    ELSIF OLD.returned_at IS NULL AND NEW.returned_at IS NOT NULL THEN
        -- Anything not returned in good condition is quarantined until inspected.
        UPDATE tools SET status = CASE WHEN NEW.condition_on_return = 'ok' THEN 'available' ELSE 'quarantined' END::tool_status
        WHERE id = NEW.tool_id;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER checkouts_sync_tool_status AFTER INSERT OR UPDATE OF returned_at ON checkouts
    FOR EACH ROW EXECUTE FUNCTION sync_tool_status();

-- The calibration lockout locks the tool row, so it also runs as the owner.
ALTER FUNCTION enforce_checkout_rules() SECURITY DEFINER SET search_path = public, pg_temp;

-- ===========================================================================
-- 3. Row-level security
-- ===========================================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT TO tooltrace_app USING (true);
CREATE POLICY users_admin_update ON users FOR UPDATE TO tooltrace_app
    USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY invites_admin ON invites FOR ALL TO tooltrace_app
    USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_admin_read ON sessions FOR SELECT TO tooltrace_app USING (app_role() = 'admin');
CREATE POLICY sessions_admin_revoke ON sessions FOR DELETE TO tooltrace_app USING (app_role() = 'admin');

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY locations_read ON locations FOR SELECT TO tooltrace_app USING (true);
CREATE POLICY locations_manage ON locations FOR INSERT TO tooltrace_app
    WITH CHECK (app_role() IN ('admin', 'storekeeper'));

ALTER TABLE tools ENABLE ROW LEVEL SECURITY;
CREATE POLICY tools_read ON tools FOR SELECT TO tooltrace_app USING (true);
CREATE POLICY tools_create ON tools FOR INSERT TO tooltrace_app
    WITH CHECK (app_role() IN ('admin', 'storekeeper'));
CREATE POLICY tools_update ON tools FOR UPDATE TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper')) WITH CHECK (app_role() IN ('admin', 'storekeeper'));

ALTER TABLE calibration_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY calibrations_read ON calibration_records FOR SELECT TO tooltrace_app USING (true);
CREATE POLICY calibrations_record ON calibration_records FOR INSERT TO tooltrace_app
    WITH CHECK (app_role() IN ('admin', 'storekeeper') AND recorded_by = app_user());

ALTER TABLE checkouts ENABLE ROW LEVEL SECURITY;
-- Everyone sees what is out right now (that is the board). Past checkouts are
-- private to the holder, except for the crib staff and auditors.
CREATE POLICY checkouts_read ON checkouts FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'auditor') OR returned_at IS NULL OR holder_id = app_user());
-- Crib staff issue to anyone; technicians and stations only to the person themselves.
CREATE POLICY checkouts_issue ON checkouts FOR INSERT TO tooltrace_app
    WITH CHECK (
        app_role() IN ('admin', 'storekeeper')
        OR (app_role() IN ('technician', 'station') AND holder_id = app_user() AND issued_by = app_user())
    );
CREATE POLICY checkouts_receive ON checkouts FOR UPDATE TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'station'))
    WITH CHECK (app_role() IN ('admin', 'storekeeper', 'station') AND received_by = app_user());

ALTER TABLE stations ENABLE ROW LEVEL SECURITY;
CREATE POLICY stations_read ON stations FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'auditor') OR (app_role() = 'station' AND id = app_station()));
CREATE POLICY stations_create ON stations FOR INSERT TO tooltrace_app WITH CHECK (app_role() = 'admin');
-- A station may only ever update its own row (sequence, last seen, badge session).
CREATE POLICY stations_update ON stations FOR UPDATE TO tooltrace_app
    USING (app_role() = 'admin' OR (app_role() = 'station' AND id = app_station()))
    WITH CHECK (app_role() = 'admin' OR (app_role() = 'station' AND id = app_station()));

ALTER TABLE station_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY station_events_read ON station_events FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'auditor'));
CREATE POLICY station_events_write ON station_events FOR INSERT TO tooltrace_app
    WITH CHECK (app_role() = 'station' AND station_id = app_station());

-- ===========================================================================
-- 4. Tamper-evident audit log
-- ===========================================================================
-- Each entry's hash covers its own content and the previous entry's hash:
--   hash(n) = sha256(hash(n-1) || payload(n))
-- Changing, deleting or reordering any entry breaks every hash after it, and
-- ids are gapless, so a deleted entry shows up as a gap. Publishing the latest
-- hash (an "anchor") makes even a full rewrite of the chain detectable.
CREATE TABLE audit_log (
    id                bigint PRIMARY KEY,
    at                timestamptz NOT NULL,
    actor_user_id     uuid,
    actor_station_id  uuid,
    actor_ip          text,
    action            text NOT NULL,
    entity_type       text NOT NULL,
    entity_id         text,
    details           jsonb NOT NULL DEFAULT '{}',
    prev_hash         bytea NOT NULL CHECK (length(prev_hash) = 32),
    hash              bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, id DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, id DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT TO tooltrace_app USING (app_role() IN ('admin', 'auditor'));
GRANT SELECT ON audit_log TO tooltrace_app;

-- The exact text that is hashed. The API's verifier rebuilds the same text.
CREATE FUNCTION audit_payload(
    p_id bigint, p_at timestamptz, p_actor_user uuid, p_actor_station uuid, p_actor_ip text,
    p_action text, p_entity_type text, p_entity_id text, p_details jsonb
) RETURNS text LANGUAGE sql STABLE AS $$
    SELECT concat_ws('|',
        p_id::text,
        to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        coalesce(p_actor_user::text, ''),
        coalesce(p_actor_station::text, ''),
        coalesce(p_actor_ip, ''),
        p_action, p_entity_type, coalesce(p_entity_id, ''),
        p_details::text)
$$;

-- Serialises writers so ids stay gapless and every entry links to the true previous one.
-- The API takes this same lock at the start of every write transaction, so locks
-- are always taken in the same order and writers can't deadlock.
CREATE FUNCTION audit_append(
    p_action text, p_entity_type text, p_entity_id text, p_details jsonb, p_actor_user uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    last_id    bigint;
    last_hash  bytea;
    new_id     bigint;
    ts         timestamptz := clock_timestamp();
    actor      uuid := coalesce(p_actor_user, app_user());
    station    uuid := app_station();
    ip         text := nullif(current_setting('tooltrace.ip', true), '');
    payload    text;
BEGIN
    PERFORM pg_advisory_xact_lock(727274100);
    SELECT id, hash INTO last_id, last_hash FROM audit_log ORDER BY id DESC LIMIT 1;
    new_id := coalesce(last_id, 0) + 1;
    last_hash := coalesce(last_hash, decode(repeat('00', 32), 'hex'));
    payload := audit_payload(new_id, ts, actor, station, ip, p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'));
    INSERT INTO audit_log (id, at, actor_user_id, actor_station_id, actor_ip, action, entity_type, entity_id, details, prev_hash, hash)
    VALUES (new_id, ts, actor, station, ip, p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'),
            last_hash, sha256(last_hash || convert_to(payload, 'UTF8')));
END;
$$;
REVOKE EXECUTE ON FUNCTION audit_append(text, text, text, jsonb, uuid) FROM PUBLIC;

-- Append-only: no updates, deletes or truncation, by anyone, through SQL.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'P0001', HINT = 'audit_immutable';
END;
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Helper: {"field": [old, new]} for the fields that changed.
CREATE FUNCTION jsonb_changes(old_row jsonb, new_row jsonb, fields text[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(jsonb_object_agg(f, jsonb_build_array(old_row -> f, new_row -> f)), '{}')
    FROM unnest(fields) AS f
    WHERE old_row -> f IS DISTINCT FROM new_row -> f
$$;

-- ----------------------------------------------------------------- triggers
CREATE FUNCTION audit_users() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE changes jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('user.registered', 'user', NEW.id::text,
            jsonb_build_object('displayName', NEW.display_name, 'email', NEW.email, 'role', NEW.role), NEW.id);
    ELSE
        changes := jsonb_changes(to_jsonb(OLD), to_jsonb(NEW), ARRAY['role', 'is_active', 'badge_uid', 'display_name']);
        IF changes <> '{}' THEN
            PERFORM audit_append('user.updated', 'user', NEW.id::text, jsonb_build_object('changes', changes));
        END IF;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER users_audit AFTER INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION audit_users();

CREATE FUNCTION audit_invites() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('invite.created', 'invite', NEW.id::text,
            jsonb_build_object('email', NEW.email, 'role', NEW.role, 'expiresAt', NEW.expires_at), NEW.created_by);
    ELSIF TG_OP = 'DELETE' AND OLD.used_at IS NULL THEN
        PERFORM audit_append('invite.revoked', 'invite', OLD.id::text, jsonb_build_object('email', OLD.email));
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER invites_audit AFTER INSERT OR DELETE ON invites FOR EACH ROW EXECUTE FUNCTION audit_invites();

CREATE FUNCTION audit_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM audit_append('auth.signed_in', 'user', NEW.user_id::text,
        jsonb_build_object('userAgent', left(coalesce(NEW.user_agent, ''), 160)), NEW.user_id);
    RETURN NULL;
END;
$$;
CREATE TRIGGER sessions_audit AFTER INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION audit_sessions();

CREATE FUNCTION audit_locations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM audit_append('location.created', 'location', NEW.id::text, jsonb_build_object('name', NEW.name, 'kind', NEW.kind));
    RETURN NULL;
END;
$$;
CREATE TRIGGER locations_audit AFTER INSERT ON locations FOR EACH ROW EXECUTE FUNCTION audit_locations();

CREATE FUNCTION audit_tools() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE changes jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('tool.created', 'tool', NEW.id::text, jsonb_build_object(
            'assetTag', NEW.asset_tag, 'name', NEW.name, 'category', NEW.category,
            'requiresCalibration', NEW.requires_calibration, 'rfidUid', NEW.rfid_uid));
        RETURN NULL;
    END IF;
    changes := jsonb_changes(to_jsonb(OLD), to_jsonb(NEW), ARRAY['name', 'category', 'home_location_id', 'rfid_uid']);
    -- Status moves caused by check-outs and returns are logged as those events instead.
    IF OLD.status <> NEW.status AND OLD.status <> 'checked_out' AND NEW.status <> 'checked_out' THEN
        changes := changes || jsonb_build_object('status', jsonb_build_array(OLD.status, NEW.status));
    END IF;
    IF changes <> '{}' THEN
        PERFORM audit_append('tool.updated', 'tool', NEW.id::text,
            jsonb_build_object('assetTag', NEW.asset_tag, 'changes', changes));
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER tools_audit AFTER INSERT OR UPDATE ON tools FOR EACH ROW EXECUTE FUNCTION audit_tools();

CREATE FUNCTION audit_calibrations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM audit_append('calibration.recorded', 'tool', NEW.tool_id::text, jsonb_build_object(
        'calibratedOn', NEW.calibrated_on, 'dueOn', NEW.due_on,
        'certificateRef', NEW.certificate_ref, 'performedBy', NEW.performed_by), NEW.recorded_by);
    RETURN NULL;
END;
$$;
CREATE TRIGGER calibrations_audit AFTER INSERT ON calibration_records FOR EACH ROW EXECUTE FUNCTION audit_calibrations();

CREATE FUNCTION audit_checkouts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('tool.checked_out', 'tool', NEW.tool_id::text, jsonb_build_object(
            'checkoutId', NEW.id, 'holderId', NEW.holder_id, 'dueBackAt', NEW.due_back_at,
            'stationId', NEW.issued_via_station_id), NEW.issued_by);
    ELSIF OLD.returned_at IS NULL AND NEW.returned_at IS NOT NULL THEN
        PERFORM audit_append('tool.returned', 'tool', NEW.tool_id::text, jsonb_build_object(
            'checkoutId', NEW.id, 'condition', NEW.condition_on_return, 'notes', NEW.notes,
            'stationId', NEW.returned_via_station_id), NEW.received_by);
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER checkouts_audit AFTER INSERT OR UPDATE ON checkouts FOR EACH ROW EXECUTE FUNCTION audit_checkouts();

CREATE FUNCTION audit_stations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE changes jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('station.created', 'station', NEW.id::text, jsonb_build_object('name', NEW.name));
        RETURN NULL;
    END IF;
    IF OLD.key_version <> NEW.key_version THEN
        PERFORM audit_append('station.key_rotated', 'station', NEW.id::text,
            jsonb_build_object('name', NEW.name, 'keyVersion', NEW.key_version));
    END IF;
    changes := jsonb_changes(to_jsonb(OLD), to_jsonb(NEW), ARRAY['name', 'is_active']);
    IF changes <> '{}' THEN
        PERFORM audit_append('station.updated', 'station', NEW.id::text, jsonb_build_object('changes', changes));
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER stations_audit AFTER INSERT OR UPDATE ON stations FOR EACH ROW EXECUTE FUNCTION audit_stations();

-- Security-relevant station rejections (forgeries, replays...) also go to the audit trail.
CREATE FUNCTION audit_station_rejections() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM audit_append('station.message_rejected', 'station', NEW.station_id::text,
        jsonb_build_object('code', NEW.code, 'eventId', NEW.id));
    RETURN NULL;
END;
$$;
CREATE TRIGGER station_events_audit AFTER INSERT ON station_events FOR EACH ROW
    WHEN (NEW.outcome = 'rejected' AND NEW.code IN ('bad_signature', 'replay', 'stale_clock', 'malformed', 'station_inactive'))
    EXECUTE FUNCTION audit_station_rejections();
