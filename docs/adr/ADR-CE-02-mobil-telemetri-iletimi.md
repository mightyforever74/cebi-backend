# ADR-CE-02: Mobil Telemetri İletimi — HTTPS vs MQTT

| Alan | Değer |
|---|---|
| **Durum** | Onaylandı |
| **Versiyon** | 2 |
| **Tarih** | 2026-10-18 |
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
- **Kapsam sınırlaması (bilinçli, bu turda netleşti):** V1 **sadece foreground (ekran açık) takip**tir. Gerçek arka plan takibi (ekran kapalı/uygulama kapatılmış) `expo-task-manager` + arka-plan-konum API'si gerektirir; bu paket `cebi-mobile`'da henüz yok ve eklenmesi native rebuild (EAS build) gerektirir — geliştirme ortamında cihaz/simülatör erişimi olmadan test edilemez. Bu nedenle ADR-CE-01'in "sefer başlar → takip açılır, sefer biter → takip durur" kuralı **ekran açık olduğu sürece** sağlanıyor; arka plan desteği ayrı, takip edilmesi gereken bir sonraki adım (§4.2).

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
- **Foreground-only takip (V1 kapsam sınırı):** uygulama arka plana atılır/kapatılırsa veya ekran kilitlenirse GPS toplama durur. Gerçek arka plan takibi (`expo-task-manager`, native rebuild) ayrı bir iş kalemi olarak takip edilmeli — bu ADR'nin kapsamı dışında, implementasyon notu olarak burada kayıtlı.
- MQTT seçilmedi; ADR-CE-03 (Bağımsız Çalışma Zamanı) ile ilişkisi varsayımsal kaldı — ileride MQTT gerekirse ayrı bir ADR gerekir.

## 5. Açık Sorular
- (Kapandı — bkz. §3.1, §3.2.) Local queue/sync manager ve sunucu tarafı idempotency, bu ADR'nin kapsamındaki açık sorulardı; ikisi de tasarlandı VE kodlandı (bkz. referanslar).
- **Kapsam dışına taşındı (bu ADR'yi bloke etmiyor):** Kritik/acil durumlar (örn. SOS, kaçak tartım şüphesi) için ayrı, daha hızlı bir kanal gerekip gerekmediği — bu, "rutin telemetri için hangi taşıma yöntemi" sorusundan bağımsız bir konu (zaten SOS için `DriverSOSScreen.js` ayrı bir akış kullanıyor). Briefing haftalık cadence kararıyla (ADR'siz, Faz 1 raporu §9.3) ilişkili — ayrı bir değerlendirme konusu olarak kalır.
- **Ayrı takip maddesi:** gerçek arka plan GPS takibi (§4.2) — `expo-task-manager` eklenmesi ve native/EAS rebuild gerektirir.

## 6. Referanslar
- Faz 1 raporu: `claude/tulipfleet-customer-edition-faz1-kesif-raporu.md` §2.3, §6.1, §8.1, §8.2
- `tulipfleet/src/services/mqttService.js`, `tulipfleet/src/screens/MQTTTest.js` (kaynak repo, baseline `b51570a`)
- `cebi-backend/migrations/1785500000000_create-mobile-location-pings.sql`, `cebi-backend/routes/mobileTelemetry.js`
- `cebi-mobile/src/services/telemetryQueue.js`, `cebi-mobile/src/services/telemetrySync.js`, `cebi-mobile/src/utils/uuid.js`, `cebi-mobile/src/screens/driver/DriverRouteMapScreen.js`
- `cebi-backend/scripts/dev/cebi_telemetry_e2e_test.sh` (doğrulama scripti)

---

## 7. Değişiklik Günlüğü

| Versiyon | Tarih | Yazan | Değişiklik |
|---|---|---|---|
| 1 | 2026-10-18 | Cem Sahinkaya | İlk taslak: HTTPS varsayılan seçenek olarak önerildi, kesinleşmedi — "İnceleniyor". |
| 2 | 2026-10-18 | Cem Sahinkaya | Local queue/sync manager (`cebi-mobile`) ve sunucu tarafı idempotency (`client_ping_id` UNIQUE + ON CONFLICT DO NOTHING, `cebi-backend`) tasarlandı VE kodlandı. V1 kapsamı foreground-only takip olarak netleşti (arka plan takibi ayrı iş kalemi). Durum → "Onaylandı". |
