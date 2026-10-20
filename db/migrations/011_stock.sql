-- Consumables and PPE: things counted in quantities, not tracked one by one.
--
--   stock_items       what is kept (gloves, safety glasses, cable ties...), how many,
--                     and the level at which to reorder
--   stock_movements   every change to a quantity: received, issued to a person,
--                     returned, or a count correction. The quantity on an item is
--                     only ever changed by a movement, by a database trigger that
--                     locks the item, so it can't go negative or drift from its history.

CREATE TABLE stock_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code           text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
    name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    kind           text NOT NULL CHECK (kind IN ('consumable', 'ppe')),
    category       text NOT NULL CHECK (length(category) BETWEEN 1 AND 60),
    unit           text NOT NULL DEFAULT 'pcs' CHECK (length(unit) BETWEEN 1 AND 20),
    location_id    uuid NOT NULL REFERENCES locations(id),
    quantity       int NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    reorder_level  int NOT NULL DEFAULT 0 CHECK (reorder_level BETWEEN 0 AND 1000000),
    unit_price     numeric(12, 2) CHECK (unit_price >= 0 AND unit_price < 10000000000),
    abc_class      text GENERATED ALWAYS AS (abc_class(unit_price)) STORED,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER stock_items_touch_updated_at BEFORE UPDATE ON stock_items
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE stock_movements (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id        uuid NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    kind           text NOT NULL CHECK (kind IN ('receive', 'issue', 'return', 'adjust')),
    -- Signed change: issues take away, receipts and returns add, corrections either way.
    quantity       int NOT NULL CHECK (quantity <> 0 AND abs(quantity) <= 1000000),
    issued_to      uuid REFERENCES users(id),
    note           text CHECK (length(note) <= 300),
    by_user        uuid NOT NULL REFERENCES users(id),
    at             timestamptz NOT NULL DEFAULT now(),
    balance_after  int NOT NULL CHECK (balance_after >= 0),
    CHECK ((kind IN ('issue', 'return')) = (issued_to IS NOT NULL)),
    CHECK (kind <> 'issue' OR quantity < 0),
    CHECK (kind NOT IN ('receive', 'return') OR quantity > 0),
    -- A correction always says why.
    CHECK (kind <> 'adjust' OR length(note) > 0)
);
CREATE INDEX stock_movements_item_idx ON stock_movements (item_id, at DESC);
CREATE INDEX stock_movements_person_idx ON stock_movements (issued_to, at DESC) WHERE issued_to IS NOT NULL;

-- The only way a quantity changes. Runs as the owner: the app role has no write access to quantity.
CREATE FUNCTION apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    item stock_items%ROWTYPE;
BEGIN
    SELECT * INTO item FROM stock_items WHERE id = NEW.item_id FOR UPDATE;
    IF NOT item.is_active AND NEW.kind = 'issue' THEN
        RAISE EXCEPTION '% is no longer stocked', item.code USING ERRCODE = 'P0001', HINT = 'stock_inactive';
    END IF;
    IF item.quantity + NEW.quantity < 0 THEN
        RAISE EXCEPTION 'only % % of % in stock', item.quantity, item.unit, item.code
            USING ERRCODE = 'P0001', HINT = 'insufficient_stock';
    END IF;
    NEW.balance_after := item.quantity + NEW.quantity;
    UPDATE stock_items SET quantity = NEW.balance_after WHERE id = NEW.item_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER stock_movements_apply BEFORE INSERT ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- History is history.
CREATE FUNCTION stock_movements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'stock movements cannot be changed' USING ERRCODE = 'P0001', HINT = 'movement_immutable';
END;
$$;
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION stock_movements_immutable();

-- ---------------------------------------------------------------- access
ALTER TABLE stock_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_items_read ON stock_items FOR SELECT TO tooltrace_app USING (true);
CREATE POLICY stock_items_create ON stock_items FOR INSERT TO tooltrace_app
    WITH CHECK (app_role() IN ('admin', 'storekeeper') AND quantity = 0);
CREATE POLICY stock_items_update ON stock_items FOR UPDATE TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper')) WITH CHECK (app_role() IN ('admin', 'storekeeper'));
GRANT SELECT ON stock_items TO tooltrace_app;
GRANT INSERT (code, name, kind, category, unit, location_id, reorder_level, unit_price) ON stock_items TO tooltrace_app;
GRANT UPDATE (name, category, unit, location_id, reorder_level, unit_price, is_active) ON stock_items TO tooltrace_app;

-- Crib staff and auditors see all movements; everyone sees what was issued to them.
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_movements_read ON stock_movements FOR SELECT TO tooltrace_app
    USING (app_role() IN ('admin', 'storekeeper', 'auditor') OR issued_to = app_user());
CREATE POLICY stock_movements_write ON stock_movements FOR INSERT TO tooltrace_app
    WITH CHECK (app_role() IN ('admin', 'storekeeper') AND by_user = app_user());
GRANT SELECT ON stock_movements TO tooltrace_app;
GRANT INSERT (item_id, kind, quantity, issued_to, note, by_user) ON stock_movements TO tooltrace_app;

-- ---------------------------------------------------------------- audit
CREATE FUNCTION audit_stock_items() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE changes jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('stock.item_created', 'stock_item', NEW.id::text, jsonb_build_object(
            'code', NEW.code, 'name', NEW.name, 'kind', NEW.kind, 'unit', NEW.unit,
            'reorderLevel', NEW.reorder_level, 'unitPrice', NEW.unit_price));
        RETURN NULL;
    END IF;
    -- Quantity changes are recorded as the movements that caused them.
    changes := jsonb_changes(to_jsonb(OLD), to_jsonb(NEW),
        ARRAY['name', 'category', 'unit', 'location_id', 'reorder_level', 'unit_price', 'is_active']);
    IF changes <> '{}' THEN
        PERFORM audit_append('stock.item_updated', 'stock_item', NEW.id::text,
            jsonb_build_object('code', NEW.code, 'changes', changes));
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER stock_items_audit AFTER INSERT OR UPDATE ON stock_items
    FOR EACH ROW EXECUTE FUNCTION audit_stock_items();

CREATE FUNCTION audit_stock_movements() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM audit_append('stock.' || CASE NEW.kind WHEN 'receive' THEN 'received' WHEN 'issue' THEN 'issued'
                                                   WHEN 'return' THEN 'returned' ELSE 'adjusted' END,
        'stock_item', NEW.item_id::text, jsonb_build_object(
            'movementId', NEW.id, 'quantity', NEW.quantity, 'balanceAfter', NEW.balance_after,
            'issuedTo', NEW.issued_to, 'note', NEW.note), NEW.by_user);
    RETURN NULL;
END;
$$;
CREATE TRIGGER stock_movements_audit AFTER INSERT ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION audit_stock_movements();

CREATE FUNCTION notify_stock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('tooltrace_floor', jsonb_build_object('kind', 'stock_changed', 'itemId', NEW.id)::text);
    RETURN NULL;
END;
$$;
CREATE TRIGGER stock_items_live AFTER INSERT OR UPDATE ON stock_items
    FOR EACH ROW EXECUTE FUNCTION notify_stock();
