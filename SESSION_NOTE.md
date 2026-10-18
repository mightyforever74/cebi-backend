# SESSION_NOTE.md — TulipFleet Customer Edition

Çalışma hafızası / oturum günlüğü. `WORKING_RULES.md`'deki "ispat et" disiplinine uygun: her bulgu dosya yolu ile doğrulanmıştır. Bu dosya kronolojik olarak büyür, en yeni not en üstte.

---

## 2026-10-18 (gece, devam) — İlk seed veri + gerçek login uçtan uca doğrulandı

**Yapılan:** `companies` tablosuna bir test şirketi (`Cebi Test A.Ş.`, slug `cebi-test`), `users` tablosuna buna bağlı bir `company_admin` kullanıcısı (`admin@cebi-test.local`) eklendi. Şifre hash'i backend container'ının kendi `bcryptjs`'iyle (cost 10) üretildi — login kodunun (`server.js:594`) kullandığı algoritmayla garanti uyumlu olması için. Şifre değeri hiçbir adımda ekrana/sohbete basılmadı (Sır Hijyeni).

**Bulgu/çözülen hata — FK kontrolü, oturum rolünü değil kısıtı tanımlayan tablonun sahibini kullanıyor:** `INSERT INTO users (...)` komutu `ERROR: permission denied for schema public` ile başarısız oldu — hata `companies` tablosuna karşı dahili bir FK bütünlük kontrolü sorgusunda (`SELECT 1 FROM ONLY public.companies ... FOR KEY SHARE`) çıktı. `cebi_admin` superuser olduğu halde (`pg_roles.rolsuper = t`, doğrulandı) bu hatayı aldı — sebebi, PostgreSQL'in FK bütünlük kontrol trigger'larını **bağlanan oturumun rolüyle değil, kısıtı tanımlayan (referencing) tablonun sahibinin yetkileriyle** çalıştırması (bilinçli bir Postgres güvenlik davranışı — FK ihlallerinin, erişimi olmayan bir kullanıcıya başka bir tablonun veri varlığını sızdırmasını önlemek için). `companies`/`users` tablolarının sahibi `fleetadmin` (dump'tan gelen placeholder rol) — ve `fleetadmin`'in `public` şeması üzerinde `USAGE` yetkisi yoktu. **Düzeltme:** `GRANT USAGE ON SCHEMA public TO fleetadmin; GRANT USAGE ON SCHEMA enterprise TO fleetadmin;` — sonra INSERT sorunsuz çalıştı.

**Sonuç — tam uçtan uca doğrulandı:** `POST /api/auth/login` gerçek kimlik bilgisiyle denendi → geçerli bir JWT token + şirket bilgisi gömülü kullanıcı objesi döndü (200 OK). Altyapı + şema + backend + gerçek kullanıcı zinciri eksiksiz çalışıyor.

**Sıradaki adım (henüz yapılmadı):** Dış servis anahtarları (HERE, OSRM/CARTO, SMTP, Google Maps, OpenWeather) hâlâ tedarik edilmedi; Weighbridge bounded context henüz tasarlanmadı/kodlanmadı.

---

## 2026-10-18 (gece) — Faz 4: şema import tamamlandı, `cebi-backend` gerçek şemaya karşı doğrulandı

**Önceki girdinin "sıradaki adım"ı tamamlandı: DB şeması artık tam.** Domain kararı netleşti: `cebi-api.tulipfleet.com` (Caddyfile'a site bloğu eklendi, Cloudflare Origin Certificate, `/etc/caddy/origin/cebi-api.{crt,key}` — enterprise-api deseniyle aynı). `curl -i https://cebi-api.tulipfleet.com/health` önce `502` (backend henüz yoktu, `server: cloudflare` header'ıyla Cloudflare üzerinden geçtiği doğrulandı), backend ayağa kalkınca `127.0.0.1:3100` üzerinden `200` doğrulandı.

**Bulgu — `migrations/` klasörü (38 dosya) tek başına yetersiz:** Hiçbir migration dosyası core tabloları (`vehicles`, `companies`, `users` vb.) `CREATE TABLE` etmiyor — gerçek bir base şema hiç git'e girmemiş. Ayrıca `public.*`/`enterprise.*` şemaları migration geçmişi boyunca FK ile derinlemesine iç içe geçmiş (10+ dosyada `public`'ten `enterprise`'a FK referansı) — "sadece public'i al, enterprise'ı atla" ayrımı migration dosyalarıyla pratik değil. 3 dosya da hiç oluşturulmamış bir `pgmigrations` tablosuna INSERT yapıyor.

**Karar (Cem onayı: "kabul önerini a yı uygula lütfen"):** Migration dosyalarını düzenlemek yerine (fork baseline'ı asla değiştirilmez prensibi), gerçek prod şemasının `pg_dump --schema-only` dump'ı alındı ve olduğu gibi (enterprise dahil) import edildi. GRANT ifadelerinin başarılı olması için placeholder NOLOGIN roller oluşturuldu (`fleetadmin`, `enterprise_backend`) — zararsız, çünkü `cebi_admin` zaten Postgres superuser, ownership kısıtlamalarını zaten bypass ediyor.

**Transfer yolu:** `fleet-enterprise-01`'den `fleet-prod-01`'e doğrudan SSH yok (`INTEGRATION_BOUNDARIES.md §7.1` — kasıtlı, yeni trust kurulmadı). Dump, Cem'in kendi laptop'u üzerinden iki adımlı `scp` ile taşındı.

**Çözülen hatalar (sırayla):**
1. `schema "public" already exists` — dump'ın kendi `CREATE SCHEMA public;` satırı (`sed -i '<satır>d'` ile silindi, sadece `public` satırı, `enterprise` satırı korundu).
2. `role "fleetadmin" does not exist` — placeholder NOLOGIN rol oluşturuldu.
3. `data type uuid has no default operator class for access method "gist"` (`idx_tasks_time_overlap` composite GIST index) — `CREATE EXTENSION btree_gist;`.
4. `schema "_timescaledb_internal" does not exist` — `CREATE EXTENSION timescaledb;` (image kütüphaneyi sağlıyor ama extension objesini otomatik oluşturmuyor).
5. `relation "enterprise.dispatch_tasks" does not exist` (sadece `--schema=public` dump'ında) — canlı prod şemasında bile `public`→`enterprise` FK bağımlılığı olduğu kanıtlandı → **plan değişti:** tek dump, `--schema=public --schema=enterprise`, migration replay'e hiç gerek yok.
6. **Kritik öğrenim — psql `-c "stmt1; stmt2; stmt3"` örtük transaction'dır:** Birden fazla DDL'i aynı `-c` string'inde birleştirmek, son ifade hata verirse öncekileri de (psql ilerleyen başarı etiketlerini bastırmış olsa bile) geri alıyor. `enterprise` şemasının "zaten var" göründüğü ama aslında rollback olduğu bir vakayla keşfedildi (`pg_namespace` sorgusuyla doğrulandı). **Düzeltme:** bundan sonra her DDL ayrı `docker exec` çağrısı (ayrı bağlantı/session) olarak çalıştırıldı.
7. `type "public.geometry" does not exist` — seçilen image (`timescale/timescaledb:2.17.0-pg16`) PostGIS içermiyor. `INTEGRATION_BOUNDARIES.md §3.1`'in zaten belgelediği gerçek prod image'ı ("TimescaleDB HA with PostGIS") hatırlandı → `docker-compose.cebi.yml`'de `cebi-db` image'ı `timescale/timescaledb-ha:pg16`'ya geçirildi (commit `f704029`), `git pull` + `down -v` + yeniden `up` ile düzeltildi.
8. **Kendi hatam, aynı mesajda fark edilip düzeltildi:** `DROP SCHEMA public CASCADE` sonrası `public`'i boş `CREATE SCHEMA public;` ile geri getirip extension'ları (postgis, btree_gist, timescaledb) yeniden kurmayı unuttum — bir reset turunda tekrar `type "public.geometry" does not exist` hatasına yol açtı. Düzeltme: her schema reset'inden sonra 3 extension da ayrı `docker exec` çağrısıyla yeniden kuruluyor.
9. `function _timescaledb_internal.insert_blocker() does not exist` — `ts_insert_blocker` trigger'ları prod'da `create_hypertable()`'ın otomatik ürettiği artefaktlar; düz `pg_dump --schema-only` trigger'ın varlığını yakalıyor ama alttaki hypertable-dönüşüm katalog kaydını yakalamıyor. Çözüm: `sed -i '/CREATE TRIGGER ts_insert_blocker/d' cebi_full_schema.sql` ile 8 trigger satırı (6 `public`, 2 `enterprise`) silindi, düz tablolar normal import edildi, sonra her biri için `SELECT create_hypertable(...)` ayrı ayrı çağrıldı (trigger'ı doğru şekilde otomatik yeniden oluşturuyor).
10. `cannot create a unique index without the column "time" (used in partitioning)` (`public.locations`) — `locations_pkey` sadece `(id)` üzerindeydi, partition kolonunu içermiyordu (dump'ın yakaladığı haliyle; `exception_events` zaten `(id, occurred_at)` composite'ti, `locations` değildi — sebebi araştırılmadı, muhtemelen prod'da farklı bir unique mekanizması var). Düzeltme: `locations_pkey` düşürülüp `(id, time)` composite olarak yeniden oluşturuldu, sonra `create_hypertable` başarılı.

**Hypertable'lar (8/8, zaman kolonlarıyla):** `public.locations` (`time`), `public.alerts` (`created_at`), `public.driver_behavior` (`created_at`), `public.geofence_violations` (`occurred_at`), `public.maintenance_records` (`created_at`), `public.system_logs` (`created_at`), `enterprise.exception_events` (`occurred_at`), `enterprise.locations_3p` (`time`) — `timescaledb_information.hypertables`'tan doğrulandı.

**Son durum — şema tam:** 39 `public` + 17 `enterprise` tablo, 4 extension (`postgis`, `btree_gist`, `timescaledb`, `plpgsql`), 8 hypertable. `cebi-backend` yeniden başlatıldı (not: container önceki bir `down`'dan beri yokmuş, `up -d` ile yeniden oluşturuldu), `/health` → `200`, `"database":"connected"` (gerçek bağlantı; `"redis":"connected"` hâlâ hardcoded/sahte, önceki not geçerli). **Fonksiyonel doğrulama:** `POST /api/auth/login` yanlış kimlik bilgisiyle denendi → `{"error":"Invalid credentials"}` (401), log: `"Login attempt with non-existent user"` — sorgu `users` tablosuna karşı hatasız çalıştı (kolon/tablo hatası yok), şemanın backend koduyla fonksiyonel uyumu kanıtlandı.

**Sıradaki adım (henüz yapılmadı):** DB tamamen boş — gerçek bir company/admin kullanıcı seed edilmeden API fonksiyonel olarak tam test edilemez (login dışında).

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
