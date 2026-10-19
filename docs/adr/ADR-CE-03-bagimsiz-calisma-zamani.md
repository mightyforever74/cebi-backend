# ADR-CE-03: Bağımsız Çalışma Zamanı

| Alan | Değer |
|---|---|
| **Durum** | Önerildi |
| **Versiyon** | 3 |
| **Tarih** | 2026-10-19 |
| **Karar veren** | Cem Sahinkaya (Kurucu / Tek Geliştirici) |
| **Bileşen** | `cebi-backend`, `cebi-mobile`, `cebi-dispatcher` (tümü) |
| **İlgili** | ADR-CE-01, ADR-CE-02, Faz 1 Risk #2/#3 |

---

## 1. Bağlam

TulipFleet Customer Edition'ın temel hedefi: ana TulipFleet projesinden (`tulipfleet-backend`, `tulipfleet-enterprise-backend`, ortak `fleet_tracking` DB'si, `mqtt.tulipfleet.com` EMQX broker'ı) **çalışma zamanında hiçbir bağımlılığı olmadan**, bağımsız bir sunucuya tam olarak taşınabilir olması.

Faz 1 keşfi mevcut sistemin kenetlenme noktalarını doğruladı:
- Core ve enterprise backend aynı `JWT_SECRET`'ı paylaşıyor.
- Enterprise backend, core'un `public.*` şemasına cross-schema JOIN yapıyor (ayrı DB yok, sadece şema ayrımı).
- Mobil ve dispatcher, `mqtt.tulipfleet.com` EMQX broker'ına WebSocket ile bağlanıyor.

Bu kenetlenme noktalarının hiçbiri Customer Edition'a taşınmamalı.

## 2. Karar

> TulipFleet Customer Edition, ana projenin MQTT broker'ına, veritabanına veya diğer zorunlu çalışma zamanı servislerine bağımlı olmayacaktır. MQTT kullanılacaksa (bkz. ADR-CE-02) broker yeni müşteri ortamında bağımsız olarak kurulup yapılandırılmalı; broker adresi kaynak koda sabitlenmemeli, ortam yapılandırması (env) üzerinden yönetilmelidir.
>
> Yeni bir sunucuya geçişte şu bileşenlerin **tamamı** bağımsız kurulabilmelidir:
> 1. Mobil uygulama yapılandırması (`cebi-mobile`)
> 2. Backend (`cebi-backend`)
> 3. Dedicated DB (Faz 1 §8.6 — tek-tenant, `company_id` filtreleme gereksiz)
> 4. (Varsa) MQTT broker
> 5. Kimlik doğrulama ve yetkilendirme (kendi `JWT_SECRET`'ı, kendi kullanıcı tablosu — ana projenin identity bileşenleri yeniden kullanılmaz, sadece deseni referans alınır)
> 6. Gerekli dış servis yapılandırmaları (HERE, OSRM/CARTO — §9.7, SMTP, push vb.)

MQTT kullanılıyorsa broker'ın bağımsız olması tek başına yeterli değildir: kullanıcı/cihaz kimlik doğrulaması, topic yetkileri, mesaj kalıcılığı, tekrar teslim davranışı ve çevrimdışı kayıtların kaybolmaması da ayrıca doğrulanmalıdır.

**4. repo kararı (ilişkili):** Bu ilke, `tulipfleet-enterprise-backend`'in ayrı bir `cebi-enterprise-backend` servisi olarak fork edilmemesi kararını da destekler (bkz. `FORK_BASELINE.md` ve `SESSION_NOTE.md`, 2026-10-18) — tek-tenant bir sistemde iki servis arası kenetlenme kurmak bu ADR'nin ilkesiyle doğrudan çelişirdi.

**7. Dağıtım platformu (Cem, 2026-10-19 — kapalı karar):** `cebi-dispatcher` paneli, Cloudflare Pages gibi harici bir statik-hosting platformuna DEĞİL, bu ADR'nin tek-sunucuda-tam-izolasyon ilkesine uygun olarak `fleet-enterprise-01`'in KENDİ Caddy'si üzerinden servis edilir — `cebi-backend`/`cebi-db`'nin zaten izlediği desenin aynısı (ayrı Docker network, sadece `127.0.0.1`'e bind, dış erişim host Caddy + Cloudflare Origin Certificate üzerinden; bkz. `cebi-dispatcher/docker-compose.cebi-dispatcher.yml`, `cebi-dispatcher/Dockerfile`). Gerekçe: Cloudflare Pages harici bir platforma çalışma-zamanı/dağıtım bağımlılığı kurar — madde 2'nin "yeni bir sunucuya tam taşınabilirlik" şartını ihlal eder (taşıma anında Pages projesini de yeniden kurmak/DNS'i orada yönetmek gerekirdi). Host Caddy'si zaten sunucunun kendi altyapısı olduğu için bu bağımlılık doğmaz. Domain: `cebi-dispatcher.tulipfleet.com` — **aynı gün canlıda doğrulandı** (DNS+Cloudflare Origin Cert+Caddy site bloğu+Docker, `https://cebi-dispatcher.tulipfleet.com` → `200`; bkz. `cebi-dispatcher/FORK_BASELINE.md`).

## 3. Doğrulama Kriterleri (Definition of Done)

Madde 2'deki "tamamı bağımsız kurulabilmeli" ilkesinin somut doğrulama testleri:

1. **Kod bağımsızlığı:** `grep -rn "fleet_tracking\|enterprise-api.tulipfleet\|api.tulipfleet.com"` üç Cebi reposunda da (tarihsel SESSION_NOTE referansları hariç) sıfır sonuç vermeli.
2. **DB bağımsızlığı:** `cebi-db` migration/dump dosyaları ana projenin Postgres örneğine `dblink`/foreign data wrapper içermemeli; tüm FK'ler `cebi-db` içinde kapanmalı.
3. **Runtime bağımsızlığı:** `docker-compose.cebi.yml` + `docker-compose.cebi-dispatcher.yml`, ana projenin container/network'ü ayakta olmadan temiz bir sunucuda ayağa kalkıp e2e test scriptlerini (Weighbridge, Mobil Telemetri, Dispatcher Faz A/A-2, CORS/JWT) geçmeli.
4. **Dış servis bağımsızlığı:** `cebi.env.example`'daki her değişken, ana projenin `.env`'indeki değerden farklı olmalı (SMTP gönderen adresi hariç, madde 2.6'daki kabul edilen istisna).

## 4. Sonuçlar

### 3.1 Olumlu
- Müşteri sunucu değiştirirse (veya müşteri kendi sunucusunda barındırmak isterse) sıfır ana-proje bağımlılığı.
- Güvenlik izolasyonu: ana projedeki bir ihlal/kesinti Customer Edition'ı etkilemez, ve tersi.

### 3.2 Olumsuz / kabul edilen trade-off'lar
- Hiçbir kod/altyapı paylaşımı yok — bakım iki kat (ama bu, Controlled Fork modelinin zaten kabul edilen maliyeti).
- Ana projedeki ileride yapılacak güvenlik düzeltmeleri (örn. 14.10.2026 MQTT CWE-798 düzeltmesi gibi) otomatik taşınmaz; periyodik "drift review" ile elle değerlendirilmeli.

## 5. Açık Sorular
- Periyodik drift review sıklığı ve süreci henüz tanımlanmadı (Controlled Fork'un "periyodik inceleme" bileşeni).

## 6. Referanslar
- Faz 1 raporu: `claude/tulipfleet-customer-edition-faz1-kesif-raporu.md` §1, §4 (Risk #2/#3), §8.2
- `FORK_BASELINE.md`, `SESSION_NOTE.md` (bu repo)

---

## 7. Değişiklik Günlüğü

| Versiyon | Tarih | Yazan | Değişiklik |
|---|---|---|---|
| 1 | 2026-10-18 | Cem Sahinkaya | İlk metin kaydedildi, "Önerildi". Fork sırasında henüz uygulanmadı (bkz. `FORK_BASELINE.md` bağımsızlık durumu). |
| 2 | 2026-10-19 | Cem Sahinkaya | Madde 7 eklendi, dağıtım platformu kapalı karar: `cebi-dispatcher` Cloudflare Pages değil, `fleet-enterprise-01`'in kendi Caddy'si üzerinden servis edilir. Domain `cebi-dispatcher.tulipfleet.com`; `cebi-dispatcher` repo'suna `Dockerfile`/`docker-compose.cebi-dispatcher.yml` eklendi, henüz sunucuda deploy edilmedi. |
| 3 | 2026-10-19 | Claude | §3 "Doğrulama Kriterleri (DoD)" eklendi, 4 madde bağımsızlık testi. Fiilen uygulanan pratiğin (her feature'da e2e script ile tekrarlanan doğrulama) formelleştirilmesi, yeni karar değil. |
