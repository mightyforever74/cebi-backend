#!/usr/bin/env bash
# scripts/dev/cebi_telemetry_e2e_test.sh — Tek seferlik manuel doğrulama scripti.
#
# Mobil Telemetri batch ingestion endpoint'ini (ADR-CE-01/ADR-CE-02,
# POST /api/driver/telemetry/batch) uçtan uca test eder:
#   TEST 1: company_admin rolüyle istek -> 403 (sadece driver gönderebilir)
#   TEST 2: driver, kendi task'ı için 3 ping -> 201, accepted=3, duplicates=0
#   TEST 3: AYNI 3 ping tekrar gönderilir (retry simülasyonu) -> 201,
#           accepted=0, duplicates=3 (client_ping_id UNIQUE + ON CONFLICT
#           DO NOTHING idempotency kanıtı)
#   TEST 4: geçersiz latitude (999) içeren ping -> 400
#
# Bu bir migration/uygulama dosyası DEĞİL — tek seferlik, elle çalıştırılan
# bir doğrulama aracı (cebi_e2e_test.sh ile aynı desen). fleet-enterprise-01
# üzerinde, cebi-db/cebi-backend container'ları ayaktayken çalıştırılmalı:
#   cd /opt/cebi && git pull origin main && bash scripts/dev/cebi_telemetry_e2e_test.sh
#
# Şifreler hiçbir adımda ekrana basılmaz (Sır Hijyeni, bkz. SESSION_NOTE.md).

set -uo pipefail

COMPANY_ID="e1f3ebdc-4732-4b9c-9c6b-f6fe1bea0cf6"
DRIVER_EMAIL="driver2@cebi-test.local"
ADMIN_EMAIL="admin2@cebi-test.local"
DRIVER_PASSWORD=$(openssl rand -hex 12)
ADMIN_PASSWORD=$(openssl rand -hex 12)

# İdempotent temizlik — FK sırası: mobile_location_pings -> tasks -> drivers
# -> vehicles -> users.
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.mobile_location_pings WHERE task_id IN (SELECT id FROM public.tasks WHERE task_no = 'CEBI-TEST-002');" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.tasks WHERE task_no = 'CEBI-TEST-002';" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.drivers WHERE license_no = 'TEST-LIC-002';" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.vehicles WHERE plate_no = 'TEST-34-CEBI-02' OR esp32_device_id = 'ESP32-CEBI-TEST-02';" >/dev/null
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
   VALUES (gen_random_uuid(), '$COMPANY_ID', '$DRIVER_EMAIL', '$DRIVER_HASH', 'driver', 'Test', 'Surucu2')
   RETURNING id;" | head -n 1)
ADMIN_USER_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.users (id, company_id, email, password_hash, role, first_name, last_name)
   VALUES (gen_random_uuid(), '$COMPANY_ID', '$ADMIN_EMAIL', '$ADMIN_HASH', 'company_admin', 'Test', 'Admin2')
   RETURNING id;" | head -n 1)
echo "driver user id: $DRIVER_USER_ID"
echo "admin user id: $ADMIN_USER_ID"

VEHICLE_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.vehicles (id, company_id, plate_no, esp32_device_id, status)
   VALUES (gen_random_uuid(), '$COMPANY_ID', 'TEST-34-CEBI-02', 'ESP32-CEBI-TEST-02', 'available')
   RETURNING id;" | head -n 1)
DRIVER_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.drivers (id, user_id, company_id, license_no, license_expiry, status, assigned_vehicle_id)
   VALUES (gen_random_uuid(), '$DRIVER_USER_ID', '$COMPANY_ID', 'TEST-LIC-002', '2030-01-01', 'available', '$VEHICLE_ID')
   RETURNING id;" | head -n 1)
TASK_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.tasks (id, task_no, driver_id, vehicle_id, company_id, status, waypoints)
   VALUES (gen_random_uuid(), 'CEBI-TEST-002', '$DRIVER_ID', '$VEHICLE_ID', '$COMPANY_ID', 'in_progress', '[]'::jsonb)
   RETURNING id;" | head -n 1)
echo "vehicle id: $VEHICLE_ID"
echo "drivers.id: $DRIVER_ID"
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

PING1=$(cat /proc/sys/kernel/random/uuid)
PING2=$(cat /proc/sys/kernel/random/uuid)
PING3=$(cat /proc/sys/kernel/random/uuid)

BATCH_BODY=$(cat <<JSON
{"taskId":"$TASK_ID","pings":[
  {"clientPingId":"$PING1","latitude":41.0082,"longitude":28.9784,"speed":12.5,"heading":90,"accuracy":5,"recordedAt":"2026-10-18T10:00:00Z"},
  {"clientPingId":"$PING2","latitude":41.0090,"longitude":28.9790,"speed":14.0,"heading":92,"accuracy":6,"recordedAt":"2026-10-18T10:00:10Z"},
  {"clientPingId":"$PING3","latitude":41.0098,"longitude":28.9796,"speed":10.0,"heading":88,"accuracy":4,"recordedAt":"2026-10-18T10:00:20Z"}
]}
JSON
)

echo ""
echo "=== TEST 1: company_admin rolu ile batch gonderimi (403 beklenir) ==="
curl -s -o /tmp/tel_test1.json -w "HTTP %{http_code}\n" -X POST \
  "http://127.0.0.1:3100/api/driver/telemetry/batch" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "$BATCH_BODY"
cat /tmp/tel_test1.json; echo

echo ""
echo "=== TEST 2: driver, 3 yeni ping (201 + accepted=3, duplicates=0 beklenir) ==="
curl -s -o /tmp/tel_test2.json -w "HTTP %{http_code}\n" -X POST \
  "http://127.0.0.1:3100/api/driver/telemetry/batch" \
  -H "Authorization: Bearer $DRIVER_TOKEN" -H "Content-Type: application/json" \
  -d "$BATCH_BODY"
cat /tmp/tel_test2.json; echo

echo ""
echo "=== TEST 3: AYNI 3 ping tekrar gonderiliyor (retry simulasyonu) -- (201 + accepted=0, duplicates=3 beklenir) ==="
curl -s -o /tmp/tel_test3.json -w "HTTP %{http_code}\n" -X POST \
  "http://127.0.0.1:3100/api/driver/telemetry/batch" \
  -H "Authorization: Bearer $DRIVER_TOKEN" -H "Content-Type: application/json" \
  -d "$BATCH_BODY"
cat /tmp/tel_test3.json; echo

PING4=$(cat /proc/sys/kernel/random/uuid)
BAD_BODY=$(cat <<JSON
{"taskId":"$TASK_ID","pings":[
  {"clientPingId":"$PING4","latitude":999,"longitude":28.9784,"recordedAt":"2026-10-18T10:00:30Z"}
]}
JSON
)

echo ""
echo "=== TEST 4: gecersiz latitude (999) (400 beklenir) ==="
curl -s -o /tmp/tel_test4.json -w "HTTP %{http_code}\n" -X POST \
  "http://127.0.0.1:3100/api/driver/telemetry/batch" \
  -H "Authorization: Bearer $DRIVER_TOKEN" -H "Content-Type: application/json" \
  -d "$BAD_BODY"
cat /tmp/tel_test4.json; echo

echo ""
echo "=== DB dogrulama: mobile_location_pings satir sayisi (3 beklenir) ==="
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT count(*) FROM public.mobile_location_pings WHERE task_id = '$TASK_ID';"
