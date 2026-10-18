#!/usr/bin/env bash
# scripts/ops/cebi_health_check.sh — Tekrar kullanılabilir, SALT OKUNUR
# sistem sağlığı/durum kontrolü.
#
# Hiçbir şeyi değiştirmez (INSERT/UPDATE/DELETE/DDL yok) — fleet-enterprise-01
# üzerinde cebi-db/cebi-backend container'ları ayaktayken, istendiği zaman
# tekrar tekrar çalıştırılabilir:
#   cd /opt/cebi && git pull origin main && bash scripts/ops/cebi_health_check.sh
#
# Bu bir migration/test scripti DEĞİL (bkz. scripts/dev/*) — sadece
# gözlem/teşhis amaçlı.

set -uo pipefail

hr() { printf '%s\n' "------------------------------------------------------------"; }

hr
echo "=== 1) Container durumu ==="
docker compose -f docker-compose.cebi.yml --env-file cebi.env ps 2>/dev/null \
  || docker ps --filter "name=cebi-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

hr
echo "=== 2) Container restart sayaçları (yüksekse instabilite işareti) ==="
for c in cebi-db cebi-backend; do
  restarts=$(docker inspect --format='{{.RestartCount}}' "$c" 2>/dev/null || echo "N/A")
  started=$(docker inspect --format='{{.State.StartedAt}}' "$c" 2>/dev/null || echo "N/A")
  echo "$c -> restartCount=$restarts, startedAt=$started"
done

hr
echo "=== 3) Disk alanı (host) ==="
df -h / 2>/dev/null | awk 'NR==1 || NR==2'

hr
echo "=== 4) Docker disk kullanımı ==="
docker system df 2>/dev/null

hr
echo "=== 5) Backend /health endpoint (local, 127.0.0.1:3100) ==="
curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:3100/health 2>&1

hr
echo "=== 6) Backend /health endpoint (public, cebi-api.tulipfleet.com uzerinden) ==="
curl -s -w "\nHTTP %{http_code}\n" https://cebi-api.tulipfleet.com/health 2>&1

hr
echo "=== 7) cebi-backend son loglardan ERROR/WARN taramasi (son 200 satir) ==="
docker logs cebi-backend --tail 200 2>&1 | grep -iE "error|warn|exception" | tail -30
echo "(yukarida satir yoksa son 200 log satirinda error/warn YOK -- iyi isaret)"

hr
echo "=== 8) DB baglanti + versiyon ==="
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc "SELECT version();" 2>&1

hr
echo "=== 9) DB boyutu ==="
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT pg_size_pretty(pg_database_size('cebi_db'));" 2>&1

hr
echo "=== 10) Tablo sayilari (public + enterprise) ==="
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT schemaname, count(*) FROM pg_tables WHERE schemaname IN ('public','enterprise') GROUP BY schemaname ORDER BY schemaname;" 2>&1

hr
echo "=== 11) Hypertable listesi (hangi tablolar hypertable, hangileri DUZ tablo) ==="
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT hypertable_schema, hypertable_name, num_chunks FROM timescaledb_information.hypertables ORDER BY hypertable_name;" 2>&1

hr
echo "=== 12) Son migration dosyalarinin uygulanip uygulanmadigina dair sema kontrolu ==="
echo "-- weighbridge_readings tablosu (1785300000000):"
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT to_regclass('public.weighbridge_readings') IS NOT NULL AS exists;" 2>&1
echo "-- weighbridge_readings_current view (1785300000000):"
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT to_regclass('public.weighbridge_readings_current') IS NOT NULL AS exists;" 2>&1
echo "-- mobile_location_pings tablosu (1785500000000, DUZ tablo olmali):"
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT to_regclass('public.mobile_location_pings') IS NOT NULL AS exists;" 2>&1
echo "-- weighbridge_operator rolu users CHECK constraint'inde var mi (1785200000000):"
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'users_role_check';" 2>&1
echo "-- exception_events trip_count_reconciliation_mismatch tipi var mi (1785400000000):"
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname LIKE '%exception_type%';" 2>&1

hr
echo "=== 13) Aktif baglanti sayisi (connection pool saglik gostergesi) ==="
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT count(*) FROM pg_stat_activity WHERE datname = 'cebi_db';" 2>&1

hr
echo "=== 14) Test verisi envanteri (bilerek DB'de birakilmis, zararsiz) ==="
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT email, role FROM public.users WHERE email LIKE '%@cebi-test.local' ORDER BY email;" 2>&1

hr
echo "Health check tamamlandi."
