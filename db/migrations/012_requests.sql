-- Requests and approvals: asking for a new tool, a replacement (damaged, missing,
-- Kaizen improvement) or more stock, with two separate people signing it off.
--
--   submitted --(storekeeper reviews)--> reviewed --(admin decides)--> approved --> fulfilled
--        \                                   \
--         `-- rejected / cancelled            `-- rejected / cancelled
--
-- Nobody can review or approve their own request, and the person who approves
-- is never the person who reviewed: the database checks both.

CREATE TABLE requests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    number          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    kind            text NOT NULL CHECK (kind IN ('new_tool', 'replacement', 'stock')),
    reason          text NOT NULL CHECK (reason IN ('new_requirement', 'damaged', 'missing', 'kaizen', 'used_up', 'other')),
    title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    details         text CHECK (length(details) <= 1000),
    quantity        int NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100000),
    estimated_cost  numeric(12, 2) CHECK (estimated_cost >= 0 AND estimated_cost < 10000000000),
    tool_id         uuid REFERENCES tools(id) ON DELETE SET NULL,
    stock_item_id   uuid REFERENCES stock_items(id) ON DELETE SET NULL,
    requested_by    uuid NOT NULL REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    status          text NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted', 'reviewed', 'approved', 'rejected', 'fulfilled', 'cancelled')),
    reviewed_by     uuid REFERENCES users(id),
    reviewed_at     timestamptz,
    decided_by      uuid REFERENCES users(id),
    decided_at      timestamptz,
    closed_by       uuid REFERENCES users(id),
    closed_at       timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by),
    CHECK (decided_by IS NULL OR decided_by <> requested_by),
    CHECK (status <> 'approved' OR (decided_by IS NOT NULL AND decided_by IS DISTINCT FROM reviewed_by)),
    CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
    CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
    CHECK (status NOT IN ('reviewed', 'approved', 'fulfilled') OR reviewed_by IS NOT NULL),
    CHECK (status NOT IN ('approved', 'fulfilled') OR decided_by IS NOT NULL),
    CHECK ((status IN ('fulfilled', 'cancelled')) = (closed_by IS NOT NULL)),
    CHECK (kind <> 'replacement' OR tool_id IS NOT NULL)
);
CREATE INDEX requests_status_idx ON requests (status, created_at DESC);
CREATE INDEX requests_requester_idx ON requests (requested_by, created_at DESC);
CREATE TRIGGER requests_touch_updated_at BEFORE UPDATE ON requests
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The conversation on a request: every step, with who and why.
CREATE TABLE request_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id  uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    action      text NOT NULL CHECK (action IN ('submitted', 'reviewed', 'approved', 'rejected', 'fulfilled', 'cancelled')),
    by_user     uuid NOT NULL REFERENCES users(id),
    note        text CHECK (length(note) <= 500),
    at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_events_request_idx ON request_events (request_id, id);

-- Only the forward moves exist.
CREATE FUNCTION enforce_request_flow() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;
    IF NOT (
        (OLD.status = 'submitted' AND NEW.status IN ('reviewed', 'rejected', 'cancelled'))
        OR (OLD.status = 'reviewed' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
        OR (OLD.status = 'approved' AND NEW.status = 'fulfilled')
    ) THEN
        RAISE EXCEPTION 'a % request cannot become %', OLD.status, NEW.status
            USING ERRCODE = 'P0001', HINT = 'invalid_transition';
    END IF;
    -- The second step is an admin's decision (app_role() is 'none' only for maintenance as the owner).
    IF OLD.status = 'reviewed' AND NEW.status IN ('approved', 'rejected') AND app_role() NOT IN ('admin', 'none') THEN
        RAISE EXCEPTION 'only an admin can decide a reviewed request'
            USING ERRCODE = 'P0001', HINT = 'invalid_transition';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER requests_flow BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION enforce_request_flow();

-- ---------------------------------------------------------------- access
-- Crib staff and auditors see every request; everyone else sees their own.
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY requests_read ON requests FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'auditor') OR requested_by = app_user());
CREATE POLICY requests_submit ON requests FOR INSERT TO tooltrace_app
    WITH CHECK (app_role() IN ('admin', 'storekeeper', 'technician') AND requested_by = app_user() AND status = 'submitted');
CREATE POLICY requests_act ON requests FOR UPDATE TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper') OR requested_by = app_user())
    WITH CHECK (
        -- Approving (or rejecting at the second step) is an admin's decision.
        (status NOT IN ('approved') OR app_role() = 'admin')
        AND (app_role() IN ('admin', 'storekeeper') OR (requested_by = app_user() AND status IN ('submitted', 'reviewed', 'cancelled')))
    );
GRANT SELECT ON requests TO tooltrace_app;
GRANT INSERT (kind, reason, title, details, quantity, estimated_cost, tool_id, stock_item_id, requested_by) ON requests TO tooltrace_app;
GRANT UPDATE (status, reviewed_by, reviewed_at, decided_by, decided_at, closed_by, closed_at) ON requests TO tooltrace_app;

ALTER TABLE request_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY request_events_read ON request_events FOR SELECT TO tooltrace_app
    USING (EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id));
CREATE POLICY request_events_write ON request_events FOR INSERT TO tooltrace_app
    WITH CHECK (by_user = app_user() AND EXISTS (SELECT 1 FROM requests r WHERE r.id = request_id));
GRANT SELECT ON request_events TO tooltrace_app;
GRANT INSERT (request_id, action, by_user, note) ON request_events TO tooltrace_app;

-- ---------------------------------------------------------------- audit
CREATE FUNCTION audit_request_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM audit_append('request.' || NEW.action, 'request', NEW.request_id::text,
        (SELECT jsonb_build_object('number', r.number, 'kind', r.kind, 'reason', r.reason, 'title', r.title,
                                   'quantity', r.quantity, 'note', NEW.note)
         FROM requests r WHERE r.id = NEW.request_id),
        NEW.by_user);
    RETURN NULL;
END;
$$;
CREATE TRIGGER request_events_audit AFTER INSERT ON request_events
    FOR EACH ROW EXECUTE FUNCTION audit_request_events();
