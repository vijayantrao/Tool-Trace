-- What tools cost, and their A/B/C class.
--
-- The class follows the plant's rule on the unit price (in the site currency):
--   A: above 15,000   B: 2,000 to 15,000   C: below 2,000
-- It is computed by the database from the price, so it can never disagree with it.

CREATE FUNCTION abc_class(price numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN price IS NULL THEN NULL WHEN price > 15000 THEN 'A' WHEN price >= 2000 THEN 'B' ELSE 'C' END
$$;

ALTER TABLE tools
    ADD COLUMN unit_price numeric(12, 2) CHECK (unit_price >= 0 AND unit_price < 10000000000),
    ADD COLUMN make text CHECK (length(make) BETWEEN 1 AND 80),
    ADD COLUMN model text CHECK (length(model) BETWEEN 1 AND 80),
    ADD COLUMN abc_class text GENERATED ALWAYS AS (abc_class(unit_price)) STORED;
CREATE INDEX tools_abc_class_idx ON tools (abc_class);

GRANT UPDATE (unit_price, make, model) ON tools TO tooltrace_app;

-- Price and make/model changes are recorded. Trips to the calibration lab are
-- recorded as calibration events, like check-outs are, not as status edits.
CREATE OR REPLACE FUNCTION audit_tools() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE changes jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM audit_append('tool.created', 'tool', NEW.id::text, jsonb_build_object(
            'assetTag', NEW.asset_tag, 'name', NEW.name, 'category', NEW.category,
            'requiresCalibration', NEW.requires_calibration, 'rfidUid', NEW.rfid_uid,
            'unitPrice', NEW.unit_price, 'make', NEW.make, 'model', NEW.model));
        RETURN NULL;
    END IF;
    changes := jsonb_changes(to_jsonb(OLD), to_jsonb(NEW),
        ARRAY['name', 'category', 'home_location_id', 'rfid_uid', 'unit_price', 'make', 'model']);
    IF OLD.status <> NEW.status
       AND OLD.status::text NOT IN ('checked_out', 'at_calibration')
       AND NEW.status::text NOT IN ('checked_out', 'at_calibration') THEN
        changes := changes || jsonb_build_object('status', jsonb_build_array(OLD.status, NEW.status));
    END IF;
    IF changes <> '{}' THEN
        PERFORM audit_append('tool.updated', 'tool', NEW.id::text,
            jsonb_build_object('assetTag', NEW.asset_tag, 'changes', changes));
    END IF;
    RETURN NULL;
END;
$$;
