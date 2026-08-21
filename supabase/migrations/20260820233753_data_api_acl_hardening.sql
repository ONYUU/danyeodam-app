-- Keep the server-only Data API surface deny-by-default across the Supabase
-- 2026 auto-exposure change. Application migrations run as `postgres`; every
-- runtime RPC is granted explicitly after its definition.

-- The platform's non-auto-exposed default removes Data API CRUD privileges,
-- but currently leaves TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN on future
-- public tables. Browser roles never need those privileges, and the server
-- accesses application tables only through explicitly granted SECURITY
-- DEFINER RPCs in api_private.
alter default privileges for role postgres in schema public
  revoke all privileges on tables from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke all privileges on sequences from public, anon, authenticated, service_role;

-- authenticated has USAGE on private only for three explicitly granted RLS
-- helpers. A newly added private SECURITY DEFINER function must not become
-- executable through PostgreSQL's implicit PUBLIC function grant.
-- PostgreSQL's built-in PUBLIC EXECUTE default is global. A per-schema REVOKE
-- cannot subtract it, so this statement intentionally has no IN SCHEMA clause.
alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated, service_role;

-- Normalize existing application objects as well. Supabase's 2026 default
-- change is not retroactive, so a linked project created under the legacy
-- defaults may still carry direct CRUD grants even when a fresh local reset
-- does not. The application server uses explicit SECURITY DEFINER RPCs.
revoke all privileges
  on all tables in schema public
  from public, anon, authenticated, service_role;

revoke all privileges
  on all sequences in schema public
  from public, anon, authenticated, service_role;
