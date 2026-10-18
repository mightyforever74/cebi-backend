#!/usr/bin/env bash
# scripts/dev/cebi_e2e_test.sh — Tek seferlik manuel doğrulama scripti.
#
# Weighbridge completion gate'ini (ADR-CE-04 §2-A, server.js "Complete Task"
# endpoint'i) uçtan uca test eder: driver + weighbridge_operator kullanıcısı,
# araç, in_progress task seed eder; önce tartımsız /complete dener (400
# beklenir), sonra tartım girer, tekrar /complete dener (200 beklenir).
#
# Bu bir migration/uygulama dosyası DEĞİL — tek seferlik, elle çalıştırılan
# bir doğrulama aracı. fleet-enterprise-01 üzerinde, cebi-db/cebi-backend
# container'ları ayaktayken çalıştırılmalı:
#   cd /opt/cebi && git pull origin main && bash scripts/dev/cebi_e2e_test.sh
#
# Şifreler hiçbir adımda ekrana basılmaz (Sır Hijyeni, bkz. SESSION_NOTE.md).

set -uo pipefail

COMPANY_ID="e1f3ebdc-4732-4b9c-9c6b-f6fe1bea0cf6"
DRIVER_EMAIL="driver1@cebi-test.local"
OPERATOR_EMAIL="tarti1@cebi-test.local"
DRIVER_PASSWORD=$(openssl rand -hex 12)
OPERATOR_PASSWORD=$(openssl rand -hex 12)

printf '%s\n' \
  "const bcrypt = require('bcryptjs');" \
  "bcrypt.hash(process.argv[2], 10).then(h => console.log(h));" \
  > /tmp/hash_pw.js
docker cp /tmp/hash_pw.js cebi-backend:/app/hash_pw.js
DRIVER_HASH=$(docker exec cebi-backend node /app/hash_pw.js "$DRIVER_PASSWORD")
OPERATOR_HASH=$(docker exec cebi-backend node /app/hash_pw.js "$OPERATOR_PASSWORD")
docker exec cebi-backend rm -f /app/hash_pw.js
rm -f /tmp/hash_pw.js
echo "Hash'ler uretildi (uzunluklar: ${#DRIVER_HASH}, ${#OPERATOR_HASH})"

DRIVER_USER_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.users (id, company_id, email, password_hash, role, first_name, last_name)
   VALUES (gen_random_uuid(), '$COMPANY_ID', '$DRIVER_EMAIL', '$DRIVER_HASH', 'driver', 'Test', 'Surucu')
   RETURNING id;")
OPERATOR_USER_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.users (id, company_id, email, password_hash, role, first_name, last_name)
   VALUES (gen_random_uuid(), '$COMPANY_ID', '$OPERATOR_EMAIL', '$OPERATOR_HASH', 'weighbridge_operator', 'Test', 'Tarti Memuru')
   RETURNING id;")
echo "driver user id: $DRIVER_USER_ID"
echo "operator user id: $OPERATOR_USER_ID"

VEHICLE_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.vehicles (id, company_id, plate_no, esp32_device_id, status)
   VALUES (gen_random_uuid(), '$COMPANY_ID', 'TEST-34-CEBI', 'ESP32-CEBI-TEST-01', 'available')
   RETURNING id;")
DRIVER_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.drivers (id, user_id, company_id, license_no, license_expiry, status, assigned_vehicle_id)
   VALUES (gen_random_uuid(), '$DRIVER_USER_ID', '$COMPANY_ID', 'TEST-LIC-001', '2030-01-01', 'available', '$VEHICLE_ID')
   RETURNING id;")
TASK_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.tasks (id, task_no, driver_id, vehicle_id, company_id, status, waypoints)
   VALUES (gen_random_uuid(), 'CEBI-TEST-001', '$DRIVER_ID', '$VEHICLE_ID', '$COMPANY_ID', 'in_progress', '[]'::jsonb)
   RETURNING id;")
echo "vehicle id: $VEHICLE_ID"
echo "drivers.id: $DRIVER_ID"
echo "task id: $TASK_ID"

DRIVER_LOGIN=$(curl -s -X POST http://127.0.0.1:3100/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DRIVER_EMAIL\",\"password\":\"$DRIVER_PASSWORD\"}")
DRIVER_TOKEN=$(echo "$DRIVER_LOGIN" | docker exec -i cebi-backend node -e \
  "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch(e){console.log('')}})")
echo "driver login: $( [ -n "$DRIVER_TOKEN" ] && echo OK || echo "FAIL -> $DRIVER_LOGIN" )"

echo ""
echo "=== TEST 1: tartimsiz /complete (400 beklenir) ==="
curl -s -o /tmp/test1.json -w "HTTP %{http_code}\n" -X PUT \
  "http://127.0.0.1:3100/api/driver/tasks/$TASK_ID/complete" \
  -H "Authorization: Bearer $DRIVER_TOKEN" -H "Content-Type: application/json" -d "{}"
cat /tmp/test1.json; echo

OPERATOR_LOGIN=$(curl -s -X POST http://127.0.0.1:3100/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$OPERATOR_EMAIL\",\"password\":\"$OPERATOR_PASSWORD\"}")
OPERATOR_TOKEN=$(echo "$OPERATOR_LOGIN" | docker exec -i cebi-backend node -e \
  "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch(e){console.log('')}})")
echo "operator login: $( [ -n "$OPERATOR_TOKEN" ] && echo OK || echo "FAIL -> $OPERATOR_LOGIN" )"

echo ""
echo "=== Tartim kaydi giriliyor (ManualAdapter, 18500 kg) ==="
curl -s -o /tmp/weigh.json -w "HTTP %{http_code}\n" -X POST \
  "http://127.0.0.1:3100/api/weighbridge/readings" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d "{\"taskId\":\"$TASK_ID\",\"adapterType\":\"manual\",\"weightKg\":18500,\"note\":\"test\"}"
cat /tmp/weigh.json; echo

echo ""
echo "=== TEST 2: tartimli /complete (200 beklenir) ==="
curl -s -o /tmp/test2.json -w "HTTP %{http_code}\n" -X PUT \
  "http://127.0.0.1:3100/api/driver/tasks/$TASK_ID/complete" \
  -H "Authorization: Bearer $DRIVER_TOKEN" -H "Content-Type: application/json" -d "{}"
cat /tmp/test2.json; echo
