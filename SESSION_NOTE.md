# SESSION_NOTE.md — TulipFleet Customer Edition

Çalışma hafızası / oturum günlüğü. `WORKING_RULES.md`'deki "ispat et" disiplinine uygun: her bulgu dosya yolu ile doğrulanmıştır. Bu dosya kronolojik olarak büyür, en yeni not en üstte.

---

## 2026-10-18 (akşam) — Faz 4: fleet-enterprise-01'de ilk canlı deployment

**Cem'in geri bildirimi (doküman standardı düzeltmesi):** Önceden ayrı yazılmış `DEPLOYMENT_RUNBOOK.md` Cem tarafından reddedildi ("bu doküman nerden çıktı, istemiyorum") — standart sadece SESSION_NOTE.md + FORK_BASELINE.md + ADR. Dosya silindi (commit `1f8674f`), sunucu kararı (`fleet-enterprise-01`) doğrudan `FORK_BASELINE.md`'ye işlendi. Deployment bu oturumda Cem'le birlikte, SSH üzerinden adım adım konuşarak yapıldı — önceden yazılmış bir komut listesi üzerinden değil.

**Önce kod/doküman keşfi (Cem'in uyarısıyla düzeltildi):** SSH ile sunucuyu keşfetmeye başlamadan önce, zaten elimizde olan `tulipfleet-qa`/`tulipfleet-dispatcher` doküman envanterini (`INFRASTRUCTURE.md`, `ENTERPRISE_INFRASTRUCTURE.md`, `INTEGRATION_BOUNDARIES.md`, `DEVICE_LIFECYCLE`, `BACKEND_API_MAP.md`) okumadan `docker ps`/`ss -tlnp` ile sıfırdan keşfetmeye kalkmıştım — gereksiz tur. Cem haklı olarak durdurdu, dokümanlar okundu. Oradan çıkan ve deploy'u doğrudan şekillendiren gerçekler:
- `fleet-enterprise-01`'de hiç PostgreSQL yok (tek instance `fleet-prod-01`'de, `10.0.0.2:5433`) → `cebi-db` için host portu 5433 serbest, çakışma riski yok.
- Reverse proxy burada **Caddy** (nginx değil), Cloudflare Origin Certificate ile TLS termine ediliyor.
- Port binding deseni: mevcut `tulipfleet-enterprise-backend` servisi `127.0.0.1:3001:3001` — sadece loopback'e bind, dışarıya hiç açık değil, erişim tamamen Caddy üzerinden.

**Düzeltme — `docker-compose.cebi.yml` port binding'i (commit `8d4a90e`):** `"5433:5432"` ve `"3100:3000"` satırları host IP belirtmediği için `0.0.0.0`'a bind ediyordu. Enterprise-backend deseniyle tutarlı hale getirildi: `127.0.0.1:5433:5432`, `127.0.0.1:3100:3000`.

**Yapılan (sırayla, canlı doğrulandı):**
1. DNS: `cebi-api.tulipfleet.com` → `A` kaydı → `49.12.246.212`, Cloudflare Proxied (enterprise-api ile aynı desen), Cem tarafından oluşturuldu.
2. Cloudflare Origin Certificate üretildi (`cebi-api.tulipfleet.com`), sunucuda `/etc/caddy/origin/cebi-api.{crt,key}` olarak kaydedildi (`enterprise-api.crt/.key` dosya izni deseniyle aynı: 644/640, root:caddy).
3. `/etc/caddy/Caddyfile`'a yeni site bloğu eklendi (`cebi-api.tulipfleet.com { tls ...; reverse_proxy 127.0.0.1:3100 {...}; encode gzip zstd; header {...} }`), `caddy validate` temiz, `systemctl reload caddy` başarılı.
4. Doğrulama: `curl -i https://cebi-api.tulipfleet.com/health` → **502** (beklenen/doğru — backend henüz yoktu), `server: cloudflare` header'ı ile Cloudflare üzerinden geçtiği kanıtlandı.
5. Repo `/opt/cebi`'ye clone edildi (`/opt/fleet`, `/opt/enterprise` deseniyle tutarlı dizin adı). Baseline SHA (`23bfa4e7...`) doğrulandı.
6. `cebi.env` oluşturuldu, `JWT_SECRET` (`openssl rand -hex 32`) ve `CEBI_DB_PASSWORD` (`openssl rand -hex 24`) üretildi — sadece varlık `grep -c` ile doğrulandı, değerler hiç ekrana/sohbete basılmadı (Sır Hijyeni kuralına uygun).
7. **Tuzak (not edildi):** `docker-compose.cebi.yml`'deki `${CEBI_DB_PASSWORD}` interpolasyonu `env_file:`'dan değil, Compose CLI'nin kendi `.env` aramasından okunuyor — `cebi.env` adını `.env` yapmak yerine `docker compose --env-file cebi.env ...` kullanıldı. İlk deneme boş şifreyle kısmi init oldu, `down -v` ile temizlenip doğru şekilde tekrar başlatıldı.
8. `cebi-db` ayağa kalktı, sağlıklı: `database system is ready to accept connections`, `127.0.0.1:5433`, izole `cebi-net` network.
9. `cebi-backend`'in `HERE_API_KEY` zorunluluğu iddiam (Faz 1 raporunda "yoksa throw, backend başlamaz") **yanlış çıktı** — kodu (`services/routing/factory.js`, `HereRoutingProvider.js:46-52`) okuyunca: throw sadece `computeRoute()` çağrıldığında oluyor, handler bunu yakalayıp `{traffic:null, reason:"NOT_CONFIGURED"}` dönüyor; backend'in kendisi dış servis anahtarları olmadan sorunsuz başlıyor. Koddaki tek iki `process.exit(1)` yeri: eksik `JWT_SECRET` ve bir cron scheduler hatası — ikisi de bu deploy'u etkilemedi.
10. `cebi-backend` build edilip ayağa kalktı, `127.0.0.1:3100`, `/health` → `200`, `{"database":"connected","mqtt":"disconnected"}`. `mqtt: disconnected` beklenen (ADR-CE-02 henüz "inceleniyor", broker yok). SMTP `EAUTH` hatası bekleniyor (dış servis anahtarları henüz yok, §11.4).
11. **Bulgu (kritik değil, not edildi):** `/health` yanıtındaki `"redis":"connected"` **gerçek bir bağlantı değil** — `server.js:563`'te hardcoded sabit metin, hiçbir Redis sorgusu yapılmıyor. İzolasyon ihlali değil (ADR-CE-03'ü etkilemiyor), sadece health endpoint'inin güvenilmez/ölü bir alanı — ileride düzeltilebilir.

**Sonuç — bu oturumun sonunda `fleet-enterprise-01` üzerinde çalışır durumda:** DNS + Caddy/TLS + `cebi-db` (izole) + `cebi-backend` (izole) — hepsi 127.0.0.1-only binding ile, ana projeden hiçbir ortak kaynak kullanmadan.

**Sıradaki adım (henüz yapılmadı):** DB şemasız — `migrations/`'daki ham `.sql` dosyaları `cebi-db`'ye henüz uygulanmadı. Gerçek endpoint'ler (örn. `/api/auth/login`) şu an tablo bulamayıp hata verir.

---

## 2026-10-18 (öğleden sonra) — Faz 4 başlangıcı: bağımsızlaştırma iskeleti

**Altyapı kararı (Cem):** Yeni VPS kiralanmayacak — mevcut Hetzner sunucularından biri (kaynak kullanımı ~%3.4) fiziksel olarak paylaşılacak, ama tam mantıksal izolasyon korunacak: ayrı Docker network (`cebi-net`), ayrı Postgres instance/port (5433), ayrı `cebi.env`. Hedef: ileride dump+taşı ile sıfır kod değişikliğiyle bağımsız bir sunucuya geçilebilsin.

**Yapılan (kod/şablon seviyesinde, 3 repoya da push edildi):**
- `cebi-backend`: `docker-compose.cebi.yml` (izole network+volume+2 servis), `cebi.env.example` (yeni/bağımsız env şablonu — ana projenin hiçbir değeriyle ortak alan yok). `.gitignore`'a `cebi.env` eklendi (gerçek secrets asla commit edilmeyecek).
- `cebi-mobile`: `src/constants/config.js`'deki ana projeye ait sabit fallback'ler kaldırıldı — `PRODUCTION_API_URL` (`api.tulipfleet.com`), `DEV_API_URL`/`WS_URL` (`46.224.1.192`, ana projenin fleet-prod-01 IP'si — Faz 1 keşfinde fark edilmemiş ek bir ADR-CE-03 ihlaliydi, bu turda bulundu ve düzeltildi, `WS_URL` zaten ölü kodtu ama IP'yi barındırıyordu).
- `cebi-dispatcher`: `src/config/api.ts`'deki üç-ayrı-backend varsayımı (`AUTH_API_URL`/`ENTERPRISE_API_URL`/`SUPERVISOR_API_URL`, her biri ana projenin domainlerine fallback yapıyordu) tek bir `CEBI_API_URL`'e konsolide edildi (Faz 3'teki "ayrı enterprise servisi yok" kararıyla tutarlı); fallback'ler tamamen kaldırıldı, env eksikse açık hata loglanıyor.

**Bu session'ın sınırı (ispat et):** Hetzner sunucularına (10.0.0.0/16, SSH) ağ erişimi yok — `46.224.1.192:22` bağlantı denemesi bloklandı. Bu yüzden gerçek sunucu kurulumu (docker compose up, secret üretimi) bu session'dan yapılamadı; deployment Cem'in kendi SSH erişimiyle, birlikte adım adım konuşarak yapılacak (ayrı bir runbook dokümanı yazılmayacak — standart: SESSION_NOTE.md + FORK_BASELINE.md + ADR).

**Sunucu seçimi kararlaştırıldı: `fleet-enterprise-01`.** (Önceden yazılmış `DEPLOYMENT_RUNBOOK.md` Cem'in talebiyle silindi — doküman standardımız dışında bir dosyaydı.)

**Açık kararlar (bkz. `FORK_BASELINE.md`):** domain/subdomain adlandırması (tulipfleet.com alt domaini mi, müşteri-nötr domain mi), DB motoru onayı (TimescaleDB vs. sade PostgreSQL).

---

## 2026-10-18 — Faz 3: Kontrollü Fork gerçekleştirildi

**Yapılan:**
- 3 yeni private repo oluşturuldu (mightyforever74 altında): `cebi-backend`, `cebi-mobile`, `cebi-dispatcher`.
- Her biri, kaynak reponun `origin/main`'inden drift kontrolü yapılarak (fetch + SHA karşılaştırma) birebir forklandı — tam git geçmişi dahil:
  - `cebi-backend` ← `tulipfleet-backend` @ `23bfa4e7252daac0bbc70a546384a8ccf5b275b1`
  - `cebi-mobile` ← `tulipfleet` @ `b51570a8e85ba57ab9425f09c6cf222ed68699fd`
  - `cebi-dispatcher` ← `tulipfleet-dispatcher` @ `723f3a21f74d1935323b2b82ba75b73d379b0b5d`
- Detaylar: her reponun kendi `FORK_BASELINE.md`'sinde.

**Karar — 4. repo (`cebi-enterprise-backend`) açılmadı:** Cem, `tulipfleet-enterprise-backend`'in de aynı şekilde kopyalanmasını önerdi. Buna katılmadım: mevcut sistemde core+enterprise ayrımı tam olarak Modular Monolith kararının çözmeye çalıştığı sorunun kendisi (iki servis, paylaşılan JWT_SECRET, cross-schema JOIN — Faz 1 Risk #2/#3). Tek-tenant bir Customer Edition'da bu ayrımı yeniden kurmanın hiçbir faydası yok, sadece ADR-CE-03'ün "Bağımsız Çalışma Zamanı" ilkesiyle çelişir. Cem onayladı, 4. repo iptal edildi. **Sonuç:** `tulipfleet-enterprise-backend` bir servis olarak forklanmayacak; ilgili iş mantığı (Trip & Dispatch, Operational Reporting modülleri) ileride referans alınarak `cebi-backend`'in modüler monolith'i içine taşınacak.

**Teknik not — push mekaniği:** Bu session'ın git proxy'si shallow (`--depth 1`) push'ları desteklemiyor (`expected 'acknowledgments', received 'packfile'` hatası, remote unpack failed). Çözüm: her kaynak klonu `git fetch source --unshallow` ile tam geçmişe genişletip push'u full history ile yaptım. Üçünde de başarılı; GitHub'ın kendi tarafında da shallow-push kısıtı olabileceği göz önünde bulundurulmalı — ileride bu repolardan yeni bir fork/clone yapılacaksa bu not hatırlanmalı.

**Gözlem (ileride bakılmalı, bloklayıcı değil):** `cebi-mobile` push'unda GitHub şu uyarıyı verdi: `android/kotlin_log.txt` dosyası 95.64 MB — GitHub'ın 50 MB önerisinin üzerinde (100 MB sert limitin altında, push başarılı oldu). Bu, mobile repo'da commit edilmiş bir build/log artefaktı — temizlik için aday (muhtemelen `.gitignore`'a eklenip geçmişten de temizlenmeli, ama bu geçmişi değiştirmek gerektirir — ayrı bir karar).

**Durum:** Faz 2 mimari kararları tamamlandı (9/9 soru cevaplandı). Faz 3'ün ilk adımı (3 repo fork) tamamlandı. Açık kalan ayrıntılar (tartım cihazı bilgisi — §9.2, planlanan-sefer-sayısı kaynağı — ADR-CE-04) bloklayıcı değil.

---

## 2026-10-17 — Faz 1 ve Faz 2 tamamlandı

6 repo keşfi (core backend, enterprise backend, mobile, dispatcher, landing, qa) tamamlandı; bulgular `claude/tulipfleet-customer-edition-faz1-kesif-raporu.md`'de. Faz 2'de Cem'in 9 konsolide soruya verdiği cevaplar aynı dokümana işlendi (§9). Öne çıkan kararlar: sefer-döngüsü bazlı mobil GPS, tartım kaydının zorunlu/değişmez olması (kaçak önleme), haftalık Briefing cadence'i, kapalı-devre kurumsal sistem (public signup yok), `origin/main`'den Senaryo A fork.
