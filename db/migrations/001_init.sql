-- ToolTrace initial schema
-- Design goals:
--   * Every business rule that must never be broken is enforced by the database,
--     not only by the API (defense in depth).
--   * Secrets (session tokens, invite tokens) are stored only as SHA-256 hashes.

-- ---------------------------------------------------------------------------
-- People and access
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('admin', 'storekeeper', 'technician', 'auditor');

CREATE TABLE users (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email             text NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '%_@_%'),
    display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
    role              user_role NOT NULL,
    -- Opaque, random handle given to authenticators (WebAuthn user.id). Never the email.
    webauthn_user_id  bytea NOT NULL UNIQUE,
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- Accounts are created only through single-use invites. There is no open sign-up.
CREATE TABLE invites (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email       text NOT NULL CHECK (email = lower(email)),
    role        user_role NOT NULL,
    token_hash  bytea NOT NULL UNIQUE,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passkeys (
    id            text PRIMARY KEY,               -- credential ID (base64url)
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key    bytea NOT NULL,                 -- COSE-encoded public key
    counter       bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
    transports    text[] NOT NULL DEFAULT '{}',
    device_type   text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
    backed_up     boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);

CREATE TABLE sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash    bytea NOT NULL UNIQUE,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

-- Server-side WebAuthn challenges: single use, short lived.
CREATE TABLE webauthn_challenges (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    challenge   text NOT NULL,
    purpose     text NOT NULL CHECK (purpose IN ('register', 'login')),
    invite_id   uuid REFERENCES invites(id) ON DELETE CASCADE,
    webauthn_user_id bytea,
    expires_at  timestamptz NOT NULL,
    CHECK (purpose <> 'register' OR (invite_id IS NOT NULL AND webauthn_user_id IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Shop floor
-- ---------------------------------------------------------------------------
CREATE TABLE locations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
    kind        text NOT NULL CHECK (kind IN ('crib', 'bay', 'line', 'external')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE tool_status AS ENUM ('available', 'checked_out', 'quarantined', 'retired');

CREATE TABLE tools (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_tag                  text NOT NULL UNIQUE CHECK (asset_tag ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
    name                       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    category                   text NOT NULL CHECK (length(category) BETWEEN 1 AND 60),
    home_location_id           uuid NOT NULL REFERENCES locations(id),
    status                     tool_status NOT NULL DEFAULT 'available',
    requires_calibration       boolean NOT NULL DEFAULT false,
    calibration_interval_days  integer CHECK (calibration_interval_days BETWEEN 1 AND 3650),
    last_calibrated_on         date,
    calibration_due_on         date,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT calibration_fields_consistent CHECK (
        NOT requires_calibration
        OR (calibration_interval_days IS NOT NULL AND calibration_due_on IS NOT NULL)
    )
);
CREATE INDEX tools_status_idx ON tools(status);
CREATE INDEX tools_calibration_due_idx ON tools(calibration_due_on) WHERE requires_calibration;

CREATE TABLE calibration_records (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_id          uuid NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    calibrated_on    date NOT NULL,
    due_on           date NOT NULL CHECK (due_on > calibrated_on),
    certificate_ref  text CHECK (length(certificate_ref) <= 120),
    performed_by     text NOT NULL CHECK (length(performed_by) BETWEEN 1 AND 120),
    recorded_by      uuid NOT NULL REFERENCES users(id),
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calibration_records_tool_idx ON calibration_records(tool_id, calibrated_on DESC);

CREATE TABLE checkouts (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_id              uuid NOT NULL REFERENCES tools(id),
    holder_id            uuid NOT NULL REFERENCES users(id),
    issued_by            uuid NOT NULL REFERENCES users(id),
    checked_out_at       timestamptz NOT NULL DEFAULT now(),
    due_back_at          timestamptz NOT NULL,
    returned_at          timestamptz,
    received_by          uuid REFERENCES users(id),
    condition_on_return  text CHECK (condition_on_return IN ('ok', 'damaged', 'needs_calibration')),
    notes                text CHECK (length(notes) <= 500),
    CHECK (due_back_at > checked_out_at),
    CHECK (returned_at IS NULL OR returned_at >= checked_out_at),
    CHECK ((returned_at IS NULL) = (condition_on_return IS NULL)),
    CHECK ((returned_at IS NULL) = (received_by IS NULL))
);
-- A tool can never be checked out twice at the same time, even under a race.
CREATE UNIQUE INDEX checkouts_one_open_per_tool ON checkouts(tool_id) WHERE returned_at IS NULL;
CREATE INDEX checkouts_holder_open_idx ON checkouts(holder_id) WHERE returned_at IS NULL;
CREATE INDEX checkouts_due_open_idx ON checkouts(due_back_at) WHERE returned_at IS NULL;

-- Calibration lockout, enforced inside the database as a last line of defense.
CREATE FUNCTION enforce_checkout_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    t tools%ROWTYPE;
BEGIN
    SELECT * INTO t FROM tools WHERE id = NEW.tool_id FOR UPDATE;
    IF t.status <> 'available' THEN
        RAISE EXCEPTION 'tool % is not available (status: %)', t.asset_tag, t.status
            USING ERRCODE = 'P0001', HINT = 'tool_unavailable';
    END IF;
    IF t.requires_calibration AND t.calibration_due_on < current_date THEN
        RAISE EXCEPTION 'tool % calibration expired on %', t.asset_tag, t.calibration_due_on
            USING ERRCODE = 'P0001', HINT = 'calibration_expired';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER checkouts_enforce_rules
    BEFORE INSERT ON checkouts
    FOR EACH ROW EXECUTE FUNCTION enforce_checkout_rules();

CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER tools_touch_updated_at
    BEFORE UPDATE ON tools
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
