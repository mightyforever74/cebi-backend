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

Dobbe staging’de **speeding / harsh_brake yok**. SOS bu şirkette yok (1 SOS başka şirkette).

```sql
select count(*) from alerts
 where alert_type is null or alert_type <> lower(trim(alert_type));
```

**non_normalized = 2** (`SOS`, `TEST`).

Prod (salt-okunur, karşılaştırma): Dobbe `harsh_brake`×1 + `speeding`×1, tarih **2026-05-06**. Staging’e kopyalanmamış.

JSON’da olmayan canlı tipler: `gps_odometer_deviation`, `TEST`.

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

**IMPACT = 0** (sabit, beklenen). **HARD_BRAKE / OVERSPEED = 0** çünkü staging Dobbe’de `harsh_brake`/`speeding` satırı yok (sorgu §1). Prod’daki 2 satır 2026-05-06 ve staging’de yok. Sayaçlar ayrıca görev penceresine (`actual_start`…`actual_end`) bağlı; tip eşleşmesi olsa bile pencere dışı satır sayılmaz.

---

## Kapsam dışı

- main merge, production docker, sürüm bump — Cem onayı
- Staging’e speeding/harsh_brake INSERT
- `HARD_TURN` / `HARD_ACCEL` için canlı eşleme (yok)
