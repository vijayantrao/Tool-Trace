-- Tool kits: a set of tools (a socket set, an electrician's kit) issued and
-- returned together with one scan.
--
--   kits         the kit itself, with its own asset tag and QR label
--   kit_items    which tools belong to it (a tool is in at most one kit)
--   kit_issues   one issue of a whole kit; each tool in it still gets its own
--                check-out, so every rule (calibration lock, one holder at a time)
--                still applies to every piece, and a piece can come back on its own.

CREATE TABLE kits (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_tag         text NOT NULL UNIQUE CHECK (asset_tag ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
    name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    home_location_id  uuid NOT NULL REFERENCES locations(id),
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER kits_touch_updated_at BEFORE UPDATE ON kits FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE kit_items (
    kit_id    uuid NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
    tool_id   uuid NOT NULL UNIQUE REFERENCES tools(id) ON DELETE CASCADE,
    added_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kit_id, tool_id)
);

CREATE TABLE kit_issues (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kit_id       uuid NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
    holder_id    uuid NOT NULL REFERENCES users(id),
    issued_by    uuid NOT NULL REFERENCES users(id),
    issued_at    timestamptz NOT NULL DEFAULT now(),
    due_back_at  timestamptz NOT NULL,
    CHECK (due_back_at > issued_at)
);
CREATE INDEX kit_issues_kit_idx ON kit_issues (kit_id, issued_at DESC);

ALTER TABLE checkouts ADD COLUMN kit_issue_id uuid REFERENCES kit_issues(id) ON DELETE SET NULL;
CREATE INDEX checkouts_kit_issue_idx ON checkouts (kit_issue_id) WHERE kit_issue_id IS NOT NULL;

-- A scanned tag must mean one thing: kit tags and tool tags never overlap.
CREATE FUNCTION enforce_kit_tag_unique() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM tools WHERE asset_tag = NEW.asset_tag) THEN
        RAISE EXCEPTION 'asset tag % is already a tool', NEW.asset_tag USING ERRCODE = 'P0001', HINT = 'tag_in_use';
    END IF;
    RETURN NEW;
END;
$$;
CREATE FUNCTION enforce_tool_tag_not_kit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM kits WHERE asset_tag = NEW.asset_tag) THEN
        RAISE EXCEPTION 'asset tag % is already a kit', NEW.asset_tag USING ERRCODE = 'P0001', HINT = 'tag_in_use';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER kits_tag_unique BEFORE INSERT OR UPDATE OF asset_tag ON kits FOR EACH ROW EXECUTE FUNCTION enforce_kit_tag_unique();
CREATE TRIGGER tools_tag_not_kit BEFORE INSERT OR UPDATE OF asset_tag ON tools FOR EACH ROW EXECUTE FUNCTION enforce_tool_tag_not_kit();

-- ---------------------------------------------------------------- access
ALTER TABLE kits ENABLE ROW LEVEL SECURITY;
CREATE POLICY kits_read ON kits FOR SELECT TO tooltrace_app USING (true);
CREATE POLICY kits_manage ON kits FOR INSERT TO tooltrace_app WITH CHECK (app_role() IN ('admin', 'storekeeper'));
CREATE POLICY kits_update ON kits FOR UPDATE TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper')) WITH CHECK (app_role() IN ('admin', 'storekeeper'));
GRANT SELECT ON kits TO tooltrace_app;
GRANT INSERT (asset_tag, name, home_location_id) ON kits TO tooltrace_app;
GRANT UPDATE (name, home_location_id, is_active) ON kits TO tooltrace_app;

ALTER TABLE kit_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY kit_items_read ON kit_items FOR SELECT TO tooltrace_app USING (true);
CREATE POLICY kit_items_add ON kit_items FOR INSERT TO tooltrace_app WITH CHECK (app_role() IN ('admin', 'storekeeper'));
CREATE POLICY kit_items_remove ON kit_items FOR DELETE TO tooltrace_app USING (app_role() IN ('admin', 'storekeeper'));
GRANT SELECT, INSERT, DELETE ON kit_items TO tooltrace_app;

-- Like check-outs: crib staff issue a kit to anyone, a technician only to themselves.
ALTER TABLE kit_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY kit_issues_read ON kit_issues FOR SELECT TO tooltrace_app USING (true);
CREATE POLICY kit_issues_issue ON kit_issues FOR INSERT TO tooltrace_app
    WITH CHECK (
        app_role() IN ('admin', 'storekeeper')
        OR (app_role() = 'technician' AND holder_id = app_user() AND issued_by = app_user())
    );
GRANT SELECT, INSERT ON kit_issues TO tooltrace_app;

-- ---------------------------------------------------------------- audit
CREATE FUNCTION audit_kits() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE changes jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('kit.created', 'kit', NEW.id::text,
            jsonb_build_object('assetTag', NEW.asset_tag, 'name', NEW.name));
        RETURN NULL;
    END IF;
    changes := jsonb_changes(to_jsonb(OLD), to_jsonb(NEW), ARRAY['name', 'home_location_id', 'is_active']);
    IF changes <> '{}' THEN
        PERFORM audit_append('kit.updated', 'kit', NEW.id::text,
            jsonb_build_object('assetTag', NEW.asset_tag, 'changes', changes));
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER kits_audit AFTER INSERT OR UPDATE ON kits FOR EACH ROW EXECUTE FUNCTION audit_kits();

CREATE FUNCTION audit_kit_items() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r kit_items%ROWTYPE;
BEGIN
    r := CASE WHEN TG_OP = 'INSERT' THEN NEW ELSE OLD END;
    -- A kit deleted with all its items is not "tools removed".
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM kits WHERE id = r.kit_id) THEN
        RETURN NULL;
    END IF;
    PERFORM audit_append(CASE WHEN TG_OP = 'INSERT' THEN 'kit.tool_added' ELSE 'kit.tool_removed' END,
        'kit', r.kit_id::text,
        jsonb_build_object('toolId', r.tool_id, 'assetTag', (SELECT asset_tag FROM tools WHERE id = r.tool_id)));
    RETURN NULL;
END;
$$;
CREATE TRIGGER kit_items_audit AFTER INSERT OR DELETE ON kit_items FOR EACH ROW EXECUTE FUNCTION audit_kit_items();

CREATE FUNCTION audit_kit_issues() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM audit_append('kit.issued', 'kit', NEW.kit_id::text, jsonb_build_object(
        'kitIssueId', NEW.id, 'holderId', NEW.holder_id, 'dueBackAt', NEW.due_back_at), NEW.issued_by);
    RETURN NULL;
END;
$$;
CREATE TRIGGER kit_issues_audit AFTER INSERT ON kit_issues FOR EACH ROW EXECUTE FUNCTION audit_kit_issues();

-- Each piece's check-out records which kit issue it was part of.
CREATE OR REPLACE FUNCTION audit_checkouts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('tool.checked_out', 'tool', NEW.tool_id::text, jsonb_build_object(
            'checkoutId', NEW.id, 'holderId', NEW.holder_id, 'dueBackAt', NEW.due_back_at,
            'stationId', NEW.issued_via_station_id)
            || CASE WHEN NEW.offline_queued_at IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('offlineQueuedAt', NEW.offline_queued_at) END
            || CASE WHEN NEW.kit_issue_id IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('kitIssueId', NEW.kit_issue_id) END,
            NEW.issued_by);
    ELSIF OLD.returned_at IS NULL AND NEW.returned_at IS NOT NULL THEN
        PERFORM audit_append('tool.returned', 'tool', NEW.tool_id::text, jsonb_build_object(
            'checkoutId', NEW.id, 'condition', NEW.condition_on_return, 'notes', NEW.notes,
            'stationId', NEW.returned_via_station_id), NEW.received_by);
    END IF;
    RETURN NULL;
END;
$$;
