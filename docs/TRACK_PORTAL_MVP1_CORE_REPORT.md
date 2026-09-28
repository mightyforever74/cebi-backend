# Takip portali MVP1 — core

Dal: `feat/track-portal-mvp1` (taban `8fa45af`) · Tarih: 2026-09-28  
Prod ve merge yok. Staging §1–2 uygulandı.

Okunan: `WORKING_RULES.md`, `INFRASTRUCTURE.md` Ortam Matrisi + Server.js Deploy §1–2, `docs/TRACKING_PORTAL_P0_DISCOVERY.md`.

## Ne değişti

| Konu | Durum | Kanıt |
|---|---|---|
| Müşteri URL tabanı | `PUBLIC_TRACK_BASE_URL`, yoksa `https://track.tulipfleet.com/v` | `routes/publicTrack.js:6-15`, POST `server.js:5684`, `5704` |
| `.env.example` | dosya yoktu; eklendi. Değer varsayılan, `CHANGEME` değil. `.gitignore` `.env.*` bu dosyayı hariç tutar | `.env.example`, `.gitignore:3-4` |
| Alias | `GET /v/:token` ve `GET /v/:token.json` aynı fonksiyonlar. Eski `/public/track/*` duruyor | `routes/publicTrack.js:975-991` |
| Rate limit | yalnız bu dört kayıt (iki uç × iki yol). IP başına 60/dk. Gövde sabit | `routes/publicTrack.js:960-984` |
| Token kıyası | satır `WHERE token = $1` ile çekilir, sonra `crypto.timingSafeEqual` (uzunluk farkında pad) | `routes/publicTrack.js:18-28`, `61-90` |
| Kapalı görev | `completed`, `cancelled`, `withdrawn` → aynı `404` `{ error: "Invalid or expired link" }` | `routes/publicTrack.js:8`, `83-90` |
| İptal best-effort | status'u bu kümelere çeken handler'lar aşağıda | `revokePublicTrackingBestEffort` `routes/publicTrack.js:31-59` |

Public JSON ve HTML `routes/publicTrack.js` içinde tek fonksiyon; `server.js` yalnız `fastify.register` (`5724`). HTML, açıldığı yolun JSON'unu çağırır (`/v/...json` veya `/public/track/...json`).

## Status'u kapatan handler'lar

Grep `UPDATE tasks` + status ataması. Küme dışı yazanlar (offer `pending_review`, accept `accepted`, reject `rejected`, start `in_progress`) revoke etmez.

| Handler | Kapattığı status | Revoke |
|---|---|---|
| `PUT /api/driver/tasks/:id/complete` `server.js:5321` | `completed` | COMMIT öncesi `server.js:5480` |
| `PUT /api/driver/tasks/:taskId/withdraw` `server.js:4854` | `withdrawn` | COMMIT öncesi `server.js:4943` |
| `PUT /api/tasks/:id` `server.js:3491` | gövdedeki `status` kümedeyse (`COALESCE`) | yazımdan sonra `server.js:3634-3636`. Bu handler transaction açmaz; revoke ayrı autocommit, hata yutulur |
| `PUT /api/driver/task/:id/status` `server.js:1557` | `completed` veya `cancelled` (`validStatuses`) | `server.js:1665-1667`. `BEGIN` `1580`, başarı dönüşü `1668`, bu fonksiyonda `COMMIT` yok (önceden de yoktu). Revoke aynı transaction'da; bağlantı bırakılınca ikisi de geri alınır. Public 404 yine status kapısından gelir |

`routes/internalBridge.js` insert'i `assigned` yazar; kapalı statü değil.

## Test

`npm test` → `node --test tests/publicTrack.test.js` · 8 geçti, 0 kaldı.

| Durum | Beklenen |
|---|---|
| Geçerli token `GET /v/:token.json` | 200 |
| Aynı token `GET /public/track/:token.json` | 200 |
| `GET /v/:token` | 200 `text/html`, sayfa `/v/<token>.json` çağırır |
| İptal | 404 `{ error: "Invalid or expired link" }` |
| Süresi dolmuş | aynı 404 |
| `completed` | aynı 404 |
| Bilinmeyen ve kısa token | aynı 404, 500 yok |
| 61. istek (aynı IP) | 429, sonraki 429 gövdesi birebir aynı, `message` = `Too many requests` |

## Staging

Sunucu `fleet-prod-01`, kod `/opt/fleet/backend-staging`, PM2 `fleet-staging`, DB `fleet_tracking_staging`.  
Yedek: `server.js.bak.20260928_162807`, `package.json.bak.20260928_162807`, `package-lock.json.bak.20260928_162807`.  
`node --check` her iki dosya OK. `npm install --omit=dev` → `added 2 packages`. `require("@fastify/rate-limit")` ve `require("pg")` OK.  
`pm2 restart fleet-staging --update-env` → online.  
`http://127.0.0.1:3001/health` **200**. `https://staging-api.tulipfleet.com/health` **200**.  
`.env` içinde `PUBLIC_TRACK_BASE_URL` satır sayısı **0**; kod varsayılanı kullanıldı. Prod container'a dokunulmadı.

Staging git HEAD hâlâ `9b70d98` (dosya içeriği, CR yok sayılınca, kopyadan önce `8fa45af` `server.js` ile aynı md5 `8432cabcab2672da70e4fde2175b6140` idi). Git pointer taşınmadı.

Admin: `demo@tulipfleet.com` (`company_admin`). Açık bir görev (`status_before` `assigned`). Token/JWT/plaka/adres yazılmadı.

| Adım | Sonuç |
|---|---|
| `POST /api/tasks/:id/public-link` | **200**, `reused` false, `url` öneki `https://track.tulipfleet.com/v/` |
| `GET /v/:token.json` | **200** |
| Görev `status=completed` (SQL) | **404** `Invalid or expired link` |
| Status geri | `assigned` |
| `DELETE /api/tasks/:id/public-link` | **200** |
| Aynı link | **404** |

200 gövdesinin alan yolları (değer yok):

```
task, task.id, task.task_no, task.status, task.title,
task.start_location, task.end_location, task.vehicle_plate,
task.actual_start, task.actual_end,
waypoints, waypoints[],
events, events[],
last_location, last_location.latitude, last_location.longitude,
last_location.speed, last_location.heading, last_location.time,
eta, updated_at
```

`waypoints[]` ve `events[]` bu örnekte boştu (alt anahtar çıkmadı). `eta` null'dı (alt anahtar yok). `phone`, `first_name`, `last_name`, `driver_name`, `email`, `company_name` yok.

## Bilerek yapılmayan

- Prod kopyası, sürüm artışı, merge, push.
- `track.tulipfleet.com` DNS / landing. Core yalnız `/v/:token` üretir ve sunar.
