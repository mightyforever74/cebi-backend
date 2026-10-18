# FORK_BASELINE.md — cebi-backend

Bu dosya, `cebi-backend` reposunun "doğum sertifikası"dır. Fork anındaki durumu sabitler; ilerleyen fazlarda değiştirilmez, sadece altına tarihli not eklenir.

| Alan | Değer |
|---|---|
| **Proje** | TulipFleet Customer Edition — Backend |
| **Fork tarihi** | 2026-10-18 |
| **Kaynak repo** | https://github.com/mightyforever74/tulipfleet-backend |
| **Baseline branch** | `main` (kaynak `origin/main`) |
| **Baseline commit SHA** | `23bfa4e7252daac0bbc70a546384a8ccf5b275b1` |
| **Baseline commit mesajı** | "fix: superadmin Clear WiFi/command endpoint yanlis MQTT topic ve komut kullaniyordu" |
| **Fork senaryosu** | Senaryo A — doğrudan `origin/main`'den, prod→main senkronizasyon gecikmesi (Faz 1 Risk #6) dikkate alınmadan |
| **Doğrulama** | Fork anında `git fetch origin main` ile drift kontrolü yapıldı: kaynak repodaki local HEAD ile `origin/main` birebir eşleşti (hiç drift yok). Push sonrası `git ls-remote origin main` ile bu repodaki `main`'in aynı SHA olduğu doğrulandı. |
| **Kardeş repolar (aynı fork turunda)** | `cebi-mobile` ← `tulipfleet` @ `b51570a8e85ba57ab9425f09c6cf222ed68699fd` · `cebi-dispatcher` ← `tulipfleet-dispatcher` @ `723f3a21f74d1935323b2b82ba75b73d379b0b5d` |
| **İptal edilen 4. repo** | `cebi-enterprise-backend` — **açılmadı**. Karar: `tulipfleet-enterprise-backend`'i ayrı bir servis olarak fork etmek, Modular Monolith kararıyla ve ADR-CE-03'ün Bağımsız Çalışma Zamanı ilkesiyle çelişir (tek-tenant sistemde iki servis arası JWT/bridge kenetlenmesini gereksiz yere geri getirir). İlgili modüller (`routes/tasks.js`, `routes/exceptions.js`, `routes/decisionLog.js` vb.) bu repoya **referans alınarak** modüler monolith içine taşınacak. |
| **Faz 1 raporu** | Proje dokümanı: `claude/tulipfleet-customer-edition-faz1-kesif-raporu.md` (6 repo keşif, risk analizi, 9 soru/cevap) |
| **ADR'ler** | `/docs/adr/ADR-CE-01…04` (bu repoda, Customer Edition'ın tüm bileşenlerini kapsayan merkezi mimari kararlar) |

## Bağımsızlık durumu

**2026-10-18 (fork anında):** Kod aynen taşındı; hiçbir bağımsızlaştırma adımı henüz yapılmamıştı.

**2026-10-18 (Faz 4 — altyapı iskeleti):** Cem'in altyapı kararı: yeni bir sunucu/VPS kiralanmayacak — mevcut Hetzner sunucularından biri fiziksel olarak paylaşılacak, ama **tam mantıksal izolasyon** korunacak (ayrı Docker network, ayrı Postgres instance/port, ayrı `cebi.env`). Eklenenler: `docker-compose.cebi.yml` (izole `cebi-net` network, `cebi-db` + `cebi-backend` servisleri), `cebi.env.example` (yeni/bağımsız secret ve API key şablonu — ana projenin değerleriyle ortak hiçbir alan yok).

**Sunucu seçimi — KARARLAŞTIRILDI: `fleet-enterprise-01`.**

**Açık kararlar — İKİSİ DE ÇÖZÜLDÜ (2026-10-18, canlı deployment):**
- ~~Domain/subdomain adlandırması~~ → **`cebi-api.tulipfleet.com`** kararlaştırıldı, DNS+Cloudflare Origin Certificate+Caddy ile canlıda çalışıyor.
- ~~DB motoru~~ → **TimescaleDB HA + PostGIS** (`timescale/timescaledb-ha:pg16`) — ana projenin prod image'ıyla aynı aile (`INTEGRATION_BOUNDARIES.md §3.1`). Düz `timescaledb:2.17.0-pg16` önce denendi, PostGIS içermediği için (prod şemasında `public.geometry` tipi var) değiştirildi.

**Uygulandı (gerçek sunucuda, `fleet-enterprise-01`):**
- `JWT_SECRET`, `CEBI_DB_PASSWORD` — `openssl rand -hex` ile üretildi, sadece varlığı doğrulandı, değerler hiç ekrana basılmadı.
- Dedicated DB (`cebi-db`) — tam prod şeması import edildi: 39 `public` + 17 `enterprise` tablo, 4 extension (`postgis`, `btree_gist`, `timescaledb`, `plpgsql`), 8 hypertable (doğru zaman kolonlarıyla). Detaylı saga: `SESSION_NOTE.md`.
- `cebi-backend` — şemaya karşı fonksiyonel doğrulandı (`/health` → `200`, `"database":"connected"`); ilk seed veri (test şirketi + `company_admin` kullanıcısı) eklendi, `POST /api/auth/login` gerçek kimlik bilgisiyle denenip geçerli bir JWT token döndürdü — uçtan uca doğrulandı.
- `HERE_API_KEY` — HERE Developer Portal'da aynı hesap altında ayrı bir app (**"TulipFleet Cebi"**, ana projenin "TulipFleet" app'inden farklı) + ayrı API key oluşturuldu (ADR-CE-03: ayrı hesap değil, paylaşılmayan secret yeterli — bkz. değişiklik günlüğü). Routing API v8'e doğrudan istek ile fonksiyonel doğrulandı. Detaylı saga (OAuth/API-key karışıklığı + `restart` vs `up -d` gotcha'sı): `SESSION_NOTE.md`.
- `GOOGLE_MAPS_API_KEY` — `tulipfleet-523be` (ana proje GCP projesi) içinde ayrı, Cebi'ye özel key oluşturuldu, sadece Geocoding API'ye kısıtlı (ADR-CE-03: aynı pattern, paylaşılmayan credential). Billing hesabı bu oturumda projeye bağlandı (önceden bağlı değildi). Geocoding API'ye canlı istekle fonksiyonel doğrulandı. **Not:** bu süreçte oluşturulan ilk key yanlışlıkla sohbete sızdı (gcloud stderr log'u) ve hemen silinip yenisiyle değiştirildi — detay ve ders `SESSION_NOTE.md`'de.

**Henüz uygulanmadı:**
- Dış servis anahtarları: `OPENWEATHER_API_KEY`, SMTP — tedarik edilmedi (OSRM/CARTO ve MQTT bilinçli olarak erteleniyor).
- Weighbridge bounded context — kod/migration hâlâ yazılmadı.

Bu repo artık altyapı+şema seviyesinde canlı ve fonksiyonel; dış servis anahtarları ve ilk seed veri eksik olduğundan **tam üretim kullanımına henüz hazır değil**. Deployment Cem'le birlikte, adım adım yapılıyor — ayrı bir runbook dokümanı yok (standart: SESSION_NOTE.md + FORK_BASELINE.md + ADR, başka doküman türü eklenmez).

## Değişiklik günlüğü

| Tarih | Not |
|---|---|
| 2026-10-18 | Fork oluşturuldu, baseline sabitlendi. |
| 2026-10-18 | Faz 4 başlangıcı: izole docker-compose + env şablonu eklendi (commit `c4b5113`). |
| 2026-10-18 | Sunucu seçimi kararlaştırıldı: `fleet-enterprise-01`. Ayrı bir DEPLOYMENT_RUNBOOK.md dokümanı yazılmıştı — Cem'in talebiyle silindi (doküman standardımız SESSION_NOTE/FORK_BASELINE/ADR dışına çıkmıyor); deployment birlikte adım adım yapılacak. |
| 2026-10-18 | Canlı deployment tamamlandı: domain (`cebi-api.tulipfleet.com`) + Caddy/TLS + `cebi-db`/`cebi-backend` izole container'ları + tam prod şeması (hypertable'lar dahil) + fonksiyonel doğrulama. İki açık karar (domain, DB motoru) çözüldü. Detay: `SESSION_NOTE.md`. |
| 2026-10-18 | İlk seed veri (test şirketi + `company_admin` kullanıcısı) eklendi, `/api/auth/login` gerçek JWT token döndürerek uçtan uca doğrulandı. |
| 2026-10-18 | `HERE_API_KEY` tedarik edildi (ayrı "TulipFleet Cebi" app, ayrı key — aynı HERE hesabı), Routing API v8 ile fonksiyonel doğrulandı. Detay: `SESSION_NOTE.md`. |
| 2026-10-18 | `GOOGLE_MAPS_API_KEY` tedarik edildi (ayrı key, `tulipfleet-523be` projesi, sadece Geocoding API), billing bağlandı, fonksiyonel doğrulandı. Süreçte sızan bir ara key tespit edilip derhal silindi/değiştirildi. Detay: `SESSION_NOTE.md`. |
