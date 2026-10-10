-- Phase 3: smart tool stations (ESP32 + RFID), badges, tool tags, live events.

-- ---------------------------------------------------------------------------
-- RFID identities. UIDs are stored normalised: uppercase hex, no separators.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN badge_uid text UNIQUE
    CHECK (badge_uid ~ '^([0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$');
ALTER TABLE tools ADD COLUMN rfid_uid text UNIQUE
    CHECK (rfid_uid ~ '^([0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$');

-- One physical tag can be a badge or a tool tag, never both.
-- (Two functions: PL/pgSQL does not short-circuit field access on NEW.)
CREATE FUNCTION enforce_badge_not_tool() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.badge_uid IS NOT NULL AND EXISTS (SELECT 1 FROM tools WHERE rfid_uid = NEW.badge_uid) THEN
        RAISE EXCEPTION 'RFID tag % is already a tool tag', NEW.badge_uid
            USING ERRCODE = 'P0001', HINT = 'uid_in_use';
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION enforce_tool_tag_not_badge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.rfid_uid IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE badge_uid = NEW.rfid_uid) THEN
        RAISE EXCEPTION 'RFID tag % is already a badge', NEW.rfid_uid
            USING ERRCODE = 'P0001', HINT = 'uid_in_use';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER users_uid_exclusive BEFORE INSERT OR UPDATE OF badge_uid ON users
    FOR EACH ROW EXECUTE FUNCTION enforce_badge_not_tool();
CREATE TRIGGER tools_uid_exclusive BEFORE INSERT OR UPDATE OF rfid_uid ON tools
    FOR EACH ROW EXECUTE FUNCTION enforce_tool_tag_not_badge();

-- ---------------------------------------------------------------------------
-- Stations
-- ---------------------------------------------------------------------------
CREATE TABLE stations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
    location_id         uuid NOT NULL REFERENCES locations(id),
    is_active           boolean NOT NULL DEFAULT true,
    -- The signing key is never stored: it is derived from a server master key
    -- and this version number. Rotating = bumping the version.
    key_version         integer NOT NULL DEFAULT 1 CHECK (key_version >= 1),
    -- Highest message sequence (epoch milliseconds) accepted. Replays are rejected.
    last_seq            bigint NOT NULL DEFAULT 0,
    last_seen_at        timestamptz,
    -- Who badged in at this station, for the next tool tap.
    session_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    session_expires_at  timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE station_events (
    id           bigserial PRIMARY KEY,
    station_id   uuid NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    received_at  timestamptz NOT NULL DEFAULT now(),
    kind         text NOT NULL CHECK (kind IN ('hello', 'tap')),
    uid          text,
    outcome      text NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
    code         text NOT NULL,
    user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
    tool_id      uuid REFERENCES tools(id) ON DELETE SET NULL
);
CREATE INDEX station_events_recent_idx ON station_events (received_at DESC);
CREATE INDEX station_events_station_idx ON station_events (station_id, received_at DESC);

ALTER TABLE checkouts
    ADD COLUMN issued_via_station_id uuid REFERENCES stations(id) ON DELETE SET NULL,
    ADD COLUMN returned_via_station_id uuid REFERENCES stations(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Live updates. Notifications are delivered only when the transaction commits,
-- so listeners never see changes that were rolled back. Every change is
-- covered, whether it came from the web app, a station, or a direct SQL fix.
-- ---------------------------------------------------------------------------
CREATE FUNCTION notify_floor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    kind text;
    payload jsonb;
BEGIN
    IF TG_TABLE_NAME = 'checkouts' THEN
        kind := CASE
            WHEN TG_OP = 'INSERT' THEN 'checked_out'
            WHEN OLD.returned_at IS NULL AND NEW.returned_at IS NOT NULL THEN 'returned'
            ELSE 'checkout_updated'
        END;
        payload := jsonb_build_object('kind', kind, 'checkoutId', NEW.id, 'toolId', NEW.tool_id);
    ELSIF TG_TABLE_NAME = 'tools' THEN
        payload := jsonb_build_object('kind', 'tool_changed', 'toolId', NEW.id);
    ELSIF TG_TABLE_NAME = 'station_events' THEN
        payload := jsonb_build_object('kind', 'station_event', 'stationId', NEW.station_id, 'eventId', NEW.id);
    END IF;
    PERFORM pg_notify('tooltrace_floor', payload::text);
    RETURN NULL;
END;
$$;

CREATE TRIGGER checkouts_notify AFTER INSERT OR UPDATE ON checkouts
    FOR EACH ROW EXECUTE FUNCTION notify_floor();
CREATE TRIGGER tools_notify AFTER INSERT OR UPDATE ON tools
    FOR EACH ROW EXECUTE FUNCTION notify_floor();
CREATE TRIGGER station_events_notify AFTER INSERT ON station_events
    FOR EACH ROW EXECUTE FUNCTION notify_floor();
