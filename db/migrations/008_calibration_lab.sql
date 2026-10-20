-- Sending tools to a calibration lab, and keeping the certificate as evidence.
--
--   1. A new tool status, at_calibration: off the board (it can't be issued) but
--      not lost. The tool goes back to the crib only when a storekeeper receives it.
--   2. calibration_jobs: one trip to the lab. The lab gets a single-use link
--      (only its SHA-256 hash is stored) to enter the result and attach the
--      certificate, without an account.
--   3. calibration_certificates: the certificate file (PDF, JPEG or PNG, up to
--      3 MB), stored with its SHA-256, never changed or removed through the app.
--
-- Note: the new enum value can't be used in plain SQL in the same transaction it
-- is added in, so it only appears in function bodies here.

ALTER TYPE tool_status ADD VALUE IF NOT EXISTS 'at_calibration';

CREATE TABLE calibration_jobs (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_id                uuid NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    lab_name               text NOT NULL CHECK (length(lab_name) BETWEEN 1 AND 120),
    lab_email              text CHECK (lab_email = lower(lab_email) AND lab_email LIKE '%_@_%' AND length(lab_email) <= 254),
    notes                  text CHECK (length(notes) <= 500),
    expected_back_on       date NOT NULL,
    -- What the tool was before it left, so cancelling puts it back exactly.
    previous_status        text NOT NULL CHECK (previous_status IN ('available', 'quarantined')),
    sent_by                uuid NOT NULL REFERENCES users(id),
    sent_at                timestamptz NOT NULL DEFAULT now(),
    token_hash             bytea UNIQUE CHECK (length(token_hash) = 32),
    token_expires_at       timestamptz,
    status                 text NOT NULL DEFAULT 'at_lab' CHECK (status IN ('at_lab', 'calibrated', 'received', 'cancelled')),
    calibration_record_id  uuid REFERENCES calibration_records(id) ON DELETE SET NULL,
    results_via            text CHECK (results_via IN ('lab', 'staff')),
    results_at             timestamptz,
    outcome                text CHECK (outcome IN ('passed', 'failed')),
    closed_by              uuid REFERENCES users(id),
    closed_at              timestamptz,
    CHECK ((token_hash IS NULL) = (token_expires_at IS NULL)),
    CHECK ((status IN ('received', 'cancelled')) = (closed_at IS NOT NULL)),
    CHECK ((results_via IS NULL) = (results_at IS NULL)),
    CHECK (status <> 'calibrated' OR calibration_record_id IS NOT NULL)
);
-- A tool is at one lab at a time.
CREATE UNIQUE INDEX calibration_jobs_one_open ON calibration_jobs (tool_id) WHERE status IN ('at_lab', 'calibrated');
CREATE INDEX calibration_jobs_tool_idx ON calibration_jobs (tool_id, sent_at DESC);

CREATE TABLE calibration_certificates (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    calibration_record_id  uuid NOT NULL UNIQUE REFERENCES calibration_records(id) ON DELETE CASCADE,
    file_name              text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
    content_type           text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
    size_bytes             int NOT NULL CHECK (size_bytes BETWEEN 1 AND 3145728),
    sha256                 bytea NOT NULL CHECK (length(sha256) = 32),
    data                   bytea NOT NULL,
    uploaded_via           text NOT NULL CHECK (uploaded_via IN ('lab', 'staff')),
    uploaded_by            uuid REFERENCES users(id),
    uploaded_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (length(data) = size_bytes),
    CHECK ((uploaded_via = 'staff') = (uploaded_by IS NOT NULL))
);

-- ---------------------------------------------------------------- access
ALTER TABLE calibration_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY calibration_jobs_read ON calibration_jobs FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'auditor'));
CREATE POLICY calibration_jobs_send ON calibration_jobs FOR INSERT TO tooltrace_app
    WITH CHECK (app_role() IN ('admin', 'storekeeper') AND sent_by = app_user());
CREATE POLICY calibration_jobs_close ON calibration_jobs FOR UPDATE TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper'))
    WITH CHECK (app_role() IN ('admin', 'storekeeper') AND (closed_by IS NULL OR closed_by = app_user()));
GRANT SELECT (id, tool_id, lab_name, lab_email, notes, expected_back_on, previous_status, sent_by, sent_at,
              token_expires_at, status, calibration_record_id, results_via, results_at, outcome, closed_by, closed_at)
    ON calibration_jobs TO tooltrace_app;
GRANT INSERT ON calibration_jobs TO tooltrace_app;
GRANT UPDATE (token_hash, token_expires_at, status, calibration_record_id, results_via, results_at, outcome, closed_by, closed_at)
    ON calibration_jobs TO tooltrace_app;

-- Anyone signed in can read certificates (auditors and the shop floor need the evidence).
-- Only crib staff add them, and only to a calibration that has none yet. Never changed.
ALTER TABLE calibration_certificates ENABLE ROW LEVEL SECURITY;
CREATE POLICY calibration_certificates_read ON calibration_certificates FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'technician', 'auditor'));
CREATE POLICY calibration_certificates_add ON calibration_certificates FOR INSERT TO tooltrace_app
    WITH CHECK (app_role() IN ('admin', 'storekeeper') AND uploaded_via = 'staff' AND uploaded_by = app_user());
GRANT SELECT, INSERT ON calibration_certificates TO tooltrace_app;

-- The lab isn't a ToolTrace user, so its email (the link) goes straight to the outbox.
-- Only crib staff can queue one, and only to the address on an open calibration job.
CREATE FUNCTION enqueue_lab_email(p_job uuid, p_subject text, p_text text, p_html text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE addr text;
BEGIN
    IF app_role() NOT IN ('admin', 'storekeeper', 'none') THEN
        RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
    END IF;
    SELECT lab_email INTO addr FROM calibration_jobs WHERE id = p_job AND status = 'at_lab' AND lab_email IS NOT NULL;
    IF addr IS NULL THEN
        RETURN false;
    END IF;
    INSERT INTO email_outbox (to_address, subject, text_body, html_body)
    VALUES (addr, left(p_subject, 200), left(p_text, 20000), left(p_html, 100000));
    RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION enqueue_lab_email(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_lab_email(uuid, text, text, text) TO tooltrace_app;

-- ---------------------------------------------------------------- audit
CREATE FUNCTION audit_calibration_jobs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('calibration.sent', 'tool', NEW.tool_id::text, jsonb_build_object(
            'jobId', NEW.id, 'lab', NEW.lab_name, 'labEmail', NEW.lab_email,
            'expectedBackOn', NEW.expected_back_on, 'linkIssued', NEW.token_hash IS NOT NULL), NEW.sent_by);
    ELSIF OLD.status = 'at_lab' AND NEW.status = 'calibrated' THEN
        PERFORM audit_append('calibration.results_entered', 'tool', NEW.tool_id::text, jsonb_build_object(
            'jobId', NEW.id, 'lab', NEW.lab_name, 'via', NEW.results_via, 'recordId', NEW.calibration_record_id));
    ELSIF OLD.status <> NEW.status AND NEW.status = 'received' THEN
        PERFORM audit_append('calibration.received', 'tool', NEW.tool_id::text, jsonb_build_object(
            'jobId', NEW.id, 'lab', NEW.lab_name, 'outcome', NEW.outcome), NEW.closed_by);
    ELSIF OLD.status <> NEW.status AND NEW.status = 'cancelled' THEN
        PERFORM audit_append('calibration.cancelled', 'tool', NEW.tool_id::text, jsonb_build_object(
            'jobId', NEW.id, 'lab', NEW.lab_name), NEW.closed_by);
    ELSIF OLD.token_hash IS DISTINCT FROM NEW.token_hash AND NEW.token_hash IS NOT NULL THEN
        PERFORM audit_append('calibration.link_reissued', 'tool', NEW.tool_id::text, jsonb_build_object(
            'jobId', NEW.id, 'lab', NEW.lab_name));
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER calibration_jobs_audit AFTER INSERT OR UPDATE ON calibration_jobs
    FOR EACH ROW EXECUTE FUNCTION audit_calibration_jobs();

CREATE FUNCTION audit_calibration_certificates() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM audit_append('calibration.certificate_added', 'tool',
        (SELECT tool_id::text FROM calibration_records WHERE id = NEW.calibration_record_id),
        jsonb_build_object('recordId', NEW.calibration_record_id, 'fileName', NEW.file_name,
            'sizeBytes', NEW.size_bytes, 'sha256', encode(NEW.sha256, 'hex'), 'via', NEW.uploaded_via),
        NEW.uploaded_by);
    RETURN NULL;
END;
$$;
CREATE TRIGGER calibration_certificates_audit AFTER INSERT ON calibration_certificates
    FOR EACH ROW EXECUTE FUNCTION audit_calibration_certificates();

-- Certificates are evidence: no changes, no deletes (except when the tool itself is deleted).
CREATE FUNCTION calibration_certificates_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'calibration certificates cannot be changed' USING ERRCODE = 'P0001', HINT = 'certificate_immutable';
END;
$$;
CREATE TRIGGER calibration_certificates_no_update BEFORE UPDATE ON calibration_certificates
    FOR EACH ROW EXECUTE FUNCTION calibration_certificates_immutable();
