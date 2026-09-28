# Reports alert counters — live `alert_type` map

Dal: `fix/reports-alert-counters` · Taban: main `4501b35` · Kod: `ca0ec46`  
Tarih: 2026-09-28 · Staging: `fleet-staging` PM2 restart + `/health` ok · **main merge / prod yok** (Cem onayı, INFRASTRUCTURE §3)

---

## 1. Kanıt sorguları (staging `fleet_tracking_staging`, salt-okunur)

```sql
select alert_type, count(*) from alerts group by 1 order by 2 desc;
```

| alert_type | count |
|---|---|
| task_started | 14 |
| task_completed | 8 |
| task_accepted | 3 |
| gps_odometer_deviation | 3 |
| task_withdrawn | 2 |
| SOS | 1 |
| TEST | 1 |

```sql
select company_id, alert_type, count(*) from alerts
 where company_id='efbaa346-cde9-489a-b3e9-6fd61df0c121'  -- Dobbe, DEMO_OLUSTURMA §1
 group by 1,2;
```

| alert_type | count |
|---|---|
| task_started | 14 |
| task_completed | 6 |
| gps_odometer_deviation | 3 |
| task_accepted | 3 |
| task_withdrawn | 2 |
| TEST | 1 |

Bu anlık görüntüde Dobbe’de speeding / harsh_brake yoktu. Kanıt satırları §7’de eklendi ve **silinmedi**.

```sql
select count(*) from alerts
 where alert_type is null or alert_type <> lower(trim(alert_type));
```

**non_normalized = 2** — `lower(trim(alert_type))` ile aynı değil:

| Şirket | alert_type | gün | ne |
|---|---|---|---|
| Dobbe Transport | `TEST` | 2026-04-07 | büyük harf; açıklama boş. Manifestte yok. |
| Tulip Lojistik | `SOS` | 2026-04-07 | büyük harf. Açıklama “SOS: Test Sürücü … Test SOS - acil durum”. Manifest `sos` (küçük); harita `lower+trim` ile `SOS` sayar, driving sayacına girmez. |

Prod (salt-okunur, karşılaştırma): Dobbe `harsh_brake`×1 + `speeding`×1, tarih **2026-05-06**.

Manifestte (`adminAlerts.types`) olmayan DB tipleri: `gps_odometer_deviation` (staging 3 satır), `TEST` (1 satır, yukarıdaki). İkisi de `ALERT_TYPE_MAP` dışında; sayaçlara girmez, bir kez warn.

---

## 2. Sözlük — `services/alerts/alertTypes.js`

`C:\argon\scripts\i18n-dynamic-roots.json` içinde **`alerts.alert_type` anahtarı yok**. En yakın küme `adminAlerts.types`:

`task_accepted`, `task_started`, `task_completed`, `task_withdrawn`, `task_offered`, `task_rejected`, `geofence_entry`, `geofence_exit`, `sos`, `speeding`, `harsh_brake`

`LIVE_ALERT_TYPES` bu listeyle birebir (normalize `sos`). Farklar:

| Kaynak | Değer |
|---|---|
| JSON | `sos` (küçük) |
| Staging DB | `SOS` (büyük) — lower+trim → `sos` |
| JSON’da yok, DB’de var | `gps_odometer_deviation`, `TEST` |
| JSON’da var, staging DB’de yok | `speeding`, `harsh_brake`, `geofence_*`, `task_offered`, `task_rejected` |

`ALERT_TYPE_MAP` (eşleşme **lower+trim**):

| Canlı | Rapor anahtarı |
|---|---|
| speeding | OVERSPEED |
| harsh_brake | HARD_BRAKE |
| sos | SOS |
| *(yok)* | **IMPACT** — canlı karşılık yok; `impact_count` **0 sabit** (mobil geriye uyumluluk) |

Haritada olmayan tip sayılmaz; `warnUnmappedAlertTypes` süreç başına **bir kez** `request.log.warn`.

`HARD_TURN` / `HARD_ACCEL`: haritada yok → SQL `FALSE` → sayaç 0. Yanıt şekli değişmez.

---

## 3. Grep (repo JS, `node_modules` hariç)

```
rg -n "HARD_BRAKE|OVERSPEED|IMPACT|HARSH" --glob "*.js" .
```

Hepsi `services/alerts/alertTypes.js`, `routes/reports.js` (`sqlAlertTypeFilter(..., "HARD_BRAKE"|"OVERSPEED"|"IMPACT")`), `tests/reports.alertCounters.test.js`. Başka üst-case alarm sabiti yok.

---

## 4. Mobil sözleşme — yanıt şekli değişmedi

Kaynak: `C:\argon\src\screens\admin\AdminReportsScreen.js` (`GET /api/reports/drivers/performance?days=`), `src/services/api.js` (`reportAPI.getDrivers` başka uç: `/api/reports/drivers`, sayaç okumaz).

Driving Quality **okunan alanlar** (JSON anahtarları **snake_case**, `HARD_BRAKE` değil):

| Alan | Kullanım |
|---|---|
| `hard_brake_count` | chip + PDF satırı |
| `hard_turn_count` | chip + PDF |
| `hard_accel_count` | chip + PDF |
| `overspeed_count` | chip + PDF |
| `impact_count` | chip + PDF |
| `total_alerts` | satır |
| `driving_score`, `score_note` | skor |
| `first_name`, `last_name`, `total_km`, `completed_tasks`, `total_tasks`, `avg_duration_min` | kimlik / özet |

---

## 5. Unit test

`npm test` → `node --test tests/reports.alertCounters.test.js`

```
✔ LIVE_ALERT_TYPES includes speeding, harsh_brake, sos, geofence and task_*
✔ ALERT_TYPE_MAP live → report keys
✔ normalizeAlertType lower+trim; NULL/empty → empty string
✔ resolveReportKey maps mixed case and SOS
✔ sqlAlertTypeFilter uses live types; IMPACT and unmapped are FALSE
✔ countDrivingQuality: lower/upper/padded/NULL/unknown → expected counters
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

Mock: `harsh_brake`+`HARSH_BRAKE` → 2; `speeding`+`SPEEDING` → 2; `SOS` haritada ama driving alanında yok; `NULL`/boş atlanır; `geofence_entry`/`IMPACT`/`no_such_type` warn×1; `impact_count` 0.

---

## 6. Staging (INFRASTRUCTURE §1–2)

| Adım | Sonuç |
|---|---|
| `node --check` server.js + reports.js + alertTypes.js | ok |
| `pm2 restart fleet-staging --update-env` | online |
| `GET https://staging-api.tulipfleet.com/health` | `status=ok`, database/mqtt/redis connected |

Staging git `fetch` PAT yok; `main` dirty (`server.js`, `internalBridge.js` yerel). Kod **scp** ile kopyalandı (`reports.js.bak.alertcounters`). **server.js dokunulmadı.**

Dobbe `demo@` + `GET /api/reports/drivers/performance?days=365` (sır yok):

| Sürücü | hard_brake | overspeed | impact | total_alerts |
|---|---|---|---|---|
| Pieter van den Berg | 0 | 0 | 0 | 1 |
| Jan de Vries | 0 | 0 | 0 | 0 |
| Anna Jansen | 0 | 0 | 0 | 1 |
| Mehmet Yilmaz | 0 | 0 | 0 | 1 |

Bu çağrı **kanıt INSERT’inden önce**. IMPACT 0. HARD_BRAKE / OVERSPEED 0 çünkü o anda Dobbe’de `harsh_brake` / `speeding` yoktu. Sonraki kanıt: §7.

---

## 7. Staging kanıt satırları (silinmedi)

DEMO_OLUSTURMA §4.7 yöntem C — `alerts` hypertable, `ts_insert_blocker`:

```sql
BEGIN;
SET LOCAL session_replication_role = 'replica';
-- speeding + harsh_brake INSERT … RETURNING
COMMIT;
```

Hedef: Dobbe `efbaa346-…`, araç BX-TR-42 `b1b2b3b4-…0001` (Pieter van den Berg), `created_at = now()`, `is_resolved = false`, `description = '[TEST counters 28 Eyl]'`.

| alert_type | severity | created_at (DB) | is_resolved |
|---|---|---|---|
| speeding | warning | 2026-09-28 11:22:36 | false |
| harsh_brake | warning | 2026-09-28 11:22:36 | false |

Pencere: Pieter’in `TLP-26-00016` (`in_progress`, `actual_end` NULL) `now()`’u kapsar; `COUNT DISTINCT` aynı alarmı bir kez sayar.

`GET /api/reports/drivers/performance?days=365` (staging, Dobbe `demo@`, sır yok):

| Sürücü | hard_brake_count | overspeed_count | impact_count | total_alerts | driving_score |
|---|---|---|---|---|---|
| Pieter van den Berg | **1** | **1** | **0** | 3 | 89 |
| Jan de Vries | 0 | 0 | 0 | 0 | |
| Anna Jansen | 0 | 0 | 0 | 1 | |
| Mehmet Yilmaz | 0 | 0 | 0 | 1 | |

`impact_count` 0 sabit. Satırlar staging’de duruyor; silinmedi.

---

## Kapsam dışı

- main merge, production docker, sürüm bump — Cem onayı
- `HARD_TURN` / `HARD_ACCEL` için canlı eşleme (yok)
