-- D-40: ROW LEVEL SECURITY on every table in the schema, with NO policies and NOT FORCE.
--
-- WARNING: the application connects as the OWNER of the tables (one role for migration and application).
-- The owner bypasses RLS because it is not FORCEd. Any OTHER role without BYPASSRLS (for example a separate
-- application role, or Supabase's anon / authenticated through the Data API) reads 0 rows and cannot write,
-- even if it is granted SELECT / INSERT / UPDATE / DELETE. If the application role is ever split from the
-- owner, give it BYPASSRLS or write policies in a new migration, otherwise every query returns nothing.
--
-- Every later migration that creates a table must also `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for it;
-- `db/scripts/check-rls.mjs` fails CI if a table in the schema lacks it.

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', current_schema(), t.relname);
  END LOOP;
END $$;

-- Repeat the 0001_init revoke for Supabase's Data API roles (only where they exist, so plain postgres:16 works).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', current_schema(), r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', current_schema(), r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', current_schema(), r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', current_schema(), r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', current_schema(), r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM %I', current_schema(), r);
    END IF;
  END LOOP;
END $$;
