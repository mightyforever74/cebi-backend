# ADR-CE-04: Sefer Kapanış Reconciliation'ı

| Alan | Değer |
|---|---|
| **Durum** | Önerildi |
| **Versiyon** | 1 |
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
- **(B) Gün-seviyesi otomatik reconciliation:** bir araç/sürücü için o gün **planlanmış sefer sayısı** (dispatcher tarafından belirlenen, örnek: 2) ile veritabanında o gün **tamamlanmış sefer sayısı** otomatik olarak karşılaştırılır. Sayılar örtüşürse günün kapanışı **sistem tarafından otomatik onaylanır**.

## 3. Gerekçe

- (A) operasyonel bütünlüğü (her seferin gerçekten doğru şekilde tamamlandığını) garanti eder.
- (B) gün sonunda insan hatasını/unutkanlığı (örn. bir seferin sistemde "unutulmuş" açık kalması) otomatik olarak yakalayan bir çapraz kontroldür — tartım zorunluluğunun caydırıcılık amacını (§9.5) güçlendirir: planlanan ile tamamlanan uyuşmuyorsa, bu bir kaçak/atlanan sefer sinyali olabilir.

## 4. Sonuçlar

### 4.1 Olumlu
- Otomatik, insan müdahalesi gerektirmeyen gün sonu kapanışı — operasyonel yük yok.
- Planlanan ≠ tamamlanan durumu, kendiliğinden bir anomali sinyali haline gelir (ileride bir uyarı/istisna mekanizmasına bağlanabilir).

### 4.2 Olumsuz / açık riskler
- **"Planlanan sefer sayısı" verisinin kaynağı henüz tanımlı değil** — dispatcher'ın elle girdiği bir alan mı, yoksa o gün için oluşturulmuş sefer/görev atama kayıtlarının sayısından otomatik türetilen bir değer mi? Bu netleşmeden B kuralı güvenilir çalışmaz.
- Sayılar örtüşmezse (örn. planlanan 2, tamamlanan 1) ne olacağı tanımlı değil — gün "açık" kalır mı, bir uyarı mı tetiklenir, yetkili bilgilendirilir mi? Henüz tasarlanmadı.

## 5. Açık Sorular
- Planlanan sefer sayısının veri kaynağı (manuel alan vs. atama tablosundan türetim).
- Uyuşmazlık (planlanan ≠ tamamlanan) durumunda sistem davranışı.
- Bu reconciliation'ın hangi saatte/nasıl tetikleneceği (gece yarısı cron mu, her sefer tamamlandığında yeniden değerlendirme mi).

## 6. Referanslar
- Faz 1 raporu: `claude/tulipfleet-customer-edition-faz1-kesif-raporu.md` §4 (Risk #11), §8.7, §9.4, §9.5

---

## 7. Değişiklik Günlüğü

| Versiyon | Tarih | Yazan | Değişiklik |
|---|---|---|---|
| 1 | 2026-10-18 | Cem Sahinkaya | İlk karar metni kaydedildi — "Önerildi". Planlanan-sefer-sayısı kaynağı netleşmeden "Onaylandı"ya geçemez. |
