# ADR-CE-01: Mobil Konum Takibi — Sefer Yaşam Döngüsü Bazlı

| Alan | Değer |
|---|---|
| **Durum** | Onaylandı |
| **Versiyon** | 1 |
| **Tarih** | 2026-10-18 |
| **Karar veren** | Cem Sahinkaya (Kurucu / Tek Geliştirici) |
| **Bileşen** | `cebi-backend` (Location & Geofencing bounded context), `cebi-mobile` |
| **İlgili** | ADR-CE-02 (Mobil Telemetri İletimi), ADR-CE-03 (Bağımsız Çalışma Zamanı) |

---

## 1. Bağlam

Ana TulipFleet ürününde araç konumu yalnızca ESP32 donanım tracker'ından geliyor (Faz 1 keşfi, `tulipfleet/src/services/api.js` ve `expo-location` kullanımı doğrulandı: sadece `DriverSOSScreen.js` ve `DriverSettings.js`'de, sürekli arka plan konum gönderimi yok). Customer Edition'da ise mobil uygulamanın (sürücü + Tartı Memuru) kendisi konum kaynağı olacak — ESP32'nin yerini kısmen alacak.

Seçenekler değerlendirildi:
- **A) Sürekli (7/24) arka plan takibi** — basit ama bataryayı tüketir, gereksiz veri, OS arka plan kısıtlarıyla (iOS/Android) sürtüşmeli.
- **B) Operasyon-aşaması-tetiklemeli takip** — sefer başladığında açılır, sefer boyunca (sadece yükleme/tartım/boşaltma anlarında değil) sürekli örnekleme alır, sefer kapanınca durur.

## 2. Karar

**Seçenek B** benimsendi: konum toplama mantığı **sefer yaşam döngüsünden** yönetilecek.

- Sefer başlamadan önce konum takibi etkin değil.
- Sefer başladığında mobil uygulama konum kaydı almaya başlar (geofence giriş/çıkışını güvenilir tespit edecek sıklıkta — kısa mesafeli seferlerde dahi).
- Sefer sırasında bağlantı kesilirse kayıtlar yerel depoda (local persistent queue) tutulur (bkz. ADR-CE-02).
- Sefer tamamlandığında (bkz. ADR-CE-04) takip durdurulur veya belirlenen kurala göre sonlandırılır.

7/24 sürekli takip bu aşamada **değerlendirmeye alınmadı**; ileride doğrulanmış bir gereksinim olursa ayrı bir ADR ile ele alınabilir.

## 3. Gerekçe

- Bütün gün süren gereksiz konum takibini azaltır (batarya, veri, gizlilik).
- Sefer sınırlarıyla hizalı olduğundan Weighbridge/Trip & Dispatch bounded context'leriyle doğal olarak örtüşür.
- Mevcut ana projede emsali yok (ESP32 modeli farklı); bu nedenle serbestçe tasarlanabildi.

## 4. Sonuçlar

### 4.1 Olumlu
- Enerji/veri tasarrufu.
- Sefer-merkezli domain modeliyle (Trip state machine) birebir uyumlu.

### 4.2 Olumsuz / kabul edilen trade-off'lar
- iOS/Android arka plan konum izinleri ve gerçek cihaz testleri geliştirme öncesi ayrıca doğrulanmalı — Expo'nun mevcut konum altyapısının (SDK 54) arka plan davranışı henüz test edilmedi.
- Uygulama mağazası gereksinimleri (arka plan konum kullanım gerekçesi açıklaması) App Store/Play Store inceleme sürecinde ayrıca ele alınmalı.

## 5. Açık Sorular
- Expo SDK 54'te arka plan konum izinlerinin (iOS "Always" / Android "Allow all the time") gerçek cihazda doğrulanması — henüz yapılmadı.

## 6. Referanslar
- Faz 1 raporu: `claude/tulipfleet-customer-edition-faz1-kesif-raporu.md` §2.3, §8.2, §9.1
- `tulipfleet/src/services/api.js`, `DriverSOSScreen.js`, `DriverSettings.js` (kaynak repo, baseline `b51570a`)

---

## 7. Değişiklik Günlüğü

| Versiyon | Tarih | Yazan | Değişiklik |
|---|---|---|---|
| 1 | 2026-10-18 | Cem Sahinkaya | İlk karar: sefer-döngüsü bazlı mobil GPS takibi onaylandı. |
