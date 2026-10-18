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

**2026-10-18 (Faz 4 — altyapı iskeleti eklendi):** Cem'in altyapı kararı: yeni bir sunucu/VPS kiralanmayacak — mevcut Hetzner sunucularından biri (fleet-prod-01 veya fleet-enterprise-01, kullanım oranı düşük) fiziksel olarak paylaşılacak, ama **tam mantıksal izolasyon** korunacak (ayrı Docker network, ayrı Postgres instance/port, ayrı `cebi.env`). Eklenenler: `docker-compose.cebi.yml` (izole `cebi-net` network, `cebi-db` + `cebi-backend` servisleri), `cebi.env.example` (yeni/bağımsız secret ve API key şablonu — ana projenin değerleriyle ortak hiçbir alan yok), `DEPLOYMENT_RUNBOOK.md` (Cem'in kendi SSH erişimiyle çalıştıracağı adımlar — bu session'ın Hetzner sunucularına ağ erişimi yok, doğrulandı).

**Henüz uygulanmadı (gerçek sunucuda), sadece kod/şablon seviyesinde hazır:**
- `JWT_SECRET` — henüz üretilmedi (runbook'ta `openssl rand -hex 32` adımı var).
- `DATABASE_URL` / Dedicated DB — henüz kurulmadı (compose dosyası hazır, sunucuda çalıştırılmadı).
- Dış servis anahtarları (HERE, OSRM/CARTO, SMTP, Google Maps, OpenWeather) — hiçbiri tedarik edilmedi.
- **Açık kararlar** (`DEPLOYMENT_RUNBOOK.md` §0'da detaylı): hangi sunucu (öneri: fleet-enterprise-01), domain/subdomain adlandırması, DB motoru (TimescaleDB vs. sade PostgreSQL) onayı.

Bu repo, yukarıdaki adımlar tamamlanana kadar üretim ortamına karşı **çalıştırılmamalı**.

## Değişiklik günlüğü

| Tarih | Not |
|---|---|
| 2026-10-18 | Fork oluşturuldu, baseline sabitlendi. |
| 2026-10-18 | Faz 4 başlangıcı: izole docker-compose, env şablonu, deployment runbook eklendi (commit `c4b5113`). Gerçek sunucu kurulumu henüz yapılmadı. |
