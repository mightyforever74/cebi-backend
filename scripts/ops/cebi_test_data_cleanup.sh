#!/usr/bin/env bash
# scripts/ops/cebi_test_data_cleanup.sh — scripts/dev/*_e2e_test.sh'lerin
# biriktirdiği test verisini SADECE SİLER (yeniden seed/test etmez).
#
# Kapsam (bilinen test kimlikleri, her iki e2e scripti ile birebir aynı):
#   Weighbridge testi:  task_no=CEBI-TEST-001, license_no=TEST-LIC-001,
#                       plate_no=TEST-34-CEBI, esp32_device_id=ESP32-CEBI-TEST-01,
#                       email driver1@cebi-test.local, tarti1@cebi-test.local
#   Telemetri testi:    task_no=CEBI-TEST-002, license_no=TEST-LIC-002,
#                       plate_no=TEST-34-CEBI-02, esp32_device_id=ESP32-CEBI-TEST-02,
#                       email driver2@cebi-test.local, admin2@cebi-test.local
#
# BİLEREK DOKUNULMAYAN: admin@cebi-test.local — bu, e2e test scriptlerinin
# ürettiği scratch veri değil, Faz 4 deployment'ında atılan ilk temel seed
# (test şirketi + company_admin) — altyapı doğrulaması için duruyor,
# ayrı bir karar gerektirir, bu script onu silmez.
#
# İdempotent — tekrar çalıştırmak güvenli (zaten silinmiş satırlar için
# hata vermez). FK sırası: weighbridge_readings/mobile_location_pings ->
# tasks -> drivers -> vehicles -> users.

set -uo pipefail

echo "Silinecek test kullanicilari: driver1, tarti1, driver2, admin2 (@cebi-test.local)"
echo "DOKUNULMAYAN: admin@cebi-test.local (temel altyapi seed verisi)"
echo ""

docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.weighbridge_readings WHERE task_id IN (SELECT id FROM public.tasks WHERE task_no IN ('CEBI-TEST-001','CEBI-TEST-002'));"
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.mobile_location_pings WHERE task_id IN (SELECT id FROM public.tasks WHERE task_no IN ('CEBI-TEST-001','CEBI-TEST-002'));"
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.tasks WHERE task_no IN ('CEBI-TEST-001','CEBI-TEST-002');"
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.drivers WHERE license_no IN ('TEST-LIC-001','TEST-LIC-002');"
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.vehicles WHERE plate_no IN ('TEST-34-CEBI','TEST-34-CEBI-02') OR esp32_device_id IN ('ESP32-CEBI-TEST-01','ESP32-CEBI-TEST-02');"
docker exec cebi-db psql -U cebi_admin -d cebi_db -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.users WHERE email IN ('driver1@cebi-test.local','tarti1@cebi-test.local','driver2@cebi-test.local','admin2@cebi-test.local');"

echo ""
echo "Temizlik tamamlandi. Kalan @cebi-test.local kullanicilari:"
docker exec cebi-db psql -U cebi_admin -d cebi_db -tAc \
  "SELECT email, role FROM public.users WHERE email LIKE '%@cebi-test.local' ORDER BY email;"
