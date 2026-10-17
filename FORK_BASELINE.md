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

## Bağımsızlık durumu (fork anında — henüz uygulanmadı)

Kod aynen taşındı; **hiçbir bağımsızlaştırma adımı henüz yapılmadı**. Bu repo şu an:
- Aynı `JWT_SECRET` değerlerine (kaynak env ile) atıfta bulunuyor — henüz kendi secret'ı yok.
- `DATABASE_URL` placeholder — Dedicated DB henüz kurulmadı.
- `.env.example`'daki tüm dış servis anahtarları (HERE_API_KEY, GOOGLE_MAPS_API_KEY, SMTP_*, MQTT_*) kaynak değerlerle **commit edilmemiş** durumda (zaten `.env` hiçbir repoda commit edilmiyordu) — ama bu repo, yeni ve bağımsız kimlik bilgileriyle tedarik edilene kadar üretim ortamına karşı **çalıştırılmamalı**.

Bağımsızlaştırma (yeni secret, yeni DB, yeni API key seti, OSRM/CARTO entegrasyonu, Weighbridge modülü) Faz 4'ün kapsamıdır.

## Değişiklik günlüğü

| Tarih | Not |
|---|---|
| 2026-10-18 | Fork oluşturuldu, baseline sabitlendi. |
