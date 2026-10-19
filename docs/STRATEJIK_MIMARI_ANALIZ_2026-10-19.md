# Stratejik Mimari Analiz ve Yol Haritası — TulipFleet Customer Edition (Cebi)

**Tarih:** 2026-10-19
**Yazar:** Claude (Cem'in talebiyle, kıdemli mimar sentezi olarak)
**Kapsam:** `cebi-backend`, `cebi-mobile`, `cebi-dispatcher` (fork'lar) + `tulipfleet-enterprise-backend` (salt-okunur referans)
**Yöntem:** "İspat et" disiplini — her madde dosya yolu/migration/commit/kod satırıyla doğrulanmıştır; doğrulanamayan hiçbir madde "yapılmış" olarak sunulmaz, açıkça "açık" işaretlenir.

## Önsöz — bu rapor ne, ne değil

Bu rapor **yeni bir mimari karar belgesi değildir**. Cem'in istediği 4 başlık (Doküman Yönetimi, Markalama/İzolasyon, Modüler Monolit/Durum Makinesi, Kontrollü Fork/Taşınabilirlik) için istenen kararların **büyük kısmı zaten verilmiş ve kodlanmış/canlıda doğrulanmış** durumda — bu rapor onları tek yerde, kanıtlarıyla konsolide eder. Araştırma sırasında **gerçekten açık/eksik olan tek madde** bulundu (Bölüm 1) ve somut bir düzeltme önerisiyle sunuldu. Diğer üç başlıkta "açık" diye işaretlenen alt-sorular da ayrıca not edilmiştir — onlar icat edilmemiştir, dürüstçe "henüz yok" denmiştir.

---

## 1. DOKÜMAN YÖNETİMİ VE ARŞİVLEME (_archived/ ve bağlayıcılık ibaresi)

### Mevcut durum (kanıt)

Bu konvansiyon zaten var — ama **tek bir repoda, kısmi**. `cebi-dispatcher/docs/ROADMAP.md` (fork öncesi `tulipfleet-dispatcher`'dan devralındı) kendi içinde bu deseni zaten kullanıyor:

- `docs/ROADMAP_ARCHIVE.md` başında bağlayıcılık ibaresi: *"Bu dosya `docs/ROADMAP.md`'den bilgi kaybı olmadan taşınan tamamlanmış-iş anlatısı... içerir... Güncel durum ve aktif plan için otorite: `docs/ROADMAP.md`."*
- Yani "ARŞİV = tarihsel, bilgi kaybı yok, ama OTORİTE DEĞİL" ilkesi zaten kodlanmış bir konvansiyon.

### Bulunan gerçek boşluk (yeni bulgu, somut kanıt)

`cebi-dispatcher` fork'u `tulipfleet-dispatcher`'ın **TÜM `docs/` ağacını** (41 dosya: `ROADMAP.md`, `docs/adr/ADR-0001..0014`, `docs/functions/FEAT-*`, `docs/strategy/STRATEGIC_ROADMAP_3PL_GIG.md`, `ENTERPRISE_INFRASTRUCTURE.md`, `INTEGRATION_BOUNDARIES.md` vb.) **birebir, hiç işaretlenmeden** devraldı. Bu dosyalar hâlâ **ana projenin (enterprise) kendi production gerçekliğini** anlatıyor:

```
docs/ROADMAP.md:3: "A high-level summary of the architectural and product
decisions that govern the TulipFleet Enterprise Dispatcher."
docs/ROADMAP.md:5: "Status as of 2026-10-04 — PROD = MAIN... enterprise-api
→ fleet_tracking (prod), bridge → core prod :3000 tam yol..."
```

Bu, Cebi için **tamamen yanlış/alakasız** bir gerçeklik — Cebi'nin kendi `cebi-backend`/`cebi-db`/in-process bridge'i var (ADR-CE-03). Hiçbir yerde "bu docs/ klasörü enterprise ana projesine ait, Cebi için bağlayıcı değildir" ibaresi yok. `cebi-backend/FORK_BASELINE.md` ve `cebi-dispatcher/FORK_BASELINE.md` doğru otorite olsa da, biri doğrudan `docs/ROADMAP.md`'yi açarsa (veya gelecekte context'siz bir ajan/geliştirici) bunu Cebi'nin güncel mimarisi sanabilir — örneğin ADR-CE-03'ün yasakladığı "bridge → core prod" desenini "mevcut mimari" diye okuyabilir.

**Kontrol edildi, aynı sorun YOK:** `cebi-backend/docs/` (sadece ADR-CE-01..04 + Cebi'ye özgü tracking-portal raporları var, enterprise ADR-0001..0014 yok) ve `cebi-mobile/docs/` (sadece kendi FEAT/i18n raporları var) — bu iki repo fork anında temiz devralmış. Boşluk **sadece `cebi-dispatcher`'da**.

### Öneri (uygulama adımı, aşağıda plana da eklendi)

`cebi-dispatcher/docs/` köküne tek bir dosya: `docs/_ENTERPRISE_INHERITANCE_NOTICE.md` (veya `ROADMAP.md`/`adr/`'nin en üstüne tek satır ekleme) — zaten var olan "bağlayıcılık ibaresi" kalıbını (`ROADMAP_ARCHIVE.md`'deki gibi) tekrar kullanarak: *"Bu klasördeki dosyalar (ROADMAP.md, adr/ADR-0001-0014, functions/, strategy/) `tulipfleet-dispatcher`'dan FORK ANINDA (2026-10-18) devralındı ve ana (enterprise) projenin kendi gerçekliğini anlatır — Cebi için bağlayıcı DEĞİLDİR. Cebi'nin otoritesi: `cebi-dispatcher/FORK_BASELINE.md` + `cebi-backend/docs/adr/ADR-CE-*`."* Taşıma/silme gerekmiyor (bilgi kaybı riski + gereksiz iş) — sadece otorite işareti.

---

## 2. MARKALAMA VE FİZİKSEL İZOLASYON DENGESİ (White-label & Dedicated DB)

### Dedicated DB — TAMAMLANDI, kanıtlı

`cebi-db`: ayrı Docker container, ayrı `cebi-net` network, ayrı volume, ana projenin `fleet_tracking` veritabanıyla **sıfır şema/tablo paylaşımı**. Veri kaybı olayının kurtarma turunda (`SESSION_NOTE.md` "OLAY") bu izolasyon tekrar fiilen kanıtlandı: kurtarma tamamen `cebi-db`'nin kendi dump'ından yapıldı, ana projeye hiç dokunulmadı.

### White-label (markalama) — TAMAMLANDI, kanıtlı

`routes/companyBranding.js` + `routes/companyBrandingHelpers.js`: `GET`/`PUT /api/company/branding` — her şirket kendi logo+rengini `companies` tablosunda tutuyor, `company_id` scope'lu. Bu, "fiziksel izolasyon" (ayrı DB) ile "markalama" (uygulama-seviyesi, tek şema içinde tenant-scoped config) arasındaki dengeyi zaten gösteriyor: **DB izolasyonu müşteri/tenant seviyesinde** (her Cebi müşterisi kendi `cebi-db`'sini alabilir — şu an tek müşteri var), **markalama ise uygulama-seviyesinde tenant-scoped bir alan** (aynı DB içinde birden çok şirket olsa da ayrı görünür). İkisi çakışmıyor, birbirini tamamlıyor.

**Açık soru (dürüstçe işaretli):** Şu an tek bir Cebi müşterisi var; "yeni bir müşteri firmaya özel konumlandırma" çoğullaştığında (2. müşteri geldiğinde) her müşteri için ayrı bir `cebi-db-<müşteri>` + `cebi-backend-<müşteri>` instance'ı mı açılacak (ADR-CE-03'ün "tek sunucuda taşınabilirlik" ilkesiyle uyumlu, her müşteri kendi sunucusuna taşınabilir), yoksa tek `cebi-backend` + `company_id`'ye göre çoklu-tenant mı kullanılacak (mevcut `public.companies`/`company_id` deseni zaten çoklu-tenant'a hazır)? **Bu, bugün karar verilmesi gerekmeyen, ama 2. müşteri geldiğinde netleşmesi gereken bir noktadır** — şimdilik kod her iki yolu da kapatmıyor.

---

## 3. KATMANLI MODÜLER MONOLİT VE DURUM MAKİNESİ TASARIMI

### Modül sınırları — TAMAMLANDI, kanıtlı

- **Kod seviyesi:** her bounded context kendi `routes/*.js` dosyasında (`weighbridge.js`, `mobileTelemetry.js`, `dispatcherTasks.js`, `internalBridge.js`, `geofences.js`...), kendi `services/*` yardımcılarıyla.
- **DB seviyesi (daha sıkı sınır):** dispatcher/VRP domaini `public` şemasından fiziksel olarak ayrı `enterprise` şemasında (`migrations/1778687553584_enterprise-schema-init.sql`). Bu, sadece kod disiplini değil, **PostgreSQL seviyesinde zorlanan** bir modül sınırı.
- **Ana projeye gizli runtime bağımlılığı tespiti/koparılması:** ADR-CE-03'ün ta kendisi bu disiplin — somut örnek: bugün `internalBridge.js`'teki eski `axios` + `INTERNAL_CORE_API_URL` self-call deseni (ana projenin "iki süreç" mimarisinden kalma bir alışkanlık) `createBridgedTask()` olarak in-process çağrıya çevrildi; aynı disiplinle `cebi-dispatcher`'ın Cloudflare Pages'e değil kendi Caddy'sine bağlanması kararlaştırıldı.

### Durum makinesi — TAMAMLANDI, kanıtlı

- Sefer: `Assigned→Loading→Weighed→Unloading→Completed` zinciri Weighbridge bounded context + `/complete` completion gate'te (tartımsız sefer tamamlanamıyor — ADR-CE-04).
- Dispatcher'ın kendi durum makineleri DB CHECK constraint'leriyle zorlanıyor: `dispatch_tasks.status ∈ {draft,planned,assigned,in_progress,completed,failed,cancelled}`, `routing_jobs.status ∈ {submitted,running,completed,failed}` — "defense in depth" (uygulama hatası bile yanlış durumu DB'ye yazamaz).
- İstisnai durumlar (iptal, yanlış plaka, eksik tartım): `exception_events` + append-only audit zinciriyle, `supersedes_id` ile düzeltme (silme yok) deseni.

### GPS olayı vs. iş olayı ayrımı — TAMAMLANDI, kanıtlı (farklı bir mekanizmayla)

Checklist'in sorduğu *"VehicleEnteredLoadingZone (GPS) ile LoadingStarted (iş olayı) nasıl ayrışıyor"* sorusunun cevabı: **bunlar zaten hiç karışmıyor, çünkü GPS/geofence olayları hiçbir zaman otomatik olarak iş durumu yazmıyor.**
- `services/waypointGeofenceHelpers.js`'teki `applyGeofenceVisit()` SADECE bir task'ın `waypoints` JSON alanındaki "ziyaret edildi" işaretini/zaman damgasını günceller — `tasks.status` veya herhangi bir iş-durumu alanına **hiç dokunmuyor** (kod okunarak doğrulandı).
- İş durumu geçişleri (örn. sefer `in_progress`→`completed`, tartım kaydı eklenmesi) her zaman **ayrı, açık bir API çağrısıyla** (sürücü uygulaması veya dispatcher eylemi) tetikleniyor — geofence tetiklemesinden otomatik türetilmiyor.
- Bu disiplin 11 Ekim 2026'da aktif olarak güçlendirildi: bozuk/işlevsiz legacy `checkGeofences()` (var olmayan DB kolonlarını okuyup sessizce başarısız oluyordu, 7 gün 0 satır üretmişti) tamamen kaldırıldı, tek yetkili mercii `services/geofenceService.js` (v2-contract: **cihaz-taraflı tespit + sunucu-taraflı doğrulama/dedup**) oldu — kanıt: `tests/geofenceLegacyRemoval.test.js`.

### Yönetici Briefing / CQRS — KISMİ, dürüstçe işaretli

Checklist'in sorduğu "Read Model/CQRS" sorusunun gerçek cevabı: **formal bir CQRS read-model projeksiyon katmanı YOK.** `routes/reports.js`'teki `GET /api/reports/operations` (Operations Report / fiili "Yönetici Briefing" ekranı), modüllerin kendi tablolarına (`tasks`, `vehicles`...) `company_id` scope'lu, doğrudan salt-okunur SQL agregasyonuyla erişiyor — ayrı bir projeksiyon tablosu/event bus yok. Bu bir **anti-pattern değil** (yazma yönünde modül sınırları hâlâ korunuyor, bu sadece okuma-taraflı bir rapor sorgusu) ama "CQRS" terimi tam karşılanmıyor — tek-süreçli monolitte şimdilik gereksiz karmaşıklık olurdu. **Açık madde olarak not edildi, bugün aksiyon gerektirmiyor.**

---

## 4. KONTROLLÜ FORK VE TAŞINABİLİRLİK DOĞRULAMA KRİTERLERİ

### Kontrollü Fork (Seçenek A) — TAMAMLANDI, kanıtlı

Üç repo da fork anında "doğum sertifikası" (`FORK_BASELINE.md`) ile sabitlendi — kaynak repo, baseline commit SHA, fork senaryosu, drift kontrolü (`git fetch`+`git ls-remote` ile doğrulama) hepsi kayıtlı. `tulipfleet-enterprise-backend` salt-okunur referans olarak ayrı tutuluyor (hiç yazılmıyor, sadece port kaynağı). Bu, zaten yürürlükte olan, tekrar seçilecek bir strateji değil.

### Dış servis bağımlılıkları ve izolasyonu — TAMAMLANDI, kanıtlı

`cebi.env.example`'da listelendiği gibi: `HERE_API_KEY` (routing, + bugün eklenen `VRP_PROVIDER`), `SMTP` (`info@tulipfleet.com`/Zoho — ayrı hesap), `OPENWEATHER_API_KEY` — hepsi **ana projenin hesaplarından ayrı, yeni tedarik edilmiş** hesaplar (`FORK_BASELINE.md`'de doğrulanmış). MQTT broker kurulumu hâlâ açık (ESP32 entegrasyonu için gerekli, henüz kurulmadı) — tek gerçek bekleyen dış-servis maddesi.

### Taşınabilirlik doğrulama kriterleri (Definition of Done) — KISMEN TANIMLI, somut tamamlama önerisiyle

ADR-CE-03 zaten "tam izolasyon" ilkesini tanımlıyor ama **"sıfırdan sunucuda ayağa kalkış" için adım-adım bir doğrulama checklist'i** ayrı bir belge olarak yazılı değil — bu gerçek bir boşluk. Mevcut kanıtlardan (bu oturumda fiilen yapılanlardan) türetilen somut DoD seti:

1. **Kod bağımsızlığı:** `grep -rn "fleet_tracking\|enterprise-api.tulipfleet\|api.tulipfleet.com" <repo>` üç Cebi reposunda da (haklı/kasıtlı referanslar — örn. SESSION_NOTE'daki tarihsel notlar — hariç) sıfır sonuç vermeli. (Bugüne kadar hiç resmi olarak çalıştırılmadı — ÖNERİ: bir sonraki oturumda çalıştırılsın.)
2. **DB bağımsızlığı:** `cebi-db`, ana projenin Postgres örneğine hiçbir `FOREIGN DATA WRAPPER`/`dblink`/cross-database query içermemeli — migration dosyalarında doğrulandı (`enterprise.*` tabloları sadece `public.*`'a, `public.*` sadece kendi içine referans veriyor, hepsi `cebi-db` içinde).
3. **Runtime bağımsızlığı:** `docker compose -f docker-compose.cebi.yml` + `docker-compose.cebi-dispatcher.yml`, ana projenin container'ları/network'ü HİÇ ayakta olmadan, temiz bir sunucuda (`fleet-enterprise-01` bunun fiili kanıtı — ayrı sunucu, ayrı network) ayağa kalkıp e2e testlerini (5 script: Weighbridge/Mobil Telemetri/Dispatcher Faz A/Faz A-2/CORS-JWT) geçmeli. **Bu test, bu oturuma kadar yapılan her feature'da fiilen tekrarlandı** — formel bir "DoD" belgesi olarak yazılı değildi, sadece fiili pratikti.
4. **Dış servis bağımsızlığı:** `cebi.env.example`'daki her değişkenin (HERE/SMTP/OpenWeather) ana projenin `.env`'indeki değerlerden farklı/ayrı olduğu diff ile kanıtlanmalı (kısmen yapıldı, `FORK_BASELINE.md`'de kayıtlı).

**ÖNERİ:** Bu 4 kriter, `ADR-CE-03`'e §3 "Doğrulama Kriterleri (Definition of Done)" olarak eklenebilir — yeni bir karar değil, zaten fiilen uygulanan pratiğin formelleştirilmesi.

---

## Uygulama Adım Planı (öncelik sırasıyla)

| # | Adım | Neden | Maliyet |
|---|---|---|---|
| 1 | `cebi-dispatcher/docs/` köküne bağlayıcılık-olmayan ibaresi ekle (Bölüm 1) | Tek gerçek, somut bulunan boşluk — yanlış okunma riski gerçek | Düşük, tek dosya/satır |
| 2 | ADR-CE-03'e §3 "Doğrulama Kriterleri (DoD)" ekle (Bölüm 4) | Zaten fiilen yapılan pratiği yazılı hale getirir, gelecekte tekrar üretilebilir kılar | Düşük, ADR güncelleme |
| 3 | Madde 1'deki `grep` bağımsızlık taraması üç repoda çalıştırılsın | Hiç resmi olarak yapılmadı, ucuz ve hızlı bir doğrulama | Çok düşük |
| 4 | 2. müşteri senaryosu netleşene kadar Bölüm 2'deki "tek-tenant mı çoklu-tenant mı" sorusu açık bırakılsın, bugün karar verilmesin | Erken karar, bugünkü tek-müşteri durumunda gereksiz kısıtlama getirir | — |
| 5 | Bölüm 3'teki CQRS/Read-Model boşluğu not edilsin, aksiyon alınmasın | Tek-süreçli monolitte bugün gereksiz karmaşıklık; ölçek büyüyünce tekrar değerlendirilir | — |

Faz A-2 (VRP) zaten tamamlanmış ve canlıda doğrulanmıştı (bugün, önceki not) — bu rapor onu değiştirmiyor, sadece bütünsel mimari tabloya yerleştiriyor.
