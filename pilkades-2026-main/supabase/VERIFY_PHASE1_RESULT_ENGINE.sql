-- READ-ONLY verification for Phase 1 canonical result engine.
-- Run after 20261008_petugas_result_engine.sql.

SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'petugas_result_apply';

SELECT
  conname AS constraint_name,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.hasil_suara'::regclass
  AND conname = 'hasil_suara_kecamatan_desa_tps_key';
