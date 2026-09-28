# Müşteri Takip Portalı — P0 keşif

Dal: `main` (`4501b35`) · Tarih: 2026-09-28  
Kod değişikliği yok. Canlı HTTP ve nginx `limit_req` bu turda ölçülmedi.

Ortam: staging katalog, salt-okunur  
`docker exec -i 6601902c43f0_fleet-postgres psql -U fleetadmin -d fleet_tracking_staging`  
(`INFRASTRUCTURE.md` Ortam Matrisi: core staging DB `fleet_tracking_staging`, postgres konteyneri `6601902c43f0_fleet-postgres`).

Okunan kaynaklar: `WORKING_RULES.md`, `INFRASTRUCTURE.md` Ortam Matrisi, `SESSION_NOTES.md` şema referansı (`locations.device_id = vehicles.esp32_device_id`, `vehicles.plate_no`, `companies.name`).

`routes/` içinde `public_tracking_tokens` SQL’i yok. Tabloya giden handler’ların hepsi `server.js`. `routes/company-plan.js` yalnız plan bayrağı taşır.

---

## 1. Şema (staging)

`\d public_tracking_tokens` (2026-09-28):

```
                                           Table "public.public_tracking_tokens"
       Column       |           Type           | Collation | Nullable |                      Default
--------------------+--------------------------+-----------+----------+----------------------------------------------------
 id                 | bigint                   |           | not null | nextval('public_tracking_tokens_id_seq'::regclass)
 task_id            | uuid                     |           | not null |
 token              | text                     |           | not null |
 created_at         | timestamp with time zone |           | not null | now()
 created_by_user_id | uuid                     |           |          |
 expires_at         | timestamp with time zone |           |          |
 is_revoked         | boolean                  |           | not null | false
Indexes:
    "public_tracking_tokens_pkey" PRIMARY KEY, btree (id)
    "idx_public_tracking_tokens_task_id" btree (task_id)
    "idx_public_tracking_tokens_token" btree (token)
    "public_tracking_tokens_token_key" UNIQUE CONSTRAINT, btree (token)
```

`\d` çıktısında Foreign-key constraints bölümü yok. `information_schema.table_constraints` aynı sonucu verdi: yalnız `PRIMARY KEY (id)` ve `UNIQUE (token)`. `task_id` ve `created_by_user_id` için FK yok.

| Soru | Kanıt |
|---|---|
| `is_revoked` | var, `boolean NOT NULL DEFAULT false` |
| `used` / `used_at` | yok. Kolon kümesi yukarıdaki 7 kolon |
| `expires_at` | var, nullable. Uygulama INSERT’i doldurur (`server.js:5761`); `NULL` sorgu tarafında “süresi dolmamış” sayılır (`server.js:5743`, `5797`, `6307`) |

Satır sayısı ve `expires_at` dağılımı:

```
 row_count
-----------
         0

 expires_null | expired | not_expired | revoked_true | revoked_false | usable_now | min_created | max_created | min_expires | max_expires
--------------+---------+-------------+--------------+---------------+------------+-------------+-------------+-------------+-------------
            0 |       0 |           0 |            0 |             0 |          0 |             |             |             |

 expires_day | n
-------------+---
(0 rows)

 lifetime_days | n
---------------+---
(0 rows)
```

Staging’de dağılım yok: tablo boş. 30 gün ömrü yalnız kodda (`server.js:5761`), veri ile doğrulanmadı.

Repo `migrations/` altında `public_tracking_tokens` geçen `.sql` yok.

---

## 2. Uçlar

Dört kayıt. `routes/` bu tabloyu okumaz/yazmaz.

| Method | Yol | preHandler | Rol / kapsam | Başarı gövdesi | Hata |
|---|---|---|---|---|---|
| POST | `/api/tasks/:id/public-link` | `authenticate` (`server.js:5717-5719`, dekoratör `330`) | `company_admin` veya `super_admin`; aksi `403` `{ error: "Admin access required" }` (`5724-5726`). `company_admin`: `tasks.id` + `company_id` (`5731-5737`), yoksa `404` `{ error: "Task not found" }`. **Görev `status` koşulu yok.** `super_admin` için varlık/şirket kontrolü yok | `{ success, url, token, expires_at, reused }` (`5750-5756`, `5770-5776`). `url` = `https://tulipfleet.com/public/track/<token>` | `500` `{ error: "Internal server error" }` |
| GET | `/public/track/:token.json` | yok (`5789`) | auth yok | `task`, `waypoints`, `events`, `last_location`, `eta`, `updated_at` (`5953-5969`) | geçersiz / iptal / süresi dolmuş: aynı dal, `404` `{ error: "Invalid or expired link" }` (`5795-5801`). Görev satırı yoksa `404` `{ error: "Task not found" }` (`5815-5816`) |
| GET | `/public/track/:token` | yok (`6286`) | auth yok. `?lang=` yoksa `tr` (`6288-6290`) | `text/html` Leaflet sayfası; 15 sn’de bir aynı origin `.json` (`6438`, `6530`) | aynı token sorgusu (`6305-6308`). Yok/iptal/süresi dolmuş: `404` `text/html`, `invalidLink` + `contactCompany` (`6310-6318`). Ayrım yok |
| DELETE | `/api/tasks/:id/public-link` | `authenticate` (`6547-6549`) | aynı rol kapısı (`6554-6556`). `super_admin` değilse şirket kapsamı (`6561-6568`, `9b70d98`) | `{ success: true, message: "All tokens revoked" }` (`6574`). `UPDATE` satır sayısı kontrol edilmez; token yoksa da `success: true` | `404` `{ error: "Task not found" }` yalnız kapsam kaçırırsa. `500` aynı metin |

`9b70d98` (`sec: cross-tenant fixes…`, 2026-09-13) DELETE’e şirket kontrolünü ekler. Güncel kod `server.js:6560-6572`: `super_admin` hariç `tasks.company_id = request.companyId`, sonra `is_revoked = true` (o görevdeki iptal edilmemiş satırların hepsi).

Üretimde görev durumu filtresi yok. Plan bayrağı `features.public_tracking` dört planda `true` (`routes/company-plan.js:17`, `31`, `45`, `59`) ve POST bu bayrağı okumaz.

Rate limit: `package.json` bağımlılıklarında rate-limit paketi yok. Public GET’lerde `preHandler` yok. `checkRateLimit` login dalında (`server.js:910`), bu yollara bağlı değil. Nginx bu raporda okunmadı.

Token karşılaştırması: `WHERE token = $1` (`5797`, `6307`). `server.js` içinde `timingSafeEqual` yok.

---

## 3. Public JSON alanları

Kaynak: `GET /public/track/:token.json` (`5806-5969`). Sürücü, kullanıcı ve `companies` join’i yok.

| Alan | Kaynak | KVKK / minimizasyon |
|---|---|---|
| `task.id` | `tasks.id` | fazla — iç UUID, sayfa çizmez |
| `task.task_no` | `tasks.task_no` | takip için beklenen |
| `task.status` | `tasks.status` | beklenen |
| `task.title` | `tasks.title` | fazla olabilir (serbest metin). HTML gövdesi çizmez; `<title>` yalnız `task_no` boşsa (`6326-6327`) |
| `task.start_location`, `task.end_location` | `varchar` (`şema`) | adres. Portal için beklenen, kişisel veri |
| `task.vehicle_plate` | `vehicles.plate_no` (`5809`) | plaka açık. Kişisel veri; allowlist kararı gerekir |
| `task.actual_start`, `task.actual_end` | `tasks` | operasyon zamanı. HTML çizmez |
| `waypoints` | kolonun tamamı, allowlist yok (`5847-5854`, `5965`) | staging’de görülen üst anahtarlar aşağıda. Telefon anahtarı yok |
| `events[]` | `id, type, message, stop_id, created_at`, `LIMIT 200` (`5821-5826`) | `message` fazla: red gerekçesi (`4904`) ve çekme gerekçesi (`5004-5006`) düz metin gider. HTML yalnız `type` + zaman çizer (`6471-6474`); tarayıcı yine tam JSON’u alır (`6438-6440`) |
| `last_location` | `latitude, longitude, speed, heading, time` — `ORDER BY time DESC LIMIT 1` (`5837-5843`) | konum beklenen. `speed` ve `heading` fazla (harita için gerekmez) |
| `eta` | aşağıdaki §6 | sonraki durak etiketi + mesafe + dakika |
| `updated_at` | `new Date()` (`5969`) | sunucu saati, konum zamanı değil |
| sürücü adı | yok | SELECT’te `drivers` / `users.first_name` yok |
| sürücü telefonu | yok | `users.phone` join’i yok |
| şirket adı | yok | `companies` join’i yok |
| konum geçmişi | yok | yanıtta tek satır. Hız hesabı içeride 5 dk ortalama ve son 2 noktayı okur (`757-779`) ve bunları gövdeye koymaz |

Staging `tasks.waypoints` üst anahtarları (`jsonb_object_keys`, token tablosu boş olduğu için token’a join edilmedi):

```
 address
 arrived_at
 completed_at
 departed_at
 id
 latitude
 longitude
 name
 planned_arrival
 status
```

`address` / `name` / koordinat teslim yeri. `arrived_at`, `departed_at`, `completed_at` müşteri haritası için fazla. İç içe nesne taranmadı; üst seviyede `phone` / `email` anahtarı yok.

Konum seçimi: `tasks.vehicle_id → vehicles.esp32_device_id`, sonra `locations.device_id = $1 ORDER BY time DESC LIMIT 1` (`5830-5842`). `company_id` ve görev zaman penceresi filtresi yok. Staging `locations` kolonları bu sorgudakilerle duruyor: `device_id varchar`, `time timestamptz`, `latitude`, `longitude`, `speed`, `heading`, ayrıca `company_id` (public SELECT onu kullanmıyor).

Görev bitince link kapanmaz (§5). Sorgu cihazın son noktasını istediği için, token durduğu sürece tamamlanmış görevin aracı da güncel konumu döner. Bu davranış koddan; staging’de token satırı olmadığı için veri örneği yok.

---

## 4. Kim açıyor

| Tüketici | Sonuç | Kanıt |
|---|---|---|
| Core HTML | var | `GET /public/track/:token` `server.js:6286-6534`. Leaflet + OSM, `?lang=` |
| Üretilen müşteri URL’si | `https://tulipfleet.com/public/track/<token>` | `server.js:5749`, `5769`. Host landing; sayfa core path’inde |
| Landing `C:\tulipfleet-landing` | takip sayfası yok | `src/pages/` altında `track` yok. `public/_redirects` yalnız `/sitemap.xml /sitemap-index.xml 301`. `public/track` eşleşmesi yok |
| Mobil `C:\argon` | link üretmiyor | `src/` içinde `public-link`, `public/track`, `public_tracking` yok. `docs/BACKEND_API_MAP.md:86` eski: `GET` ve satır `4356`. Canlı uç `POST` `server.js:5717` |
| Dispatcher `C:\dispatcher\src` | link üretmiyor | `public-link` / `public/track` / `public_tracking` yok. Geçen yerler `docs/functions/FEAT-005-predictive-eta-estimation.md` (Phase 2 spec: `enterprise.tracking_tokens`, `GET /api/public/tracking/:token`, `https://track.tulipfleet.com/{token}`). Bu spec core tablosu değil |
| Enterprise `C:\tulipfleet-enterprise-backend` | public takip ucu yok | `public_tracking`, `public/track`, `public-link`, `tracking_tokens` eşleşmesi yok |

Core sayfayı sunar. Repolarda bu POST’u çağıran ekran yok. Landing, API’nin yazdığı host için bir sayfa içermiyor. Cloudflare’de ayrı bir proxy bu raporda ölçülmedi.

---

## 5. Token

| Konu | Kanıt |
|---|---|
| Üretim | `crypto.randomBytes(24).toString("base64url")` (`server.js:22`, `5760`). 24 bayt = 192 bit. UUID değil |
| Ömür | `Date.now() + 30 * 24 * 60 * 60 * 1000` (`5761`). Kolon nullable; okuma `expires_at IS NULL` iken de geçerli sayar |
| Tek kullanım | değil. `used` kolonu yok. GET satırı güncellemez. HTML 15 sn poll (`6530`) |
| Görev başına | Aktif (iptal değil ve süresi dolmamış) varsa yenisi yazılmaz, `reused: true` (`5741-5756`). `task_id` unique değil; kontrol + INSERT aynı transaction’da değil (`5728` `connect`, bu blokta `BEGIN` yok) |
| Tamamlanınca | `PUT /api/driver/tasks/:id/complete` (`5387-5441`) status, sürücü, araç, alert, `TASK_COMPLETED` yazar. `public_tracking_tokens` yok. Tek `is_revoked = true` DELETE uçunda (`6570-6572`) |
| İptal | DELETE §2. Süresi dolmuş ile iptal ile hiç olmayan token public’te aynı `404` |

---

## 6. Tazelik ve ETA

Son konum §3: cihazın `locations` içindeki en yeni satırı. Geçmiş dizisi dönmez.

Public ETA var, HERE değil. `server.js:5856-5949`:

- sonraki durak: `status !== "completed"` ilk waypoint (`748-754`)
- mesafe: haversine km (`732-740`, `5868`)
- hız: son 5 dk ortalama, eşik 3 km/h (`757-767`); yoksa son noktanın `speed` alanı; o da yoksa son iki nokta (`770-799`, 5–600 sn, tavan 160)
- `speed >= 3` ise `minutes = max(1, round(distance/speed*60))`, `arrival_time`, 10 dk toleransla `delayed` (`5881-5913`)
- değilse `minutes: null`, `reason: "no_speed"` (`5934-5948`)
- gecikmede 30 dk’da bir `STOP_DELAYED` event yazar (`5916-5931`) — public okuma yan etki üretir

`routingProvider.computeRoute` public handler’da yok. Core HERE karşılığı `services/routing/HereRoutingProvider.js:41-85` (`durationSec`), çağıranlar `GET /api/driver/route-traffic` (`6655`) ve `GET /api/driver/drive-conditions` (`6832`). İkisi de `authenticate`.

`estimateDriveSeconds` core’da yok. Enterprise’da `C:\tulipfleet-enterprise-backend\routes\tasks.js:66-106`: HERE v8 truck `return=summary`, olmazsa haversine 40 km/h + %15, koordinat yoksa 2 saat. Çağrı approve penceresi (`528-533`), public takip değil.

---

## 7. Portal MVP boşlukları

| Parça | Durum | Kanıt |
|---|---|---|
| Public HTML | kısmi | Core sayfa var (`6286-6534`). Müşteriye verilen host `tulipfleet.com` (`5749`). Landing’de bu yol yok (`src/pages/`, `_redirects`). Açan UI (argon, dispatcher) yok |
| ETA | var, yol ETA’sı değil | Haversine + hız (`5856-5949`). HERE `estimateDriveSeconds` public cevaba bağlı değil (`routes/tasks.js:66`, çağrı `528`) |
| Durum zaman çizelgesi | kısmi | `task_events` en fazla 200 (`5821-5826`). HTML son 20’yi tip + saat olarak ters çizer (`6471-6474`), `message` çizmez. Ayrı timeline modeli yok |
| İptal UI | yok | DELETE API var (`6547-6574`, şirket kapsamı `9b70d98` / `6560-6568`). argon `src/`, dispatcher `src/`, landing, enterprise bu yolu çağırmıyor |
| Rate limit | yok (uygulama) | Public GET’te preHandler yok (`5789`, `6286`). `package.json` rate-limit paketi yok. Login limiti bu yola bağlı değil (`910`). Nginx ölçülmedi |
| i18n | kısmi | Sayfa içi sözlük `tr, en, ku, nl, bg, it, es` (`5982-6284`). Varsayılan `tr` (`6288-6290`). Argon `src/locales/` ayrıca `de.json`, `fr.json` taşır; public sayfada yok. Ortak sözlük script’i değil, `server.js` içine gömülü |
| Görev bitince linki kapatma | yok | §5 |
| Sabit zamanlı token kıyası | yok | SQL `token = $1` (`5797`) |
| Plan bayrağı | yok (uygulanmıyor) | Bayrak tanımlı (`company-plan.js:17`) ama POST okumuyor |
| FK `task_id` | yok | `\d` ve `information_schema` |
| Staging veri | yok | `COUNT(*) = 0` |

Sır değeri (token, URL örneği, bağlantı cümlesi) yazılmadı.
