# ADR-CE-02: Mobil Telemetri İletimi — HTTPS vs MQTT

| Alan | Değer |
|---|---|
| **Durum** | Onaylandı |
| **Versiyon** | 3 |
| **Tarih** | 2026-10-19 |
| **Karar veren** | Cem Sahinkaya (Kurucu / Tek Geliştirici) |
| **Bileşen** | `cebi-mobile`, `cebi-backend` (Location & Geofencing) |
| **İlgili** | ADR-CE-01 (Mobil Konum Takibi), ADR-CE-03 (Bağımsız Çalışma Zamanı) |

---

## 1. Bağlam

Mobil repo (`tulipfleet`, baseline `b51570a`) incelendiğinde `mqtt@5.14.1` paketi ve `src/services/mqttService.js` + `src/screens/MQTTTest.js` bulundu. Doğrulama (`ispat et`):
- `mqtt` paketi repoda **yalnızca** `mqttService.js`'de import ediliyor.
- Bu servisi kullanan tek ekran `MQTTTest.js` — **hiçbir navigator'a bağlı değil, ölü kod**.
- 14.10.2026'da bu dosyada bir güvenlik düzeltmesi yapılmış: önceden `.env`'den okunamayan (RN/Expo bundle kısıtı) bir okuma girişimi her zaman sabit kodlanmış bir admin şifresine düşüyormuş (CWE-798, "Admin2024Pass!") — düzeltildi, artık `@env` üzerinden okunuyor, sabit şifre fallback'i yok.
- Bağlantı deseni: EMQX WebSocket (`ws://{MQTT_HOST}:{port||8083}/mqtt`, MQTT 5.0) — dispatcher'ın bağlandığı broker ailesiyle aynı desen.

Üç farklı şeyin birbirinden ayrılması gerekiyor: (1) MQTT istemci kütüphanesinin projede bulunması, (2) MQTT bağlantısının gerçekten kullanılması, (3) MQTT üzerinden veri aktarımının çevrimdışı kayıtları güvenilir biçimde senkronize etmesi. Bunlardan sadece (1) doğrulandı; mevcut kod (2) ve (3) için kullanılamaz durumda (ölü kod + kalıcı kuyruk/dedup mekanizması hiç yok).

## 2. Değerlendirilen Seçenekler

| Seçenek | Avantaj | Dikkat edilmesi gereken |
|---|---|---|
| HTTPS ile toplu senkronizasyon | Daha basit işletim ve hata yönetimi | API, yeniden deneme ve kayıt onayı (ack) tasarlanmalı |
| Bağımsız MQTT broker | Telemetri/mesajlaşma için esnek altyapı | Broker işletimi, kimlik doğrulama, mesaj kalıcılığı yönetilmeli |

## 3. Karar

**HTTPS tabanlı toplu (batch) senkronizasyon** seçildi (MQTT değil). Gerekçe aşağıda değişmedi; bu turda local queue/dedup tasarımı netleşti ve **gerçekten uygulandı** (tasarım belgesi değil, çalışan kod):

**(3.1) Mobil taraf — local persistent queue (`cebi-mobile`):**
- `src/services/telemetryQueue.js`: AsyncStorage tabanlı kalıcı kuyruk (mevcut `src/utils/storage.js` generic `storeData`/`getData` deseniyle). Ağ kopsa veya uygulama kapatılsa bile toplanan ping'ler kaybolmaz; bir sonraki senkronizasyonda tekrar denenir. Sınırsız büyümeyi önlemek için üst sınır (`MAX_QUEUE_SIZE`) var — aşılırsa en eski ping'ler düşürülür (veri kaybı, depolama taşmasına tercih edildi).
- `src/services/telemetrySync.js`: `expo-location`'ın `watchPositionAsync`'i ile konum toplar, her okumayı kuyruğa yazar, periyodik (20s) olarak kuyruğu `POST /api/driver/telemetry/batch`'e toplu gönderir. `startTracking(taskId)`/`stopTracking()` — sefer `in_progress` olduğu sürece açık tutulur (`DriverRouteMapScreen.js`'te hem sefer başlatma hem ekrana geri dönüş/remount senaryosu tek bir effect üzerinden yönetiliyor); `stopTracking()` kuyrukta kalanı best-effort flush eder.
- **Kapsam sınırlaması (v2'de bilinçli); v3'te kaldırıldı, bkz. §3.3.**

**(3.3) Gerçek arka plan takibi (v3, 2026-10-19, §4.2'nin çözümü):**
- `expo-task-manager@~14.0.9` eklendi. `src/services/backgroundLocationTask.js`: `TaskManager.defineTask` ile tanımlanan arka plan görevi, `index.js`'in en başında (component ağacı dışında) side-effect import ile yükleniyor; native tarafın uygulama arka planda/kapalıyken task'ı bulabilmesi için şart.
- `src/services/telemetrySync.js`: `startTracking` artık foreground izninden sonra `Location.requestBackgroundPermissionsAsync()` + `Location.startLocationUpdatesAsync()` da deniyor. **Graceful degradation:** arka plan izni reddedilirse veya API hata verirse, foreground takip ETKİLENMEZ, sessizce foreground-only'ye düşülür (v2 davranışı korunur). `stopTracking` her ikisini de durdurur.
- `src/services/activeTrackingTaskId.js` (yeni): aktif `taskId` kalıcı depoya (AsyncStorage) yazılır; arka plan task callback'i, foreground JS context'inden bağımsız bir context'te çalışabileceği için in-memory state'e güvenilemez.
- `src/services/telemetryFlush.js` (yeni): `flushQueue`, dairesel import'u önlemek için `telemetrySync.js`'ten ayrıştırıldı; hem foreground periyodik gönderim hem arka plan task'ının fırsatçı gönderimi bunu paylaşır.
- **Native build girdisi (prebuild çalışmadığı için elle senkronize edildi):** `cebi-mobile`'ın CI'si `expo prebuild` çalıştırmıyor (bkz. Risk #14 düzeltme notu, aynı desen). `expo-location`'ın config-plugin'i normalde `ACCESS_BACKGROUND_LOCATION`/`FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_LOCATION` izinlerini prebuild sırasında ekler; bu üçü commit'lenmiş `android/app/src/main/AndroidManifest.xml`'e elle eklendi (paket kaynağı indirilip config-plugin kodu okunarak doğrulandı). Android native modül linklemesi (`expo-task-manager`) ise ayrı bir mekanizma: `expoAutolinking.useExpoModules()` (android/settings.gradle) her build'de `node_modules`'u tarayıp otomatik linkliyor, prebuild gerektirmiyor.
- **TEST EDİLMEDİ, açık risk:** bu oturumda gerçek cihaz/simülatör erişimi yok. Kod, Expo'nun dokümante edilen ve kaynağından doğrulanan API'sine göre yazıldı ama gerçek davranış (OEM pil optimizasyonu, Google Play'in `ACCESS_BACKGROUND_LOCATION` policy review'ı; `cebi-mobile` henüz yayınlanmadığı için şimdilik bloklayıcı değil) native rebuild + cihazda doğrulanmalı.

**(3.2) Sunucu tarafı idempotency/dedup (`cebi-backend`):**
- `migrations/1785500000000`: `public.mobile_location_pings` tablosu — `client_ping_id UUID UNIQUE`. Mobil taraf her GPS okumasına kendi ürettiği bir UUID (`clientPingId`) atar; aynı batch retry nedeniyle tekrar gönderilirse `ON CONFLICT (client_ping_id) DO NOTHING` ile sessizce atlanır. Sunucunun ekstra bir "son görülen id" state'i tutmasına gerek kalmaz — istek doğal olarak idempotent.
- `routes/mobileTelemetry.js`: `POST /api/driver/telemetry/batch` — sadece `driver` rolü, sadece kendi task'ı için (sahiplik kontrolü), task durumu kısıtlanmaz (gecikmeli/offline senkron ping'ler de meşru). `{submitted, accepted, duplicates}` döner — mobil taraf, kabul edilen/yinelenen sayısını görüp kuyruktan ilgili ping'leri düşürür.
- `public.locations` (ESP32 cihaz telemetrisi, `device_id` bazlı) ile bilerek **aynı tabloya yazılmadı** — farklı veri kaynağı (telefon GPS'i, `device_id`'siz), ayrı tabloda tutulması ileride ayrıştırmayı kolaylaştırır.

## 4. Sonuçlar

### 4.1 Olumlu
- Daha az altyapı (broker işletimi gerekmez), `cebi-backend`'in zaten sahip olduğu HTTPS/REST altyapısıyla doğal uyum.
- Idempotency, sunucuda ekstra state tutmadan, tek bir UNIQUE constraint ile çözüldü.
- Kalıcı local kuyruk, ağ kopması/uygulama kapanması senaryolarında veri kaybını önler (üst sınıra kadar).

### 4.2 Olumsuz / açık riskler
- **(ÇÖZÜLDÜ, v3, bkz. §3.3) Foreground-only takip:** v2 kapsam sınırıydı, artık gerçek arka plan takibi de var.
- **Test edilmedi:** §3.3'teki arka plan implementasyonu gerçek cihazda doğrulanmadı (bu oturumda cihaz erişimi yok). OEM agresif pil optimizasyonu ve Google Play'in arka plan konum policy review'ı (yayın öncesi) açık risk olarak kalıyor.
- MQTT seçilmedi; ADR-CE-03 (Bağımsız Çalışma Zamanı) ile ilişkisi varsayımsal kaldı — ileride MQTT gerekirse ayrı bir ADR gerekir.

## 5. Açık Sorular
- (Kapandı — bkz. §3.1, §3.2.) Local queue/sync manager ve sunucu tarafı idempotency, bu ADR'nin kapsamındaki açık sorulardı; ikisi de tasarlandı VE kodlandı (bkz. referanslar).
- **Kapsam dışına taşındı (bu ADR'yi bloke etmiyor):** Kritik/acil durumlar (örn. SOS, kaçak tartım şüphesi) için ayrı, daha hızlı bir kanal gerekip gerekmediği — bu, "rutin telemetri için hangi taşıma yöntemi" sorusundan bağımsız bir konu (zaten SOS için `DriverSOSScreen.js` ayrı bir akış kullanıyor). Briefing haftalık cadence kararıyla (ADR'siz, Faz 1 raporu §9.3) ilişkili — ayrı bir değerlendirme konusu olarak kalır.
- **(Kapandı, v3, bkz. §3.3) Gerçek arka plan GPS takibi.** Kalan alt-risk: native rebuild + gerçek cihazda test (Cem tarafından, bu oturumda yapılamaz).

## 6. Referanslar
- Faz 1 raporu: `claude/tulipfleet-customer-edition-faz1-kesif-raporu.md` §2.3, §6.1, §8.1, §8.2
- `tulipfleet/src/services/mqttService.js`, `tulipfleet/src/screens/MQTTTest.js` (kaynak repo, baseline `b51570a`)
- `cebi-backend/migrations/1785500000000_create-mobile-location-pings.sql`, `cebi-backend/routes/mobileTelemetry.js`
- `cebi-mobile/src/services/telemetryQueue.js`, `cebi-mobile/src/services/telemetrySync.js`, `cebi-mobile/src/services/telemetryFlush.js`, `cebi-mobile/src/services/backgroundLocationTask.js`, `cebi-mobile/src/services/activeTrackingTaskId.js`, `cebi-mobile/src/utils/uuid.js`, `cebi-mobile/src/screens/driver/DriverRouteMapScreen.js`, `cebi-mobile/index.js`
- `cebi-backend/scripts/dev/cebi_telemetry_e2e_test.sh` (doğrulama scripti)

---

## 7. Değişiklik Günlüğü

| Versiyon | Tarih | Yazan | Değişiklik |
|---|---|---|---|
| 1 | 2026-10-18 | Cem Sahinkaya | İlk taslak: HTTPS varsayılan seçenek olarak önerildi, kesinleşmedi — "İnceleniyor". |
| 2 | 2026-10-18 | Cem Sahinkaya | Local queue/sync manager (`cebi-mobile`) ve sunucu tarafı idempotency (`client_ping_id` UNIQUE + ON CONFLICT DO NOTHING, `cebi-backend`) tasarlandı VE kodlandı. V1 kapsamı foreground-only takip olarak netleşti (arka plan takibi ayrı iş kalemi). Durum → "Onaylandı". |
| 3 | 2026-10-19 | Claude (oturum) | §4.2 çözüldü: gerçek arka plan GPS takibi eklendi (`expo-task-manager`, `Location.startLocationUpdatesAsync`). Graceful degradation korunur (arka plan izni reddedilirse foreground takip etkilenmez). `AndroidManifest.xml`'e elle izin eklendi (CI prebuild çalıştırmıyor). Test durumu: kod kaynaktan doğrulandı, gerçek cihazda TEST EDİLMEDİ (bu oturumda cihaz erişimi yok). |
