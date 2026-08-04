-- Kök neden (2026-07-29): internalBridge derivedTitle slice(0,255) yapıyor ama
-- public.tasks.title varchar(100) idi -> uzun geocode adreslerinde PG 22001
-- ([BridgeTransactionCrashed], internalBridge.js:203). start/end_location zaten
-- 255; title kod sözleşmesiyle hizalanıyor. Metadata-only ALTER, anlık/güvenli.
ALTER TABLE public.tasks ALTER COLUMN title TYPE varchar(255);
\echo '=== public.tasks.title -> varchar(255) ==='
