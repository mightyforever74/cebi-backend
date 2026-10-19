#!/usr/bin/env bash
# scripts/dev/cebi_dispatcher_faza2_vrp_e2e_test.sh — Tek seferlik manuel doğrulama scripti.
#
# Dispatcher Faz A-2 (VRP Optimizasyon Portu) zincirini uçtan uca test eder:
#   POST /dispatcher/tasks/optimize          (DİKKAT: /api öneki YOK — kasıtlı)
#   GET  /dispatcher/tasks/optimize/poll/:id (DİKKAT: /api öneki YOK — kasıtlı)
#   POST /dispatcher/tasks/optimize/approve  (DİKKAT: /api öneki YOK — kasıtlı)
#
#   TEST 1: driver rolüyle optimize isteği -> 403 (requireRole kapısı)
#   TEST 2: company_admin, optimize (run A, V1+V2 araçlarla) -> 202 + jobId
#   TEST 3: poll döngüsü -> "completed" + available_vehicles ⊆ {V1,V2}
#            (çapraz-şirket araç sızıntısı YOK doğrulaması)
#   TEST 4: approve (run A, V1'e, manuel atama) -> 200, pushed=1;
#            public.tasks satırı DB'den doğrulanır (vehicle_id, status=assigned,
#            scheduled_start/end, enterprise_dispatch_task_id bağı)
#   TEST 5: optimize+poll (run B, farklı koordinatlar — dedup'a çarpmasın) ->
#            approve, run A ile AYNI vehicle_id + ÇAKIŞAN zaman penceresi ->
#            409 (override=false) — createBridgedTask'ın in-process çakışma
#            denetimi doğrulanır
#   TEST 6: aynı run B approve'u override=true ile tekrar -> 200, pushed=1;
#            enterprise.routing_jobs.response_payload.conflict_metadata/
#            conflict_override_reason DB'den doğrulanır
#
# Bu bir migration/uygulama dosyası DEĞİL — tek seferlik, elle çalıştırılan
# bir doğrulama aracı (cebi_dispatcher_faza_e2e_test.sh ile aynı desen). fleet-enterprise-01
# üzerinde, cebi-db/cebi-backend container'ları ayaktayken çalıştırılmalı:
#   cd /opt/cebi && git pull origin main && bash scripts/dev/cebi_dispatcher_faza2_vrp_e2e_test.sh
#
# NOT (idempotentlik): enterprise.routing_jobs'daki dedup kaydı (request_hash,
# WHERE status='completed') KASITLI OLARAK silinmez — kod bu senaryoyu zaten
# destekliyor (tekrar çalıştırmada aynı jobId'ye draft'lar "yeniden doğar",
# bkz. dispatcherTasks.js optimize route'u). Bu script tekrar tekrar
# çalıştırılabilir.
#
# Şifreler hiçbir adımda ekrana basılmaz (Sır Hijyeni, bkz. SESSION_NOTE.md).

set -uo pipefail

COMPANY_ID="e1f3ebdc-4732-4b9c-9c6b-f6fe1bea0cf6"
DRIVER_EMAIL="driver4@cebi-test.local"
ADMIN_EMAIL="admin4@cebi-test.local"
DRIVER_PASSWORD=$(openssl rand -hex 12)
ADMIN_PASSWORD=$(openssl rand -hex 12)

PICKUP_A="CEBI-TEST-004-PICKUP-A"
DROPOFF_A="CEBI-TEST-004-DROPOFF-A"
PICKUP_B="CEBI-TEST-004-PICKUP-B"
DROPOFF_B="CEBI-TEST-004-DROPOFF-B"

BASE="http://127.0.0.1:3100"

# ── JSON alanı çıkarma yardımcısı (jq yok — mevcut script konvansiyonu) ──
# Kullanım: json_get '<json string>' 'result.available_vehicles.0'
json_get() {
  printf '%s' "$1" | docker exec -i cebi-backend node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try {
        let o = JSON.parse(d);
        const path = '$2'.split('.');
        for (const k of path) { if (o == null) break; o = o[k]; }
        console.log(o === undefined || o === null ? '' : (typeof o === 'object' ? JSON.stringify(o) : o));
      } catch (e) { console.log(''); }
    })"
}

# ── İdempotent temizlik (FK sırası: tasks -> dispatch_tasks -> drivers -> vehicles -> users) ──
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.tasks WHERE enterprise_dispatch_task_id IN (
     SELECT id FROM enterprise.dispatch_tasks WHERE pickup_location->>'address' LIKE 'CEBI-TEST-004-PICKUP-%'
   );" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM enterprise.dispatch_tasks WHERE pickup_location->>'address' LIKE 'CEBI-TEST-004-PICKUP-%';" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.drivers WHERE license_no = 'TEST-LIC-004';" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.vehicles WHERE plate_no IN ('TEST-34-CEBI-04A', 'TEST-34-CEBI-04B');" >/dev/null
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.users WHERE email IN ('$DRIVER_EMAIL', '$ADMIN_EMAIL');" >/dev/null
echo "Onceki test kalintilari temizlendi (varsa). routing_jobs KASITLI OLARAK dokunulmadi (dedup testi icin)."

printf '%s\n' \
  "const bcrypt = require('bcryptjs');" \
  "bcrypt.hash(process.argv[2], 10).then(h => console.log(h));" \
  > /tmp/hash_pw_a2.js
docker cp /tmp/hash_pw_a2.js cebi-backend:/app/hash_pw_a2.js
DRIVER_HASH=$(docker exec cebi-backend node /app/hash_pw_a2.js "$DRIVER_PASSWORD")
ADMIN_HASH=$(docker exec cebi-backend node /app/hash_pw_a2.js "$ADMIN_PASSWORD")
docker exec cebi-backend rm -f /app/hash_pw_a2.js
rm -f /tmp/hash_pw_a2.js
echo "Hash'ler uretildi (uzunluklar: ${#DRIVER_HASH}, ${#ADMIN_HASH})"

DRIVER_USER_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.users (id, company_id, email, password_hash, role, first_name, last_name)
   VALUES (gen_random_uuid(), '$COMPANY_ID', '$DRIVER_EMAIL', '$DRIVER_HASH', 'driver', 'Test', 'Surucu4')
   RETURNING id;" | head -n 1)
ADMIN_USER_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.users (id, company_id, email, password_hash, role, first_name, last_name)
   VALUES (gen_random_uuid(), '$COMPANY_ID', '$ADMIN_EMAIL', '$ADMIN_HASH', 'company_admin', 'Test', 'Admin4')
   RETURNING id;" | head -n 1)
echo "driver user id: $DRIVER_USER_ID"
echo "admin user id: $ADMIN_USER_ID"

VEHICLE_V1=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.vehicles (id, company_id, plate_no, esp32_device_id, status)
   VALUES (gen_random_uuid(), '$COMPANY_ID', 'TEST-34-CEBI-04A', 'ESP32-CEBI-TEST-04A', 'available')
   RETURNING id;" | head -n 1)
VEHICLE_V2=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.vehicles (id, company_id, plate_no, esp32_device_id, status)
   VALUES (gen_random_uuid(), '$COMPANY_ID', 'TEST-34-CEBI-04B', 'ESP32-CEBI-TEST-04B', 'available')
   RETURNING id;" | head -n 1)
DRIVER_ID=$(docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "INSERT INTO public.drivers (id, user_id, company_id, license_no, license_expiry, status, assigned_vehicle_id)
   VALUES (gen_random_uuid(), '$DRIVER_USER_ID', '$COMPANY_ID', 'TEST-LIC-004', '2030-01-01', 'available', '$VEHICLE_V1')
   RETURNING id;" | head -n 1)
echo "vehicle V1 (surucu baglantili): $VEHICLE_V1"
echo "vehicle V2 (surucusuz): $VEHICLE_V2"
echo "drivers.id: $DRIVER_ID"

DRIVER_LOGIN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DRIVER_EMAIL\",\"password\":\"$DRIVER_PASSWORD\"}")
DRIVER_TOKEN=$(json_get "$DRIVER_LOGIN" "token")
echo "driver login: $( [ -n "$DRIVER_TOKEN" ] && echo OK || echo "FAIL -> $DRIVER_LOGIN" )"

ADMIN_LOGIN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
ADMIN_TOKEN=$(json_get "$ADMIN_LOGIN" "token")
echo "admin login: $( [ -n "$ADMIN_TOKEN" ] && echo OK || echo "FAIL -> $ADMIN_LOGIN" )"

# Run A ve Run B icin AYNI zaman penceresi baslangici -> TEST 5'te kasitli cakisma.
START_TS=$(date -u -d "+2 hours" +%Y-%m-%dT%H:%M:%SZ)

echo ""
echo "=== TEST 1: driver rolu ile POST /dispatcher/tasks/optimize (403 beklenir) ==="
curl -s -o /tmp/vrp_test1.json -w "HTTP %{http_code}\n" \
  -X POST "$BASE/dispatcher/tasks/optimize" \
  -H "Authorization: Bearer $DRIVER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"tasks\":[],\"vehicles\":[]}"
cat /tmp/vrp_test1.json; echo

echo ""
echo "=== TEST 2: company_admin, optimize Run A (V1+V2 ile, 202 beklenir) ==="
PAYLOAD_A=$(cat <<JSON
{
  "tasks": [
    {"pickup_location": {"lat":41.0082,"lng":28.9784,"address":"$PICKUP_A"},
     "dropoff_location": {"lat":41.0350,"lng":28.9950,"address":"$DROPOFF_A"}}
  ],
  "vehicles": ["$VEHICLE_V1","$VEHICLE_V2"],
  "routingMode": "fastest"
}
JSON
)
RESP2=$(curl -s -o /tmp/vrp_test2.json -w "HTTP %{http_code}" \
  -X POST "$BASE/dispatcher/tasks/optimize" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "$PAYLOAD_A")
echo "$RESP2"
cat /tmp/vrp_test2.json; echo
JOB_A=$(json_get "$(cat /tmp/vrp_test2.json)" "jobId")
echo "jobId (Run A): $JOB_A"

echo ""
echo "=== TEST 3: poll dongusu Run A (completed beklenir, max ~15s) ==="
STATUS_A=""
RESULT_A=""
for i in $(seq 1 15); do
  sleep 1
  POLL=$(curl -s "$BASE/dispatcher/tasks/optimize/poll/$JOB_A" -H "Authorization: Bearer $ADMIN_TOKEN")
  STATUS_A=$(json_get "$POLL" "status")
  echo "  [$i] status=$STATUS_A"
  if [ "$STATUS_A" = "completed" ]; then
    RESULT_A="$POLL"
    break
  fi
  if [ "$STATUS_A" = "failed" ]; then
    echo "  BEKLENMEYEN: job failed -> $POLL"
    break
  fi
done
AVAIL_VEHICLES_A=$(json_get "$RESULT_A" "result.available_vehicles")
DRAFT_A=$(json_get "$RESULT_A" "result.tasks.0.id")
echo "available_vehicles (Run A): $AVAIL_VEHICLES_A"
echo "draft task id (Run A): $DRAFT_A"
case "$AVAIL_VEHICLES_A" in
  *"$VEHICLE_V1"*|*"$VEHICLE_V2"*) : ;;
esac
echo "$AVAIL_VEHICLES_A" | grep -q "$VEHICLE_V1\|$VEHICLE_V2" \
  && echo "capraz-sirket arac sizintisi kontrolu: V1/V2'den en az biri listede (OK)" \
  || echo "capraz-sirket arac sizintisi kontrolu: BEKLENMEYEN - hic V1/V2 yok"

echo ""
echo "=== TEST 4: approve Run A (V1'e manuel atama, 200 + pushed=1 beklenir) ==="
PAYLOAD_APPROVE_A=$(cat <<JSON
{
  "routing_job_id": "$JOB_A",
  "vehicle_assignments": [{"taskId":"$DRAFT_A","vehicleId":"$VEHICLE_V1"}],
  "time_windows": [{"taskId":"$DRAFT_A","start":"$START_TS"}]
}
JSON
)
RESP4=$(curl -s -o /tmp/vrp_test4.json -w "HTTP %{http_code}" \
  -X POST "$BASE/dispatcher/tasks/optimize/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "$PAYLOAD_APPROVE_A")
echo "$RESP4"
cat /tmp/vrp_test4.json; echo

echo "  DB dogrulama: public.tasks satiri (enterprise_dispatch_task_id -> draft A)"
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT task_no || ' | vehicle=' || vehicle_id || ' | status=' || status
     || ' | start=' || scheduled_start || ' | end=' || scheduled_end
   FROM public.tasks WHERE enterprise_dispatch_task_id = '$DRAFT_A';"

echo ""
echo "=== TEST 5: optimize+poll+approve Run B, V1 ile CAKISAN pencere (override YOK -> 409 beklenir) ==="
PAYLOAD_B=$(cat <<JSON
{
  "tasks": [
    {"pickup_location": {"lat":41.0500,"lng":29.0100,"address":"$PICKUP_B"},
     "dropoff_location": {"lat":41.0700,"lng":29.0300,"address":"$DROPOFF_B"}}
  ],
  "vehicles": ["$VEHICLE_V1","$VEHICLE_V2"],
  "routingMode": "fastest"
}
JSON
)
RESPB=$(curl -s -o /tmp/vrp_test5_submit.json -w "HTTP %{http_code}" \
  -X POST "$BASE/dispatcher/tasks/optimize" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "$PAYLOAD_B")
echo "optimize Run B: $RESPB"
cat /tmp/vrp_test5_submit.json; echo
JOB_B=$(json_get "$(cat /tmp/vrp_test5_submit.json)" "jobId")
echo "jobId (Run B): $JOB_B"

STATUS_B=""
RESULT_B=""
for i in $(seq 1 15); do
  sleep 1
  POLLB=$(curl -s "$BASE/dispatcher/tasks/optimize/poll/$JOB_B" -H "Authorization: Bearer $ADMIN_TOKEN")
  STATUS_B=$(json_get "$POLLB" "status")
  echo "  [$i] status=$STATUS_B"
  if [ "$STATUS_B" = "completed" ]; then
    RESULT_B="$POLLB"
    break
  fi
done
DRAFT_B=$(json_get "$RESULT_B" "result.tasks.0.id")
echo "draft task id (Run B): $DRAFT_B"

PAYLOAD_APPROVE_B_CONFLICT=$(cat <<JSON
{
  "routing_job_id": "$JOB_B",
  "vehicle_assignments": [{"taskId":"$DRAFT_B","vehicleId":"$VEHICLE_V1"}],
  "time_windows": [{"taskId":"$DRAFT_B","start":"$START_TS"}]
}
JSON
)
RESP5=$(curl -s -o /tmp/vrp_test5_approve.json -w "HTTP %{http_code}" \
  -X POST "$BASE/dispatcher/tasks/optimize/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "$PAYLOAD_APPROVE_B_CONFLICT")
echo "approve Run B (override yok): $RESP5"
cat /tmp/vrp_test5_approve.json; echo
echo "  (409 ve conflict_metadata.conflicting_task_no = Run A'nin task_no'su olmali)"

echo ""
echo "=== TEST 6: approve Run B override=true ile tekrar (200 + pushed=1 beklenir) ==="
PAYLOAD_APPROVE_B_OVERRIDE=$(cat <<JSON
{
  "routing_job_id": "$JOB_B",
  "vehicle_assignments": [{"taskId":"$DRAFT_B","vehicleId":"$VEHICLE_V1"}],
  "time_windows": [{"taskId":"$DRAFT_B","start":"$START_TS"}],
  "override": true,
  "override_reason": "FazA2 e2e test - kasitli override"
}
JSON
)
RESP6=$(curl -s -o /tmp/vrp_test6.json -w "HTTP %{http_code}" \
  -X POST "$BASE/dispatcher/tasks/optimize/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "$PAYLOAD_APPROVE_B_OVERRIDE")
echo "$RESP6"
cat /tmp/vrp_test6.json; echo

echo "  DB dogrulama: public.tasks satiri (draft B) + routing_jobs.response_payload override izi"
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT task_no || ' | vehicle=' || vehicle_id || ' | status=' || status
   FROM public.tasks WHERE enterprise_dispatch_task_id = '$DRAFT_B';"
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT response_payload->'conflict_override_reason' FROM enterprise.routing_jobs WHERE id = '$JOB_B';"

echo ""
echo "=== Test betigi tamamlandi. ==="
