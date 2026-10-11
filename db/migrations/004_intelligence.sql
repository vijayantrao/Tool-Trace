-- Phase 5: intelligence and offline sync.
--
--   1. tooltrace_ml: the role the nightly ML job runs as. It can read only the
--      columns it learns from (no emails, names or notes) and write only its
--      own results.
--   2. ml_runs, risk_scores, anomalies: model results, visible to crib staff
--      and auditors only. Anomalies are reviewed by people, and every run and
--      review is in the audit trail.
--   3. idempotency_keys: lets a phone replay actions it queued while offline
--      without ever applying one twice.
--   4. checkouts.offline_queued_at: when an offline check-out was really made.

-- ===========================================================================
-- 1. The ML role
-- ===========================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tooltrace_ml') THEN
        BEGIN
            CREATE ROLE tooltrace_ml NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        EXCEPTION WHEN duplicate_object OR unique_violation THEN
            NULL;
        END;
    END IF;
    BEGIN
        EXECUTE format('GRANT tooltrace_ml TO %I', current_user);
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
END
$$;
GRANT USAGE ON SCHEMA public TO tooltrace_ml;

-- ===========================================================================
-- 2. Offline check-outs
-- ===========================================================================
-- The server's time stays authoritative (checked_out_at). This records when the
-- person actually made the check-out on a phone with no signal, and is bounded
-- so a client can't claim an arbitrary past.
ALTER TABLE checkouts ADD COLUMN offline_queued_at timestamptz,
    ADD CONSTRAINT checkouts_offline_queued_bounds CHECK (
        offline_queued_at IS NULL OR (
            offline_queued_at <= checked_out_at + interval '5 minutes'
            AND offline_queued_at >= checked_out_at - interval '24 hours'));

CREATE OR REPLACE FUNCTION audit_checkouts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('tool.checked_out', 'tool', NEW.tool_id::text, jsonb_build_object(
            'checkoutId', NEW.id, 'holderId', NEW.holder_id, 'dueBackAt', NEW.due_back_at,
            'stationId', NEW.issued_via_station_id)
            || CASE WHEN NEW.offline_queued_at IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('offlineQueuedAt', NEW.offline_queued_at) END,
            NEW.issued_by);
    ELSIF OLD.returned_at IS NULL AND NEW.returned_at IS NOT NULL THEN
        PERFORM audit_append('tool.returned', 'tool', NEW.tool_id::text, jsonb_build_object(
            'checkoutId', NEW.id, 'condition', NEW.condition_on_return, 'notes', NEW.notes,
            'stationId', NEW.returned_via_station_id), NEW.received_by);
    END IF;
    RETURN NULL;
END;
$$;

-- ===========================================================================
-- 3. Idempotency keys
-- ===========================================================================
-- One row per (person, key). The API inserts the row first, inside the same
-- transaction as the action, so a replay either waits for the original and
-- gets its stored answer, or finds nothing because the original rolled back.
CREATE TABLE idempotency_keys (
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key           uuid NOT NULL,
    request_hash  bytea NOT NULL CHECK (length(request_hash) = 32),
    status        int CHECK (status BETWEEN 200 AND 299),
    response      jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY idempotency_own ON idempotency_keys FOR ALL TO tooltrace_app
    USING (user_id = app_user()) WITH CHECK (user_id = app_user());
GRANT SELECT, INSERT ON idempotency_keys TO tooltrace_app;
GRANT UPDATE (status, response) ON idempotency_keys TO tooltrace_app;

-- ===========================================================================
-- 4. Model results
-- ===========================================================================
CREATE TABLE ml_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
    model_version  text NOT NULL CHECK (length(model_version) <= 80),
    trained_on     int CHECK (trained_on >= 0),
    metrics        jsonb NOT NULL DEFAULT '{}',
    error          text CHECK (length(error) <= 2000),
    CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX ml_runs_started_idx ON ml_runs (started_at DESC);

-- The latest score for each open checkout.
CREATE TABLE risk_scores (
    checkout_id       uuid PRIMARY KEY REFERENCES checkouts(id) ON DELETE CASCADE,
    run_id            uuid NOT NULL REFERENCES ml_runs(id),
    late_probability  real NOT NULL CHECK (late_probability BETWEEN 0 AND 1),
    loss_probability  real NOT NULL CHECK (loss_probability BETWEEN 0 AND 1),
    factors           jsonb NOT NULL DEFAULT '[]',
    scored_at         timestamptz NOT NULL DEFAULT now()
);

-- Unusual check-outs, flagged once each, then confirmed or dismissed by a person.
CREATE TABLE anomalies (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    checkout_id   uuid NOT NULL UNIQUE REFERENCES checkouts(id) ON DELETE CASCADE,
    run_id        uuid NOT NULL REFERENCES ml_runs(id),
    score         real NOT NULL,
    reasons       jsonb NOT NULL DEFAULT '[]',
    detected_at   timestamptz NOT NULL DEFAULT now(),
    status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'dismissed')),
    reviewed_by   uuid REFERENCES users(id),
    reviewed_at   timestamptz,
    review_note   text CHECK (length(review_note) <= 500),
    CHECK ((status = 'open') = (reviewed_by IS NULL)),
    CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);
CREATE INDEX anomalies_status_idx ON anomalies (status, detected_at DESC);

-- Staff and auditors see results; technicians never see scores about anyone.
ALTER TABLE ml_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE anomalies ENABLE ROW LEVEL SECURITY;
CREATE POLICY ml_runs_read ON ml_runs FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'auditor'));
CREATE POLICY risk_scores_read ON risk_scores FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'auditor'));
CREATE POLICY anomalies_read ON anomalies FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'auditor'));
CREATE POLICY anomalies_review ON anomalies FOR UPDATE TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper'))
    WITH CHECK (app_role() IN ('admin', 'storekeeper') AND reviewed_by = app_user());
GRANT SELECT ON ml_runs, risk_scores, anomalies TO tooltrace_app;
GRANT UPDATE (status, reviewed_by, reviewed_at, review_note) ON anomalies TO tooltrace_app;

-- The ML job: reads only what it learns from, writes only its own tables.
GRANT SELECT (id, role, is_active) ON users TO tooltrace_ml;
GRANT SELECT (id, asset_tag, category, requires_calibration, status) ON tools TO tooltrace_ml;
GRANT SELECT (id, tool_id, holder_id, issued_by, checked_out_at, due_back_at, returned_at,
              condition_on_return, issued_via_station_id, offline_queued_at) ON checkouts TO tooltrace_ml;
GRANT SELECT, INSERT, UPDATE ON ml_runs TO tooltrace_ml;
GRANT SELECT, INSERT, UPDATE, DELETE ON risk_scores TO tooltrace_ml;
GRANT SELECT, INSERT ON anomalies TO tooltrace_ml;
CREATE POLICY ml_reads_users ON users FOR SELECT TO tooltrace_ml USING (true);
CREATE POLICY ml_reads_tools ON tools FOR SELECT TO tooltrace_ml USING (true);
CREATE POLICY ml_reads_checkouts ON checkouts FOR SELECT TO tooltrace_ml USING (true);
CREATE POLICY ml_runs_job ON ml_runs FOR ALL TO tooltrace_ml USING (true) WITH CHECK (true);
CREATE POLICY risk_scores_job ON risk_scores FOR ALL TO tooltrace_ml USING (true) WITH CHECK (true);
CREATE POLICY anomalies_job_read ON anomalies FOR SELECT TO tooltrace_ml USING (true);
CREATE POLICY anomalies_job_flag ON anomalies FOR INSERT TO tooltrace_ml WITH CHECK (status = 'open');

-- ===========================================================================
-- 5. Audit trail for model runs and anomaly reviews
-- ===========================================================================
CREATE FUNCTION audit_ml_runs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF OLD.status = 'running' AND NEW.status <> 'running' THEN
        PERFORM audit_append(CASE NEW.status WHEN 'succeeded' THEN 'ml.run_completed' ELSE 'ml.run_failed' END,
            'ml_run', NEW.id::text, jsonb_build_object(
                'modelVersion', NEW.model_version, 'trainedOn', NEW.trained_on,
                'metrics', NEW.metrics, 'error', NEW.error));
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER ml_runs_audit AFTER UPDATE ON ml_runs FOR EACH ROW EXECUTE FUNCTION audit_ml_runs();

CREATE FUNCTION audit_anomalies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('anomaly.flagged', 'checkout', NEW.checkout_id::text, jsonb_build_object(
            'anomalyId', NEW.id, 'runId', NEW.run_id, 'score', round(NEW.score::numeric, 4),
            'reasons', (SELECT coalesce(jsonb_agg(r -> 'key'), '[]') FROM jsonb_array_elements(NEW.reasons) r)));
    ELSIF OLD.status IS DISTINCT FROM NEW.status OR OLD.review_note IS DISTINCT FROM NEW.review_note THEN
        PERFORM audit_append('anomaly.reviewed', 'checkout', NEW.checkout_id::text, jsonb_build_object(
            'anomalyId', NEW.id, 'status', NEW.status, 'note', NEW.review_note), NEW.reviewed_by);
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER anomalies_audit AFTER INSERT OR UPDATE ON anomalies FOR EACH ROW EXECUTE FUNCTION audit_anomalies();
