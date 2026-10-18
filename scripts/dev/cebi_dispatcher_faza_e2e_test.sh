#!/usr/bin/env bash
# scripts/dev/cebi_dispatcher_faza_e2e_test.sh — Tek seferlik manuel doğrulama scripti.
#
# Dispatcher Faz A (Çekirdek Operasyon) portunu uçtan uca test eder:
#   GET /api/dispatcher/drivers
#   GET /api/dispatcher/vehicles
#   GET /api/dispatcher/locations/latest
#   GET /api/dispatcher/routes/active
#   GET /api/dispatcher/tasks
#
#   TEST 1: driver rolüyle istek  -> 403 (requireRole("company_admin","super_admin") kapısı)
#   TEST 2: company_admin, /api/dispatcher/drivers -> 200, test sürücüsü listede
#   TEST 3: company_admin, /api/dispatcher/vehicles -> 200, test aracı listede
#   TEST 4: company_admin, /api/dispatcher/locations/latest -> 200, test konumu listede
#   TEST 5: company_admin, /api/dispatcher/tasks -> 200, test görevi listede
#   TEST 6: company_admin, /api/dispatcher/routes/active -> 200, test görevi listede
#           (geometry alanı HERE_API_KEY yoksa/hata olursa null olabilir -- bu
#           TEST'i KIRMAZ, Graceful Degradation kaynağın kendi sözleşmesi)
#
# Bu bir migration/uygulama dosyası DEĞİL — tek seferlik, elle çalıştırılan
# bir doğrulama aracı (cebi_telemetry_e2e_test.sh ile aynı desen). fleet-enterprise-01
# üzerinde, cebi-db/cebi-backend container'ları ayaktayken çalıştırılmalı:
#   cd /opt/cebi && git pull origin main && bash scripts/dev/cebi_dispatcher_faza_e2e_test.sh
#
# Şifreler hiçbir adımda ekrana basılmaz (Sır Hijyeni, bkz. SESSION_NOTE.md).

set -uo pipefail

COMPANY_ID="e1f3ebdc-4732-4b9c-9c6b-f6fe1bea0cf6"
DRIVER_EMAIL="driver3@cebi-test.local"
ADMIN_EMAIL="admin3@cebi-test.local"
DRIVER_PASSWORD=$(openssl rand -hex 12)
ADMIN_PASSWORD=$(openssl rand -hex 12)
PICKUP_MARKER="CEBI-TEST-003-PICKUP"

# İdempotent temizlik (FK sırası: tasks -> dispatch_tasks -> drivers -> vehicles
# -> locations -> users).
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.tasks WHERE task_no = 'CEBI-TEST-003';" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM enterprise.dispatch_tasks WHERE pickup_location->>'address' = '$PICKUP_MARKER';" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.drivers WHERE license_no = 'TEST-LIC-003';" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.locations WHERE device_id = 'ESP32-CEBI-TEST-03';" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.vehicles WHERE plate_no = 'TEST-34-CEBI-03' OR esp32_device_id = 'ESP32-CEBI-TEST-03';" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.users WHERE email IN ('$DRIVER_EMAIL', '$ADMIN_EMAIL');" >/dev/null
echo "Onceki test kalintilari temizlendi (varsa)."

printf '%s\n' \
  "const bcrypt = require('bcryptjs');" \
  "bcrypt.hash(process.argv[2], 10).then(h => console.log(h));" \
  > /tmp/hash_pw.js
docker cp /tmp/hash_pw.js cebi-backend:/app/hash_pw.js
DRIVER_HASH=$(docker exec cebi-backend node /app/hash_pw.js "$DRIVER_PASSWORD")
ADMIN_HASH=$(docker exec cebi-backend node /app/hash_pw.js "$ADMIN_PASSWORD")
docker exec cebi-backend rm -f /app/hash_pw.js
rm -f /tmp/hash_pw.js
echo "Hash'ler uretildi (uzunluklar: ${#DRIVER_HASH}, ${#ADMIN_HASH})"

DRIVER_USER_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.users (id, company_id, email, password_hash, role, first_name, last_name)
   VALUES (gen_random_uuid(), '$COMPANY_ID', '$DRIVER_EMAIL', '$DRIVER_HASH', 'driver', 'Test', 'Surucu3')
   RETURNING id;" | head -n 1)
ADMIN_USER_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.users (id, company_id, email, password_hash, role, first_name, last_name)
   VALUES (gen_random_uuid(), '$COMPANY_ID', '$ADMIN_EMAIL', '$ADMIN_HASH', 'company_admin', 'Test', 'Admin3')
   RETURNING id;" | head -n 1)
echo "driver user id: $DRIVER_USER_ID"
echo "admin user id: $ADMIN_USER_ID"

VEHICLE_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.vehicles (id, company_id, plate_no, esp32_device_id, status)
   VALUES (gen_random_uuid(), '$COMPANY_ID', 'TEST-34-CEBI-03', 'ESP32-CEBI-TEST-03', 'available')
   RETURNING id;" | head -n 1)
DRIVER_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.drivers (id, user_id, company_id, license_no, license_expiry, status, assigned_vehicle_id)
   VALUES (gen_random_uuid(), '$DRIVER_USER_ID', '$COMPANY_ID', 'TEST-LIC-003', '2030-01-01', 'available', '$VEHICLE_ID')
   RETURNING id;" | head -n 1)
echo "vehicle id: $VEHICLE_ID"
echo "drivers.id: $DRIVER_ID"

# locations/latest icin tek bir konum satiri
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "INSERT INTO public.locations (time, device_id, latitude, longitude, speed, heading, company_id)
   VALUES (NOW(), 'ESP32-CEBI-TEST-03', 41.0082, 28.9784, 11.5, 45, '$COMPANY_ID');" >/dev/null
echo "test konumu eklendi."

# routes/active icin: enterprise.dispatch_tasks (draft kaydı, routing_job_id NULL
# olabilir -- nullable) + public.tasks (in_progress, enterprise_dispatch_task_id ile baglanir)
DISPATCH_TASK_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO enterprise.dispatch_tasks (id, company_id, status, pickup_location, dropoff_location)
   VALUES (gen_random_uuid(), '$COMPANY_ID', 'assigned',
     '{\"lat\":41.0082,\"lng\":28.9784,\"address\":\"$PICKUP_MARKER\"}'::jsonb,
     '{\"lat\":41.0150,\"lng\":28.9900,\"address\":\"CEBI-TEST-003-DROPOFF\"}'::jsonb)
   RETURNING id;" | head -n 1)
echo "enterprise.dispatch_tasks id: $DISPATCH_TASK_ID"

TASK_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.tasks (id, task_no, driver_id, vehicle_id, company_id, status, waypoints, enterprise_dispatch_task_id)
   VALUES (gen_random_uuid(), 'CEBI-TEST-003', '$DRIVER_ID', '$VEHICLE_ID', '$COMPANY_ID', 'in_progress', '[]'::jsonb, '$DISPATCH_TASK_ID')
   RETURNING id;" | head -n 1)
echo "task id: $TASK_ID"

DRIVER_LOGIN=$(curl -s -X POST http://127.0.0.1:3100/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DRIVER_EMAIL\",\"password\":\"$DRIVER_PASSWORD\"}")
DRIVER_TOKEN=$(echo "$DRIVER_LOGIN" | docker exec -i cebi-backend node -e \
  "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch(e){console.log('')}})")
echo "driver login: $( [ -n "$DRIVER_TOKEN" ] && echo OK || echo "FAIL -> $DRIVER_LOGIN" )"

ADMIN_LOGIN=$(curl -s -X POST http://127.0.0.1:3100/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
ADMIN_TOKEN=$(echo "$ADMIN_LOGIN" | docker exec -i cebi-backend node -e \
  "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch(e){console.log('')}})")
echo "admin login: $( [ -n "$ADMIN_TOKEN" ] && echo OK || echo "FAIL -> $ADMIN_LOGIN" )"

echo ""
echo "=== TEST 1: driver rolu ile /api/dispatcher/drivers (403 beklenir) ==="
curl -s -o /tmp/disp_test1.json -w "HTTP %{http_code}\n" \
  "http://127.0.0.1:3100/api/dispatcher/drivers" \
  -H "Authorization: Bearer $DRIVER_TOKEN"
cat /tmp/disp_test1.json; echo

echo ""
echo "=== TEST 2: company_admin, /api/dispatcher/drivers (200 beklenir, test suruculu) ==="
curl -s -o /tmp/disp_test2.json -w "HTTP %{http_code}\n" \
  "http://127.0.0.1:3100/api/dispatcher/drivers" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
grep -q "TEST-LIC-003" /tmp/disp_test2.json && echo "test suruculu listede: VAR" || echo "test suruculu listede: YOK"
cat /tmp/disp_test2.json; echo

echo ""
echo "=== TEST 3: company_admin, /api/dispatcher/vehicles (200 beklenir, test aracli) ==="
curl -s -o /tmp/disp_test3.json -w "HTTP %{http_code}\n" \
  "http://127.0.0.1:3100/api/dispatcher/vehicles" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
grep -q "TEST-34-CEBI-03" /tmp/disp_test3.json && echo "test aracli listede: VAR" || echo "test aracli listede: YOK"
cat /tmp/disp_test3.json; echo

echo ""
echo "=== TEST 4: company_admin, /api/dispatcher/locations/latest (200 beklenir, test konumlu) ==="
curl -s -o /tmp/disp_test4.json -w "HTTP %{http_code}\n" \
  "http://127.0.0.1:3100/api/dispatcher/locations/latest" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
grep -q "ESP32-CEBI-TEST-03" /tmp/disp_test4.json && echo "test konumu listede: VAR" || echo "test konumu listede: YOK"
cat /tmp/disp_test4.json; echo

echo ""
echo "=== TEST 5: company_admin, /api/dispatcher/tasks (200 beklenir, test gorevli) ==="
curl -s -o /tmp/disp_test5.json -w "HTTP %{http_code}\n" \
  "http://127.0.0.1:3100/api/dispatcher/tasks" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
grep -q "CEBI-TEST-003" /tmp/disp_test5.json && echo "test gorevi listede: VAR" || echo "test gorevi listede: YOK"
cat /tmp/disp_test5.json; echo

echo ""
echo "=== TEST 6: company_admin, /api/dispatcher/routes/active (200 beklenir, test gorevli; geometry null olabilir) ==="
curl -s -o /tmp/disp_test6.json -w "HTTP %{http_code}\n" \
  "http://127.0.0.1:3100/api/dispatcher/routes/active" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
grep -q "CEBI-TEST-003" /tmp/disp_test6.json && echo "test gorevi listede: VAR" || echo "test gorevi listede: YOK"
cat /tmp/disp_test6.json; echo
