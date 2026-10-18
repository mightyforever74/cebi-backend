# ADR-CE-04: Sefer Kapanış Reconciliation'ı

| Alan | Değer |
|---|---|
| **Durum** | Onaylandı |
| **Versiyon** | 3 |
| **Tarih** | 2026-10-18 |
| **Karar veren** | Cem Sahinkaya (Kurucu / Tek Geliştirici) |
| **Bileşen** | `cebi-backend` (Trip & Dispatch bounded context) |
| **İlgili** | ADR-CE-01, Faz 1 raporu §8.7, §9.4, §9.5 |

---

## 1. Bağlam

Sefer tamamlanma koşulu için iki seçenek değerlendiriliyordu:
- **(A) Sefer-seviyesi koşul:** her sefer kendi zorunlu koşullarını sağlamalı (teslim/boşaltma konumuna varış + gerekli kayıtların tam olması — özellikle tartım kaydı, bkz. §9.5: Weighed durumu zorunlu, kaçak/kayıp yüklemeyi önlemek için caydırıcı bir kontrol).
- **(B) Gün-seviyesi koşul:** o gün için planlanan ile tamamlanan arasında bir doğrulama.

Cem'in kararı: **"ikisi de"** — ve B'nin nasıl çalışacağını somutlaştırdı: yetkilinin planladığı sayıda rota (örnek verdiği: genellikle günde 2) tamamlandığının teyidi, otomatik olarak DB'den o günün tamamlanan rota sayısıyla eşleştirilir; sayılar örtüşürse (örn. 2=2) kapanış kabul edilir.

**Önemli netlik:** Bu, bir yetkilinin elle "onayla" tıklaması (manuel approval) değil — **otomatik bir DB reconciliation kuralıdır**.

## 2. Karar

Sefer tamamlanma iki seviyeli doğrulama ile çalışacak:

- **(A) Sefer-seviyesi:** her sefer, "Completed" durumuna geçmeden önce kendi zorunlu koşullarını bağımsız sağlamalı:
  - Teslim/boşaltma konumuna varış (geofence).
  - Gerekli kayıtların tam olması — **tartım kaydı dahil ve zorunlu** (§9.5). Tartım kaydı olmadan sefer "Completed" durumuna geçemez.
- **(B) Gün-seviyesi otomatik reconciliation:** bir araç/sürücü için o gün **planlanmış sefer sayısı** ile veritabanında o gün **tamamlanmış sefer sayısı** otomatik olarak karşılaştırılır. Sayılar örtüşürse (tamamlanan ≥ planlanan) günün kapanışı **sistem tarafından otomatik onaylanır**.

**(B.1) Planlanan sefer sayısının kaynağı — Hibrit model (Cem'in önerisi, 2026-10-18):**
- **Varsayılan:** o gün için ilgili araç/sürücüye atanmış `dispatch_tasks` (veya karşılığı) kayıtlarının sayısından **otomatik türetilir**. Dispatcher'ın ekstra veri girişi yapması gerekmez.
- **Override:** istisnai durumlarda (son dakika eklenen/iptal edilen sefer vb.) bu sayı elle değiştirilebilir. Alan **nullable** tutulur: `NULL` = otomatik türetilen sayı geçerli; dolu değer = override aktif. **Yetki (Cem'in kararı, 2026-10-18):** override yalnızca `company_admin` ve `super_admin` yapabilir — `dispatcher` bu sayıyı değiştiremez. Gerekçe: planlanan sayı aynı zamanda bir kaçak/atlanan sefer sinyali olduğundan (§9.4), operasyonel seviyedeki bir rolün bu kontrolü tek başına esnetebilmesi caydırıcılık amacını zayıflatır.
- **Override audit (bu ADR turunda eklenen netlik):** override işlemi, tartım kaydının değişmezliği kadar katı olmasa da **loglanır** — kim, ne zaman, hangi gerekçeyle değiştirdi. Gerekçe: planlanan sayı aynı zamanda bir kaçak/atlanan sefer sinyali (§9.4 gerekçesi) olarak kullanılacağından, sessizce ezilebilir olması caydırıcılık amacını zayıflatır.

**(B.2) Uyuşmazlık davranışı (bu ADR turunda eklenen netlik):** tamamlanan < planlanan ise gün **otomatik kapanmaz**; mevcut `enterprise.exception_events` hypertable'ına (ayrı bir mekanizma icat edilmeden, Faz 1 keşfinde zaten doğrulanmış tablo) bir istisna kaydı düşülür. tamamlanan ≥ planlanan ise otomatik onay.

**(B.3) Tetikleme (bu ADR turunda eklenen netlik):** iki katmanlı — (i) her sefer "Completed" durumuna geçtiğinde hafif bir yeniden-değerlendirme yapılır (erken otomatik kapanış mümkünse hemen gerçekleşir), (ii) gün sonunda (gece yarısı, yerel saat) bir güvenlik-ağı cron'u aynı kontrolü tekrar çalıştırır — mevcut core backend'deki `setInterval`/cron deseniyle tutarlı (Faz 1 §2.1).

## 3. Gerekçe

- (A) operasyonel bütünlüğü (her seferin gerçekten doğru şekilde tamamlandığını) garanti eder.
- (B) gün sonunda insan hatasını/unutkanlığı (örn. bir seferin sistemde "unutulmuş" açık kalması) otomatik olarak yakalayan bir çapraz kontroldür — tartım zorunluluğunun caydırıcılık amacını (§9.5) güçlendirir: planlanan ile tamamlanan uyuşmuyorsa, bu bir kaçak/atlanan sefer sinyali olabilir.
- (B.1) otomatik türetim insan hatasını sıfırlar, override esnekliği operasyonel gerçekliği (son dakika değişiklikleri) karşılar; audit, override'ın caydırıcılığı atlatmak için kötüye kullanılmasını önler.
- (B.2) yeni bir istisna/uyarı mekanizması icat etmek yerine mevcut `enterprise.exception_events` altyapısının kullanılması, Modular Monolith kararıyla (§8.6) ve "mevcut desenlerle tutarlılık" ilkesiyle (bkz. HERE/SMTP tedarikinde izlenen pattern, FORK_BASELINE.md) örtüşür.

## 4. Sonuçlar

### 4.1 Olumlu
- Otomatik, insan müdahalesi gerektirmeyen gün sonu kapanışı — operasyonel yük yok.
- Planlanan ≠ tamamlanan durumu, mevcut exception-event altyapısı üzerinden kendiliğinden bir anomali sinyaline dönüşür.
- Override audit'i, caydırıcılık amacının override ile sessizce delinmesini engeller.

### 4.2 Olumsuz / açık riskler
- `enterprise.exception_events`'e düşen kayıtların kim tarafından/ne zaman gözden geçirileceği (bir "istisna kuyruğu" ekranı var mı) bu ADR'nin kapsamı dışında — UI/iş akışı tarafı ayrıca ele alınmalı.

## 5. Açık Sorular
- (Kapandı — bkz. B.1, B.2, B.3 ve override yetki kısıtı.) Bu ADR'nin açık sorusu kalmadı. Geri kalan iş (reconciliation cron'unun kodlanması, "planlanan sayı" alanının `dispatch_tasks`'a eklenmesi) ayrı bir implementasyon adımı — henüz yapılmadı, bu ADR sadece tasarımı onaylıyor.

## 6. Referanslar
- Faz 1 raporu: `claude/tulipfleet-customer-edition-faz1-kesif-raporu.md` §4 (Risk #11), §8.7, §9.4, §9.5

---

## 7. Değişiklik Günlüğü

| Versiyon | Tarih | Yazan | Değişiklik |
|---|---|---|---|
| 1 | 2026-10-18 | Cem Sahinkaya | İlk karar metni kaydedildi — "Önerildi". Planlanan-sefer-sayısı kaynağı netleşmeden "Onaylandı"ya geçemez. |
| 2 | 2026-10-18 | Cem Sahinkaya | Planlanan sefer sayısı için Hibrit model (otomatik türetim + audit'li override) onaylandı. Uyuşmazlık davranışı (`enterprise.exception_events`'e düş) ve tetikleme (sefer-tamamlama + gece yarısı cron) netleşti. Durum → "Onaylandı". |
| 3 | 2026-10-18 | Cem Sahinkaya | Override yetkisi `company_admin`/`super_admin` ile sınırlandırıldı (`dispatcher` değiştiremez). ADR'nin son açık sorusu kapandı. |
