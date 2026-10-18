-- Data sources: bring the tool list in from Excel or another database, or keep
-- a copy of ToolTrace's tools in one (like Power Apps' "Start with data").
--
-- ToolTrace's own database stays the system of record, so the calibration
-- lock, row-level security and the audit trail keep applying to every change
-- an import makes. Admins only.

-- A saved database connection. The password is encrypted by the API
-- (AES-256-GCM, key outside the database) and never leaves the API again.
CREATE TABLE data_sources (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
    kind            text NOT NULL CHECK (kind IN ('mysql', 'postgres', 'mssql')),
    -- import: read tools from a table in it. mirror: ToolTrace created a table there and keeps it filled.
    mode            text NOT NULL CHECK (mode IN ('import', 'mirror')),
    host            text NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
    port            integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
    database_name   text NOT NULL CHECK (length(database_name) BETWEEN 1 AND 128),
    username        text NOT NULL CHECK (length(username) BETWEEN 1 AND 128),
    secret          bytea NOT NULL CHECK (length(secret) BETWEEN 29 AND 2048),
    -- verify: encrypted, certificate checked. require: encrypted, any certificate. off: plain text.
    tls             text NOT NULL DEFAULT 'verify' CHECK (tls IN ('verify', 'require', 'off')),
    table_name      text CHECK (length(table_name) BETWEEN 1 AND 128),
    -- import only: ToolTrace field -> source column
    mapping         jsonb NOT NULL DEFAULT '{}',
    schedule        text NOT NULL DEFAULT 'manual' CHECK (schedule IN ('manual', 'hourly', 'daily')),
    next_sync_at    timestamptz,
    last_sync_at    timestamptz,
    last_sync_ok    boolean,
    last_sync_message text CHECK (length(last_sync_message) <= 500),
    created_by      uuid NOT NULL REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (mode = 'import' OR table_name IS NOT NULL)
);
CREATE INDEX data_sources_due_idx ON data_sources (next_sync_at) WHERE schedule <> 'manual';
CREATE TRIGGER data_sources_touch_updated_at BEFORE UPDATE ON data_sources
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Every import and copy, from a file or a database: what came in, what changed.
CREATE TABLE data_sync_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id     uuid REFERENCES data_sources(id) ON DELETE SET NULL,
    source_label  text NOT NULL CHECK (length(source_label) BETWEEN 1 AND 200),
    kind          text NOT NULL CHECK (kind IN ('excel', 'csv', 'mysql', 'postgres', 'mssql')),
    direction     text NOT NULL CHECK (direction IN ('import', 'mirror')),
    trigger       text NOT NULL CHECK (trigger IN ('manual', 'schedule')),
    ok            boolean NOT NULL,
    summary       jsonb NOT NULL DEFAULT '{}',
    run_by        uuid NOT NULL REFERENCES users(id),
    at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_sync_runs_at_idx ON data_sync_runs (at DESC);

ALTER TABLE data_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_sources_admin ON data_sources FOR ALL TO tooltrace_app
    USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');
ALTER TABLE data_sync_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_sync_runs_read ON data_sync_runs FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'auditor'));
CREATE POLICY data_sync_runs_write ON data_sync_runs FOR INSERT TO tooltrace_app
    WITH CHECK (app_role() = 'admin' AND run_by = app_user());

GRANT SELECT, INSERT, DELETE ON data_sources TO tooltrace_app;
GRANT UPDATE (name, secret, tls, table_name, mapping, schedule, next_sync_at,
              last_sync_at, last_sync_ok, last_sync_message) ON data_sources TO tooltrace_app;
GRANT SELECT, INSERT ON data_sync_runs TO tooltrace_app;

-- ----------------------------------------------------------------- audit
-- Connection details are recorded; the encrypted password never is (only that it changed).
CREATE FUNCTION audit_data_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE changes jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('data.source_added', 'data_source', NEW.id::text, jsonb_build_object(
            'name', NEW.name, 'kind', NEW.kind, 'mode', NEW.mode, 'host', NEW.host, 'port', NEW.port,
            'database', NEW.database_name, 'username', NEW.username, 'tls', NEW.tls, 'table', NEW.table_name));
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM audit_append('data.source_removed', 'data_source', OLD.id::text, jsonb_build_object('name', OLD.name));
    ELSE
        changes := jsonb_changes(to_jsonb(OLD), to_jsonb(NEW), ARRAY['name', 'tls', 'table_name', 'mapping', 'schedule']);
        IF OLD.secret <> NEW.secret THEN
            changes := changes || jsonb_build_object('password', 'changed');
        END IF;
        IF changes <> '{}' THEN
            PERFORM audit_append('data.source_updated', 'data_source', NEW.id::text,
                jsonb_build_object('name', NEW.name, 'changes', changes));
        END IF;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER data_sources_audit AFTER INSERT OR UPDATE OR DELETE ON data_sources
    FOR EACH ROW EXECUTE FUNCTION audit_data_sources();

CREATE FUNCTION audit_data_sync_runs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM audit_append(
        CASE WHEN NEW.direction = 'import' THEN 'data.tools_imported' ELSE 'data.tools_copied' END,
        'data_source', coalesce(NEW.source_id::text, NEW.source_label),
        jsonb_build_object('source', NEW.source_label, 'kind', NEW.kind, 'trigger', NEW.trigger,
                           'ok', NEW.ok, 'summary', NEW.summary),
        NEW.run_by);
    RETURN NULL;
END;
$$;
CREATE TRIGGER data_sync_runs_audit AFTER INSERT ON data_sync_runs
    FOR EACH ROW EXECUTE FUNCTION audit_data_sync_runs();
