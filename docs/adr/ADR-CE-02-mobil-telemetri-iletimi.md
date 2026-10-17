# ADR-CE-02: Mobil Telemetri İletimi — HTTPS vs MQTT

| Alan | Değer |
|---|---|
| **Durum** | İnceleniyor |
| **Versiyon** | 1 |
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

## 3. Geçici Karar (henüz kesinleşmedi)

İlk sürüm için **varsayılan seçenek: HTTPS tabanlı toplu senkronizasyon**. Gerekçe: daha basit işletim/hata yönetimi, mevcut MQTT kodu yeniden kullanılabilir olsa bile mobil cihazdaki kalıcı GPS kuyruğu ve sunucu tarafında yinelenen mesajı önleme mekanizması zaten ayrıca tasarlanmalı — bu ek tasarım maliyeti MQTT'yi otomatik olarak daha avantajlı yapmıyor.

**Bu karar kesinleşmiş değil** — mevcut MQTT kodu incelendi (yukarıda), ama "zaten var" olması MQTT'yi zorunlu kılmıyor. Local queue/dedup tasarımı netleşmeden "Onaylandı" durumuna geçilmeyecek.

## 4. Sonuçlar (geçici)

### 4.1 Olumlu (HTTPS seçilirse)
- Daha az altyapı (broker işletimi gerekmez).
- `cebi-backend`'in zaten sahip olduğu HTTPS/REST altyapısıyla doğal uyum.

### 4.2 Olumsuz / açık riskler
- Offline-tolerant local queue + sync manager tasarımı henüz yapılmadı.
- Sunucu tarafı idempotency/dedup mekanizması henüz yok.
- MQTT seçilirse: ADR-CE-03 ile birlikte değerlendirilmeli (broker bağımsız kurulmalı, ana projenin broker'ına bağımlı olunamaz).

## 5. Açık Sorular
- Local persistent queue + sync manager tasarımı (cihaz tarafı) — henüz yapılmadı.
- Sunucu tarafı yinelenen kayıt önleme (idempotency key / dedup) — henüz tasarlanmadı.
- Kritik/acil durumlar (örn. SOS, kaçak tartım şüphesi) için ayrı, daha hızlı bir kanal gerekip gerekmediği — Briefing haftalık cadence kararıyla (ADR'siz, Faz 1 raporu §9.3) ilişkili, netleşmedi.

## 6. Referanslar
- Faz 1 raporu: `claude/tulipfleet-customer-edition-faz1-kesif-raporu.md` §2.3, §6.1, §8.1, §8.2
- `tulipfleet/src/services/mqttService.js`, `tulipfleet/src/screens/MQTTTest.js` (kaynak repo, baseline `b51570a`)

---

## 7. Değişiklik Günlüğü

| Versiyon | Tarih | Yazan | Değişiklik |
|---|---|---|---|
| 1 | 2026-10-18 | Cem Sahinkaya | İlk taslak: HTTPS varsayılan seçenek olarak önerildi, kesinleşmedi — "İnceleniyor". |
