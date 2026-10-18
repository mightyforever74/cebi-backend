# SESSION_NOTE.md — TulipFleet Customer Edition

Çalışma hafızası / oturum günlüğü. `WORKING_RULES.md`'deki "ispat et" disiplinine uygun: her bulgu dosya yolu ile doğrulanmıştır. Bu dosya kronolojik olarak büyür, en yeni not en üstte.

---

## 2026-10-19 (devam 14) — OLAY: cebi-db verisi kayboldu (container recreate, yanlış PGDATA volume yolu) — kök neden düzeltildi, kurtarma bekliyor

**Ne oldu:** Dispatcher Faz A portunu doğrulamak için Cem `cd /opt/cebi && git pull && docker compose -f docker-compose.cebi.yml up -d --build cebi-backend` çalıştırdı. Çıktı `cebi-db`'yi de "Started" gösterdi (sadece `cebi-backend` istenmişti). Hemen sonrası `cebi-db` sürekli crash-loop'a girdi (`Restarting (1)`), log: `"Database is uninitialized and superuser password is not specified"`. `cebi-backend`'in kendi DB bağlantısı `EAI_AGAIN cebi-db` ile düştü (container ayakta değil, DNS çözülemiyor).

**Teşhis (sırayla, canlı sunucuda):**
1. `docker ps -a` → eski `cebi-db` container'ı YOK, sadece 4 dakika önce oluşturulmuş yeni bir ID (`550d3c664181`) var — yani compose container'ı SİLİP YENİDEN oluşturmuş, eski (gerçek veriyi içeren) container kalıcı olarak gitmiş.
2. `docker inspect cebi-db --format='{{json .Config.Env}}'` → `POSTGRES_PASSWORD=` **BOŞ**. `docker-compose.cebi.yml`'deki `cebi-db` servisi `${CEBI_DB_PASSWORD}`'ı `cebi-backend`'in kullandığı `env_file: ./cebi.env` mekanizmasından DEĞİL, docker compose'un KENDİ değişken ikamesinden (bu dosyayla aynı dizinde bir `.env` dosyası ya da shell export gerektirir) okuyor — bu dosya/export yoktu, compose SESSİZCE boş string'e düştü.
3. Bu, `cebi-db`'nin config'inin önceki çalışan haliyle farklı hash'lenmesine ve compose'un onu RECREATE etmesine sebep oldu (sadece `cebi-backend` istenmiş olsa bile — `depends_on` zinciri + config drift algılaması).
4. `docker inspect cebi-db --format='{{json .Mounts}}'` → named volume `cebi_pgdata` `/var/lib/postgresql/data`'ya bağlı. AMA `docker inspect`'in env listesi `PGDATA=/home/postgres/pgdata/data` gösteriyor — **`timescale/timescaledb-ha:pg16` (Zalando Spilo tabanlı) image'inin gerçek veri yolu bambaşka bir yer.** Yani `cebi_pgdata` volume'ü **hiçbir zaman gerçek veriyi tutmamış** — bugüne kadarki tüm kalıcılık, container'ın kendi yazılabilir katmanından geliyordu (sadece `docker restart`'a dayanıklı, `up`/`--build` ile recreate'e karşı değil). Faz 4'ten (18.10.2026) beri container hiç recreate edilmemişti, bu yüzden bulgu şimdiye kadar gizli kaldı.

**Kapsam — kaybolan:** Faz 4'te `pg_dump --schema-only` ile prod'dan import edilen şema (39 public + 17 enterprise tablo) + o andan sonra eklenen TÜM veri: ilk seed (test şirketi + `admin@cebi-test.local`), weighbridge/mobil-telemetri/dispatcher e2e test kullanıcıları ve kayıtları. **Kaybolmayan:** hiçbir gerçek müşteri verisi yok (henüz ödeme yapan müşteri yok) — prod (`fleet-prod-01`, ADR-CE-03 ile tam izole) bu olaydan HİÇ etkilenmedi, şema her zaman yeniden `pg_dump` edilebilir.

**Kök neden düzeltmesi (commit `2c09a4b`), ikisi birden:**
1. `docker-compose.cebi.yml`: volume artık `/home/postgres/pgdata`'ya bağlanıyor (doğru PGDATA yolu).
2. Her iki dosyaya (`docker-compose.cebi.yml`, `cebi.env.example`) uyarı yorumu eklendi: `/opt/cebi/.env` (compose'un kendi, `cebi.env`'den AYRI dosyası) oluşturulup `CEBI_DB_PASSWORD`/`CEBI_DB_USER`/`CEBI_DB_NAME`/`CEBI_BACKEND_PORT` ile doldurulmalı — yoksa bu sınıf hata (sessiz boş string) tekrar eder.
3. Yan bulgu, aynı commit'te düzeltildi: `cebi.env.example`'daki "`INTERNAL_BRIDGE_TOKEN` gerek yok" yorumu YANLIŞTI — `routes/internalBridge.js` zaten register edilmiş ve fail-closed bu değişkeni bekliyor.

**Kurtarma — SIRADAKİ ADIM (henüz yapılmadı):**
1. `/opt/cebi/.env` oluştur (yeni `CEBI_DB_PASSWORD` üret, `cebi.env`'deki değeri de aynı değerle güncelle — eski değer artık anlamsız, zaten fresh init olacak).
2. `docker compose -f docker-compose.cebi.yml up -d` (bu kez TÜM stack, sadece `cebi-backend` değil) — `cebi-db` bu sefer doğru yolda ve dolu şifreyle initdb yapacak.
3. Faz 4'teki şema import prosedürünü TEKRARLA (bu dosyanın "Faz 4: şema import tamamlandı" notu, `ts_insert_blocker` sed-fix + `create_hypertable()` adımları dahil) — prod'dan yeni bir `pg_dump --schema-only` ile.
4. İlk seed veri (test şirketi + admin) yeniden oluştur.
5. TÜM e2e scriptleri yeniden çalıştır (`cebi_e2e_test.sh`, `cebi_telemetry_e2e_test.sh`, `cebi_dispatcher_faza_e2e_test.sh`) — Dispatcher Faz A'nın kodu doğru ama HİÇ canlıda doğrulanamadı (DB olayı araya girdi), bu yüzden hâlâ "doğrulanmadı" statüsünde.
6. `cebi_health_check.sh`'ı tekrar çalıştır, sistemin tam sağlıklı olduğunu teyit et.

---

## 2026-10-19 (devam 13) — Dispatcher entegrasyonu: Faz A (Çekirdek Operasyon) portu başladı

**Önceki tur kapanışı (not edilmemişti):** `FORK_BASELINE.md`'deki 3 güncel-olmayan madde (eski "MQTT kararı verilmedi" satırı, zaten doğrulanmış bir bölümün başlığının hâlâ "doğrulanmadı" demesi, yeni ops scriptlerinin belgelenmemiş olması) commit `2a909bc` ile düzeltildi.

**"dispatcher entegrasyon mantığı ile devam edelim" talebi üzerine bulgu:** `cebi-dispatcher` (web panel) ile `cebi-backend` arasındaki entegrasyon, beklenenin çok ötesinde bir boşluk içeriyordu. `cebi-dispatcher`'ın çağırdığı ~15 endpoint'ten (`src/hooks/*`, `src/config/api.ts` üzerinden) sadece auth/alerts/user-profile/superadmin tarafı `cebi-backend`'de mevcuttu — `/api/dispatcher/*`, `/dispatcher/tasks/optimize*`, `/api/compliance/assess`, `/api/subscription/*`, `/dispatcher/geocode/discover` **hiç yoktu**. Bu mantık sadece forklanmamış referans repo `tulipfleet-enterprise-backend`'de (ayrı bir Fastify süreci, eski multi-tenant mimari) yaşıyordu — `FORK_BASELINE.md`'nin kendi not #16'sının öngördüğü ama henüz başlanmamış iş.

Cem'e soruldu, **"Faz A önce: Çekirdek operasyon"** seçildi (tasks/drivers/vehicles/locations/latest — günlük kullanım ekranları).

**Kapsam kararı (kodlamaya başlamadan önce, kendiliğinden tespit edildi):** `tulipfleet-enterprise-backend/routes/tasks.js` (703 satır) basit bir liste endpoint'i değil — TÜM VRP (Vehicle Routing Problem) optimizasyon zinciri (`POST .../optimize`, `GET .../optimize/poll/:id`, `POST .../optimize/approve`) + eski HTTP "ince köprü" push'u (`axios` → `routes/internalBridge.js`, `INTERNAL_CORE_API_URL`/`INTERNAL_BRIDGE_TOKEN`) içeriyordu. Bu zincir **bu pasa dahil edilmedi** — gerekçe: (a) kaynağın VRP soyutlaması (`lib/routing/factory.js`) cebi-backend'de yok (cebi-backend'in KENDİ `services/routing/factory.js`'i farklı bir şey yapar — VRP değil, tekil rota/trafik), (b) köprü push'unun tek-süreçli mimariye uyarlanması (HTTP self-call mı, yoksa `internalBridge.js`'in kod değişikliği mi — henüz karar verilmedi) kendi başına ayrı bir inceleme+test döngüsü gerektiriyor. Şema tarafı zaten HAZIR (`enterprise.routing_jobs`/`enterprise.dispatch_tasks` — migration `1778687553584_enterprise-schema-init.sql`'de zaten var, `internalBridge.js` zaten canlı/register edilmiş). Takip işi olarak not edildi: **"Faz A-2: VRP Optimizasyon Portu"**.

**Bu pasta yapılan (commit `89af043`):**
- `server.js`: `fastify.requireRole(...roles)` decorator eklendi (401/403) — `cebi-backend`'de hiç yoktu, sadece `fastify.authenticate` vardı.
- `routes/dispatcherDrivers.js`, `dispatcherVehicles.js`, `dispatcherTasks.js` (sadece `GET /api/dispatcher/tasks` listesi), `dispatcherLocations.js` (`locations/latest` + `routes/active`) — hepsi `tulipfleet-enterprise-backend`'den BİREBİR port, `requireRole("company_admin","super_admin")` korumalı (dispatcher rolü KASITLI dışarıda — kaynağın TÜM route'larında aynı örüntü, grep ile doğrulandı).
- `routes/active`'teki HERE rota geometrisi için kaynağın axios+özel-polyline-decoder'ı KOPYALANMADI; cebi-backend'de zaten üretimde olan `services/routing/factory.js` + `HereRoutingProvider.computeRoute()` (native `fetch`, zaten test edilmiş) reuse edildi.
- **Porttan önce yakalanan gerçek şema farkı:** kaynak `locations.js` `l.timestamp` kullanıyordu; cebi-backend'in GERÇEK `public.locations` tablosunda kolon adı `time` (kanıt: `server.js`'in `saveLocationData()` INSERT'i + `routes/vehicleTrackHelpers.js`'in zaten çalışan sorgusu, aynı repo). Düzeltilerek portlandı — canlıda 500 ile karşılaşmadan önce yakalandı.
- `scripts/dev/cebi_dispatcher_faza_e2e_test.sh` yazıldı (aynı desen: idempotent temizlik `CEBI-TEST-003` kapsamlı, 6 test — rol gate 403, 5 endpoint için 200 + test verisinin yanıtta göründüğü doğrulaması).

**Doğrulama durumu:** `node --check` + `bash -n` temiz. **Henüz `fleet-enterprise-01`'de çalıştırılmadı** — git pull + rebuild + test script'in Cem'in erişimiyle çalıştırılması sıradaki adım (weighbridge/mobil telemetri turlarındaki aynı iş birliği deseni). Henüz yapılmadı: `cebi-dispatcher`'ın `REACT_APP_CEBI_API_URL` değerinin gerçek değere set edilmesi (backend hazır olunca ayrı adım).

---

## 2026-10-18 (gece, devam 12) — Sistem sağlığı kontrolü + append-only kuralının ops script'lerini de etkilediği doğrulandı

**`scripts/ops/cebi_health_check.sh` ilk çalıştırma — her şey sağlıklı:** container'lar 0 restart, disk %7, `/health` 200 (local+public), DB 23 MB, tüm migration'lar şemaya yansımış, `mobile_location_pings` doğru şekilde DÜZ tablo (hypertable değil). Log taramasında 2 bulgu — ikisi de yeni sorun DEĞİL: (1) ilk (migration'dan önceki) başarısız telemetri test denemesinden kalan eski log satırları, (2) `[GF] Subscribe failed` — **incelendi, `services/geofenceService.js`'teki ESP32 geofence/konum/telemetri MQTT subscriber'ı** (`fleet/+/+/location` vb. topic'ler) — ADR-CE-02 ile ilgisi yok, canlı/gerekli bir özellik, sadece bu ortama henüz broker kurulmadığı için bağlanamıyor. **Yanlış öneri düzeltildi:** bu reconnect döngüsünü "temizlik" olarak kapatmak önerilmişti, kod incelemesi sonrası bu önerinin hatalı olduğu görülüp geri çekildi — dokunulmadı.

**`scripts/ops/cebi_test_data_cleanup.sh` — append-only kuralı ops script'lerini de etkiliyor (bulgu + düzeltme):** İlk versiyon `CEBI-TEST-001` (weighbridge, kalıcı tartım kaydı var) ve `CEBI-TEST-002` (telemetri, weighbridge'siz) gruplarını TEK `DELETE ... WHERE task_no IN (...)` ifadesinde birleştirmişti. `weighbridge_readings`'in `BEFORE DELETE` tetikleyicisi (Faz 1 §9.5, kasıtlı) DELETE'i reddedince, AYNI statement'taki `CEBI-TEST-002`'nin silinmesi de atomik olarak başarısız oldu (ikisi de FK zincirleriyle etkilendi). **Bu bir bug değil — append-only kuralının tam istendiği gibi çalıştığının kanıtı:** bir tartım kaydı girildikten sonra o seferin/sürücünün/aracın audit izi asla elle silinemiyor, ops/bakım script'leri dahil. **Düzeltme:** script `CEBI-TEST-001`'e artık hiç dokunmuyor (kalıcı olduğu belgelendi), sadece `CEBI-TEST-002`'yi ayrı statement'larla temizliyor. İkinci çalıştırma tam başarılı: `DELETE 0,1,1,1,2` — `driver2`/`admin2` ve bağlı kayıtlar silindi, `CEBI-TEST-001` ve temel `admin@cebi-test.local` seed'i dokunulmadan kaldı.

**Not (henüz kararlaştırılmadı):** `scripts/dev/cebi_e2e_test.sh` bir dahaki sefere tekrar çalıştırılırsa, kendi üstteki temizlik bloğundaki aynı `weighbridge_readings` DELETE satırı da aynı nedenle başarısız olacak ve `task_no='CEBI-TEST-001'` zaten var olduğu için yeniden-seed adımı çakışabilir — Cem'e soruldu, henüz cevap/karar yok.

---

## 2026-10-18 (gece, devam 10) — ADR-CE-04 override rol kısıtı kapandı + ADR-CE-02 mobil telemetri "Onaylandı"

**Cem'in kararı (iki konuyu birden çözen tek cevap):** "devam edelim" sonrası sunulan seçenekler arasından **ADR-CE-02 mobil telemetri**'yi seçti (gerekçe: dış vendor/console erişimi gerektirmiyor, kod-only, mimari önemde bir "İnceleniyor" maddesini kapatıyor). Aynı cevapta, önceki turdan açık kalan **ADR-CE-04 override yetkisi** sorusunu da netleştirdi: "ADR-CE-04 override yetkisi sadece company_admin'de olsun." → `docs/adr/ADR-CE-04-sefer-kapanis-reconciliation.md` v3'e işlendi: override yalnızca `company_admin`/`super_admin`, `dispatcher` değiştiremez (gerekçe: planlanan sayı aynı zamanda bir kaçak/atlanan sefer sinyali — operasyonel bir rolün bunu tek başına esnetebilmesi caydırıcılığı zayıflatır). ADR-CE-04'ün kalan tüm açık soruları kapandı (§5).

**ADR-CE-02 — HTTPS batch senkronizasyon kesinleşti, local queue + sunucu idempotency TASARLANDI VE KODLANDI (tasarım belgesi değil):**

*Sunucu tarafı (`cebi-backend`):*
- `migrations/1785500000000_create-mobile-location-pings.sql` — `public.mobile_location_pings` (hypertable, 30 gün retention). Bilerek `public.locations` (ESP32, device_id bazlı) ile AYNI tabloya yazılmadı — farklı veri kaynağı (telefon GPS'i, device_id'siz). `client_ping_id UUID UNIQUE` — idempotency anahtarı.
- `routes/mobileTelemetry.js` — `POST /api/driver/telemetry/batch`: sadece `driver` rolü, sadece kendi task'ı, task durumu kısıtlanmaz (gecikmeli/offline ping'ler meşru). Çoklu VALUES + `ON CONFLICT (client_ping_id) DO NOTHING`. `{submitted, accepted, duplicates}` döner. `server.js`'e register edildi.
- Commit `01a9861` ile push edildi (henüz `fleet-enterprise-01`'e UYGULANMADI — migration + rebuild + doğrulama sıradaki adım).

*Mobil taraf (`cebi-mobile`):*
- `src/utils/uuid.js` — yeni native bağımlılık eklemeden (expo-crypto/react-native-get-random-values yok, bu oturumda native rebuild yapılamıyor) hafif UUID v4 üretici.
- `src/services/telemetryQueue.js` — AsyncStorage tabanlı kalıcı local kuyruk (mevcut `storage.js` generic kalıbıyla).
- `src/services/telemetrySync.js` — `expo-location.watchPositionAsync` ile GPS toplama + 20s periyodik toplu senkronizasyon. `startTracking(taskId)`/`stopTracking()`.
- `src/services/api.js` — `telemetryAPI.sendBatch()` eklendi.
- `src/screens/driver/DriverRouteMapScreen.js` — `task.status === "in_progress"` olduğu sürece takibi açık tutan bir effect eklendi (hem yeni başlayan sefer hem ekrana geri dönüş/remount senaryosu); unmount ve sefer tamamlama anında `stopTracking()` ile son flush.
- **Yan bulgu ve düzeltme:** `handleStartTask`/`handleCompleteConfirm`/`handleAcceptTask`/reddet akışlarının hata gösterimi sadece `e.response?.data?.message`'a bakıyordu; backend'in standart hata şekli `{error: "..."}` (örn. weighbridge gate'inin "Weighbridge reading required before completion" mesajı) sürücüye HİÇ görünmüyordu. `.error` önce kontrol edilecek şekilde 4 yerde düzeltildi.
- Commit `505ce80` ile push edildi.

**Bilinçli kapsam sınırı (ADR-CE-02'ye işlendi, gizlenmedi):** V1 **sadece foreground (ekran açık) takip**. Gerçek arka plan takibi `expo-task-manager` + native/EAS rebuild gerektirir — bu oturumda cihaz/simülatör erişimi yok, test edilemez. Ayrı bir takip maddesi olarak kayıtlı.

**Doğrulama durumu:** `node --check` (backend) ve `esbuild` ile JSX-uyumlu syntax kontrolü (mobil) yapıldı — ikisi de temiz. `scripts/dev/cebi_telemetry_e2e_test.sh` yazıldı (weighbridge scriptiyle aynı desen: idempotent temizlik, 4 test — rol gate 403, batch kabul 201, aynı batch tekrar → duplicate tespiti, geçersiz latitude → 400). **Henüz `fleet-enterprise-01`'de çalıştırılmadı** — migration'ın uygulanması ve `cebi-backend --build`'in sıradaki adım olarak Cem'in erişimiyle yapılması gerekiyor (weighbridge turundaki aynı iş birliği deseni).

**Kalan açık maddeler:** §9.2 (tartım cihazı marka/model — değişmedi), gerçek arka plan GPS takibi (ADR-CE-02 §4.2), OSRM/CARTO entegrasyonu (§9.7, vendor erişimi gerekiyor), `cebi-mobile` Maps/Firebase credential ayrışması (Risk #14, GCP/Firebase console erişimi gerekiyor) — hiçbiri bu turda ele alınmadı (Cem'in seçimiyle bilinçli olarak sonraya bırakıldı).

---

## 2026-10-18 (gece, devam 11) — Mobil Telemetri migration bug'ı: hypertable + ON CONFLICT idempotency çatışması

**Deployment'ta bulunan hata (`fleet-enterprise-01`):** `1785500000000` migration'ı `CREATE TABLE`/`CREATE INDEX`/`COMMENT` adımlarında başarılı oldu, ama `SELECT create_hypertable(...)` adımında patladı: `ERROR: cannot create a unique index without the column "recorded_at" (used in partitioning)`.

**Kök neden:** TimescaleDB, bir hypertable üzerindeki HER UNIQUE/PRIMARY KEY constraint'in partitioning (zaman) kolonunu içermesini zorunlu kılıyor. Bizim idempotency tasarımımız (`client_ping_id UNIQUE` + `ON CONFLICT (client_ping_id) DO NOTHING`) ise `client_ping_id` ÜZERİNDE TEK BAŞINA bir unique constraint gerektiriyor — Postgres'in `ON CONFLICT` hedef eşlemesi, unique index'in kolon kümesiyle TAM eşleşme istiyor (`(client_ping_id, recorded_at)` composite unique, `ON CONFLICT (client_ping_id)` ile eşleşmezdi). İki gereksinim doğrudan çatışıyor.

**Düzeltme (commit sonraki push'ta):** `migrations/1785500000000_create-mobile-location-pings.sql`'den `create_hypertable`/`add_retention_policy` çağrıları kaldırıldı — tablo bilinçli olarak DÜZ bir Postgres tablosu bırakıldı. Gerekçe belgelendi (migration içinde yorum olarak): idempotency, hypertable'ın zaman-partitioning performans avantajından daha öncelikli; V1 kapsamı (foreground-only, sefer-başına sınırlı GPS toplama) zaten `public.locations`'ın (7/24 çok-araçlı ESP32) ölçeğiyle kıyaslanamaz — hypertable'ın getirisi bu hacimde önemsiz. Retention ihtiyacı gerçek bir sorun haline gelirse ayrı bir cron ile ele alınabilir (ayrı iş kalemi).

**Sunucudaki fiili durum:** `CREATE TABLE`/indeksler/`COMMENT` zaten hypertable adımından ÖNCE ayrı ayrı commit olmuştu (psql autocommit, script'te açık `BEGIN` yoktu) — yani tablo sunucuda ZATEN doğru (düz) halde duruyor, ekstra bir düzeltme adımı gerekmedi. Cem'e sadece doğrulama scriptini tekrar çalıştırması söylendi.

**Doğrulama — tam başarılı (`scripts/dev/cebi_telemetry_e2e_test.sh`, `fleet-enterprise-01`):**
1. **TEST 1 — `company_admin` rolüyle batch gönderimi:** `HTTP 403 {"error":"Sadece driver rolü telemetri gönderebilir"}` — tam beklenen.
2. **TEST 2 — driver, 3 yeni ping:** `HTTP 201 {"submitted":3,"accepted":3,"duplicates":0}`.
3. **TEST 3 — AYNI 3 ping tekrar gönderildi (retry simülasyonu):** `HTTP 201 {"submitted":3,"accepted":0,"duplicates":3}` — `client_ping_id` UNIQUE + `ON CONFLICT DO NOTHING` idempotency kanıtlandı.
4. **TEST 4 — geçersiz latitude (999):** `HTTP 400`, doğru validasyon hatası.
5. **DB doğrulaması:** `mobile_location_pings` tablosunda tam 3 satır (3 ping kabul edildi, 3 tekrar denemesi atlandı — toplam 3, çift kayıt yok).

**Sonuç:** ADR-CE-02 (Mobil Telemetri) artık sadece kod/tasarım seviyesinde değil, canlı sunucuda fonksiyonel olarak kanıtlanmış durumda — Weighbridge turundaki aynı titizlikle. `cebi-backend` tarafı tam olarak TAMAMLANDI. Kalan: `cebi-mobile` tarafının gerçek bir cihazda/derlemede test edilmesi (bu oturumda cihaz/simülatör erişimi yok — kod seviyesinde syntax-check'li, davranışsal olarak henüz doğrulanmadı) ve bilinçli V1 sınırı olan foreground-only takip.

---

## 2026-10-18 (gece, devam 9) — Weighbridge + completion gate uçtan uca doğrulandı (fleet-enterprise-01)

**Migration'lar uygulandı** (`fleet-enterprise-01`, `cebi-db`): `1785200000000` (weighbridge_operator rolü), `1785300000000` (weighbridge_readings + append-only trigger + current view), `1785400000000` (exception_events trip_count_reconciliation_mismatch tipi) — üçü de hatasız, `cebi-backend` `--build` ile yeniden ayağa kaldırıldı, `/health` → `200`.

**Doğrulama scripti (`scripts/dev/cebi_e2e_test.sh`) ilk çalıştırmada bir bug ortaya çıkardı:** `psql -tAc "INSERT ... RETURNING id;"` komut etiketini (`INSERT 0 1`) de stdout'a basıyor — `-t`/`-A` bunu bastırmıyor (sadece SELECT header/footer'ını bastırıyor). Capture edilen id değişkenleri iki satırlı hale gelip (`uuid\nINSERT 0 1`) sonraki FK insert'lerini bozdu. **Düzeltme:** her capture'a `| head -n 1` eklendi (commit `f1e7f08`), script başına idempotent temizlik eklendi (yarım kalan test kayıtlarını silip güvenle tekrar çalıştırılabilir hale getirdi).

**İkinci çalıştırma — tam başarılı, uçtan uca doğrulandı:**
1. Driver + `weighbridge_operator` test kullanıcısı, araç, `in_progress` task seed edildi.
2. **TEST 1 — tartımsız `/complete`:** `HTTP 400 {"error":"Weighbridge reading required before completion"}` — tam beklenen.
3. **Tartım kaydı (`POST /api/weighbridge/readings`, ManualAdapter, 18500 kg):** `HTTP 201`, kayıt `weighbridge_readings`'e düştü.
4. **TEST 2 — tartımlı `/complete`:** `HTTP 200`, `task.status: "completed"` — gate geçti, normal tamamlama akışı (actual_end, vb.) sorunsuz çalıştı.

**Sonuç:** Weighbridge bounded context (şema + adapter pattern + route'lar + completion gate) artık sadece kod seviyesinde değil, canlı sunucuda fonksiyonel olarak kanıtlanmış durumda. Test verisi (`driver1@cebi-test.local`, `tarti1@cebi-test.local`, plaka `TEST-34-CEBI`, task `CEBI-TEST-001`) `cebi-db`'de duruyor — zararsız (izole test ortamı, henüz ödeyen müşteri yok), gerekirse `scripts/dev/cebi_e2e_test.sh`'in temizlik bloğu elle tekrar çalıştırılarak silinebilir.

**Kalan açık maddeler:** §9.2 (tartım cihazı marka/model — gelince sadece ilgili adapter implemente edilecek, şema/gate değişmeyecek), override için rol kısıtı gerekip gerekmediği (ADR-CE-04 §5).

---

## 2026-10-18 (gece, devam 7) — Weighbridge bounded context: şema + adapter iskeleti yazıldı

**Cem'in teyidi:** Tartım cihazı marka/model bilgisi henüz yok (§9.2 hâlâ açık). Bu yüzden iskelet, cihazdan tamamen bağımsız (adapter pattern, §8.4) tasarlandı — sadece `ManualAdapter` çalışır durumda, HTTP/TCP/Serial adapter'lar 501 döner (`TODO(§9.2)`).

**Eklenenler (push edilmedi, henüz bu oturumda):**
- `migrations/1785200000000_add-weighbridge-operator-role.sql` — `public.users.role` CHECK'ine `weighbridge_operator` (Tartı Memuru, §9.6) eklendi. Desen: `1778950000000_add-dispatcher-role.sql` ile birebir aynı.
- `migrations/1785300000000_create-weighbridge-readings.sql` — `public.weighbridge_readings` tablosu: append-only (UPDATE/DELETE trigger ile DB seviyesinde engellendi, §9.5 değişmezlik gereksinimi), düzeltmeler `supersedes_id` zinciriyle yeni satır olarak eklenir (reason zorunlu). `task_id → public.tasks(id)` (enterprise.dispatch_tasks değil — köprü zaten `tasks.enterprise_dispatch_task_id` üzerinden var, 1782100000000). `weighbridge_readings_current` view'ı, gate kontrolü için hazır sorgu yüzeyi.
- `migrations/1785400000000_exception-events-add-trip-reconciliation-type.sql` — `enterprise.exception_events.exception_type` CHECK'ine `trip_count_reconciliation_mismatch` eklendi (ADR-CE-04 §B.2 — bu değer henüz hiçbir kod tarafından INSERT edilmiyor, sadece constraint hazırlandı). Desen: `1782800000000_bug1-overlap-foundation.sql` (rule_violation eklemesi) ile birebir aynı.
- `services/weighbridge/adapters/{WeighbridgeAdapter,ManualAdapter,HttpAdapter,TcpAdapter,SerialAdapter}.js` — interface + 1 çalışan + 3 iskelet adapter.
- `services/weighbridge/index.js` — adapter factory.
- `routes/weighbridge.js` — `POST /api/weighbridge/readings`, `GET /api/weighbridge/tasks/:taskId/readings`, `GET /api/weighbridge/tasks/:taskId/current`, `POST /api/weighbridge/readings/:id/correct`. Roller: `weighbridge_operator, dispatcher, company_admin, super_admin` (driver tartım giremiyor). `server.js`'e register edildi.

**Bilinçli olarak YAPILMADI (ayrı bir adım, bu turda değil):** §9.5/ADR-CE-04 §2-A'nın gerektirdiği "tartım kaydı olmadan sefer Completed olamaz" gate'i, `routes/driver.js`/`server.js`'deki mevcut waypoint/task tamamlama akışına (`updateWaypointStatusTx` ve ilgili endpoint'ler) HENÜZ bağlanmadı. Gerekçe: bu, canlı production akışını değiştiren bir kod değişikliği — `weighbridge_readings_current` view'ı hazır (`SELECT EXISTS(...)` ile tek sorguda kontrol edilebilir), ama tam completion akışının (hangi waypoint "final"/dropoff sayılıyor, tasks.status ne zaman "Completed" oluyor) satır satır incelenip doğru noktaya bağlanması gerekiyor — "ispat et" disiplini gereği aceleye getirilmeyecek.

**Doğrulama durumu:** Sadece syntax-check (`node --check`) yapıldı — DB'ye karşı (`cebi-db`) henüz migration uygulanmadı, endpoint'ler canlıda test edilmedi. Sıradaki adım: Cem'in erişimiyle `fleet-enterprise-01`'de 3 migration'ı uygula, seed task ile `POST /api/weighbridge/readings` + `/current` uçtan uca doğrula.

**Henüz açık:** §9.2 (cihaz marka/model), override için rol kısıtı gerekip gerekmediği (ADR-CE-04 §5).

---

## 2026-10-18 (gece, devam 8) — Completion gate bağlandı (Cem'in talebiyle, ertelenmedi)

**Cem'in geri bildirimi:** Cihaz markasının bilinmemesi gate'i ertelemek için bahane değil — `ManualAdapter` zaten çalışıyor, `weighbridge_readings_current` hazır. Gate'i derhal bağla.

**Bulgu (incelemeyle doğrulandı):** `tasks.status`'u `'completed'` yapan **tek** yer `PUT /api/driver/tasks/:id/complete` (server.js, "Complete Task" endpoint'i). `accept`/`reject`/`start` ayrı status'lar yazıyor (`accepted`/`rejected`/`in_progress`), `completed` yazmıyor. Waypoint tamamlanması (`updateWaypointStatusTx`, `/waypoints/:waypointId/complete`) task'ı otomatik `completed` yapmıyor — waypoint'lerin tamamı bitse bile sürücü ayrıca `/complete` çağırmak zorunda. Yani gate için tek, net bir choke point var — `updateWaypointStatusTx`'e dokunmaya gerek yok.

**Yapılan (server.js, "Complete Task" endpoint'i içinde, `UPDATE tasks SET status='completed'`'tan hemen önce, aynı transaction içinde):**
```sql
SELECT 1 FROM public.weighbridge_readings_current WHERE task_id = $1 LIMIT 1
```
Satır yoksa `ROLLBACK` + `400 {"error":"Weighbridge reading required before completion"}` — tam Cem'in istediği mesaj. Satır varsa normal tamamlama akışına (odometer/GPS mesafe hesabı, alert, event insert, vb.) hiç dokunulmadan devam ediyor.

**Donanım-bağımsızlık:** Kontrol `weighbridge_readings_current` view'ına bakıyor, `adapter_type`'a değil — `ManualAdapter` ile girilmiş bir kayıt da, ileride `HttpAdapter`/`TcpAdapter` ile girilecek bir kayıt da aynı şekilde geçerli sayılır. §9.2 netleştiğinde bu satırda hiçbir değişiklik gerekmeyecek.

**Doğrulanmadı (henüz):** `node --check` ile syntax doğrulandı, ama gerçek DB'ye karşı (tartımsız task'ta 400 dönüyor mu, tartımlı task'ta normal akış bozulmadan devam ediyor mu) uçtan uca test edilmedi — migration'lar `cebi-db`'ye henüz uygulanmadı.

---

## 2026-10-18 (gece, devam 6) — ADR-CE-04 "Onaylandı"ya geçti

**Cem'in önerisi:** "Planlanan sefer sayısı" için Hibrit model — `dispatch_tasks`'tan otomatik türetim (varsayılan) + dispatcher'ın gerektiğinde elle override edebilmesi.

**Cross-check ile eklenen üç netlik (Cem'in önerisini genişletiyor, çelişmiyor):**
1. **Override audit:** override alanı nullable (`NULL`=otomatik, dolu=override) ama değiştirildiğinde kim/ne zaman/neden loglanır — planlanan sayı aynı zamanda bir kaçak-sinyali olduğundan (§9.4), sessizce ezilebilir olmaması gerekiyor.
2. **Uyuşmazlık (tamamlanan < planlanan):** gün otomatik kapanmaz, mevcut `enterprise.exception_events` hypertable'ına kayıt düşer (yeni mekanizma icat edilmedi — Faz 1 keşfinde zaten doğrulanmış tablo kullanıldı).
3. **Tetikleme:** sefer tamamlandığında hafif yeniden-değerlendirme + gece yarısı güvenlik-ağı cron'u (ikisi birden).

Cem onayladı. ADR-CE-04 v2, Durum: Onaylandı. Detay: `docs/adr/ADR-CE-04-sefer-kapanis-reconciliation.md`.

**Kalan açık maddeler (değişmedi):** Weighbridge bounded context kod/migration (en büyük kalan iş), §9.2 tartım cihazı marka/model, `cebi-mobile` Maps/Firebase credential ayrışması.

---

## 2026-10-18 (gece, devam 2) — HERE_API_KEY tedarik edildi, fonksiyonel doğrulandı

**Karar:** ADR-CE-03 ("Bağımsız Çalışma Zamanı") ilk yorumumuz ana projeden tamamen ayrı bir HERE hesabı (farklı e-posta) gerektiriyor sanılmıştı — Cem'in düzeltmesiyle netleşti: ilke, iki backend arasında **paylaşılan bir secret olmaması**; aynı HERE hesabı içinde **ayrı bir app** (dolayısıyla ayrı API key) bu amacı karşılıyor. Mevcut "TulipFleet" app'inin yanına **"TulipFleet Cebi"** app'i oluşturuldu.

**Bulgu/çözülen hata 1 — yanlış credential tipi:** İlk oluşturulan "access token" aslında bir **OAuth 2.0/2.1 credential**'dı, HERE'in "API Keys" sekmesinde (query-param `?apiKey=...` ile çalışan düz REST key) **sıfır kayıt** vardı ("API Keys (0 of 2)"). `HereRoutingProvider.js` kodu apiKey query-param bekliyor — OAuth token bu akışla uyumsuz, `"Token or apiKey is missing"` hatasına yol açtı. **Düzeltme:** "API Keys" sekmesinden "Create API key" ile doğru tipte credential üretildi.

**Bulgu/çözülen hata 2 — `docker compose restart`, değişen `env_file`'ı yeniden okumuyor:** `cebi.env`'e yeni key `sed` ile yazıldıktan sonra `docker compose restart cebi-backend` çalıştırıldı, `/health` 200 döndü ama container içinde `process.env.HERE_API_KEY` boştu (`"apiKey invalid. apiKey not found"` / önce `"missing"`). `restart`, var olan container'ı **eski, oluşturulduğu andaki environment'ıyla** yeniden başlatıyor — `env_file` değişikliğini içeri almıyor. **Düzeltme:** `docker compose --env-file cebi.env -f docker-compose.cebi.yml up -d cebi-backend` (container'ı yeniden oluşturur, güncel `cebi.env`'i okur). Bundan sonra `up -d` hep `restart` yerine kullanılacak (env değişikliği olan her durumda).

**Doğrulama yöntemi:** `/api/driver/route-traffic` gibi backend endpoint'leri seed veri (sürücü + aktif görev) gerektirdiğinden, HERE Routing API v8'e `cebi-backend` container'ı içinden doğrudan bir Node script ile (`docker cp` + `docker exec ... node /tmp/here_test.js`) İstanbul içi bir rota istendi — `routes[0].sections[0].summary.duration` döndü, çalıştığı kanıtlandı. Not: `docker exec`'e doğrudan multi-line `node -e "..."` yapıştırmak SSH terminalinde tırnak/satır bölünmesine yol açabiliyor — script'i dosyaya yazıp `docker cp` ile taşımak daha güvenilir.

**Sonuç:** `HERE_API_KEY` tedariki tamamlandı, canlıda fonksiyonel doğrulandı. Sıradaki dış servis: `GOOGLE_MAPS_API_KEY` (cebi-backend'in kendi key'i — mobile app'in Maps key'inden ayrı, sadece geocoding için kullanılıyor, bkz. `cebi.env.example`).

## 2026-10-18 (gece, devam 3) — GOOGLE_MAPS_API_KEY (Geocoding) tedarik edildi, fonksiyonel doğrulandı

**Kod doğrulaması (tahmin edilmedi, grep ile teyit edildi):** `routes/geocode.js` + `server.js:3563`, sadece **Google Geocoding API**'yi (`maps.googleapis.com/maps/api/geocode/json`, server-side) kullanıyor — Maps SDK/JS değil. Bu yüzden key'e **IP restriction** uygun (Application restriction olarak Android/iOS/referrer değil); şimdilik sadece API restriction (`geocoding-backend.googleapis.com`) uygulandı, IP restriction daha sonra eklenebilir.

**Karar:** ADR-CE-03 — ayrı hesap yerine mevcut `tulipfleet-523be` (ana proje Firebase/GCP projesi) içinde **ayrı, Cebi'ye özel bir key** oluşturuldu (HERE'de kurduğumuz pattern'in aynısı).

**Bulgu/çözülen hata — ciddi, kendi hatamız: key değeri bu sohbete sızdı:** `gcloud services api-keys create ... --format="value(name)"` komutu çalıştırılırken, oluşturulan key'in **tam `keyString` değeri** `stdout`'a değil ama gcloud'un LRO (uzun süren işlem) tamamlanma logunun gittiği **stderr**'e basıldı (`"Operation ... complete. Result: {...keyString:...}"`) — komut `$(...)` ile sadece stdout'u yakaladığından, stderr terminale düştü ve ekran çıktısı sohbete yapıştırıldı. **Sonuç: bu ilk key (`d9f3aa7f-0c09-4bdc-aff9-a3c531c0021e`, displayName `cebi-backend-geocoding`) ele geçmiş sayıldı ve hemen silindi** (`gcloud services api-keys delete`), yenisi (`cebi-backend-geocoding-v2`) `2>/dev/null` ile stderr bastırılarak oluşturuldu. **Ders:** `gcloud services api-keys create` çıktısını her zaman `2>/dev/null` ile çalıştır; `--format="value(name)"` tek başına yeterli değil.

**Bulgu/çözülen hata — `--format="value(name)"` ile stderr bastırıldığında yanlış alan yakalanıyor:** stderr bastırıldıktan sonra `$KEY_RESOURCE` beklenen `projects/.../keys/<uuid>` yerine ham LRO id'si (`operations/akmf.p7-...`) olarak geldi — `get-key-string` bu yüzden 404 verdi, `GOOGLE_MAPS_API_KEY` boş yazıldı (`grep -c` → `0`). **Düzeltme:** `gcloud services api-keys list` ile displayName'e göre gerçek key kaynağını bulup `get-key-string`'i doğrudan o kaynakla (yine `2>/dev/null` ile) çalıştırmak.

**Bulgu/çözülen hata — billing bağlı değildi:** İlk fonksiyonel test `REQUEST_DENIED` / `"You must enable Billing on the Google Cloud Project"` ile başarısız oldu. `gcloud billing projects describe tulipfleet-523be` → `billingEnabled: false`. Mevcut, açık bir billing hesabı bulundu (`013EA7-88C2C2-65AF28`, "My Billing Account") ve `gcloud billing projects link` ile projeye bağlandı — sonrasında istek başarılı oldu.

**Sonuç:** `GOOGLE_MAPS_API_KEY` tedariki tamamlandı, Geocoding API'ye canlı istekle doğrulandı (İstanbul koordinatı → gerçek adres döndü). Sıradaki dış servis: `OPENWEATHER_API_KEY` — koddaki kullanım yeri henüz doğrulanmadı, önce grep ile teyit edilecek.

## 2026-10-18 (gece, devam 4) — OPENWEATHER_API_KEY oluşturuldu (aktivasyon bekleniyor), SMTP (Zoho) tedarik edildi ve doğrulandı

**OPENWEATHER_API_KEY:** Kod teyidi — `server.js:6068` ve `6240`, OpenWeatherMap Current Weather API (`api.openweathermap.org/data/2.5/weather`, `appid=` query-param, server-side), sürücü rota hava durumu için. `home.openweathermap.org/api_keys` üzerinden ayrı, Cebi'ye özel bir key oluşturuldu, `cebi.env`'e yazıldı. İlk fonksiyonel test `401 Invalid API key` döndü — bu **beklenen bir durum**, OpenWeatherMap'te yeni key'ler birkaç dakikadan birkaç saate kadar aktivasyon gecikmesi yaşayabiliyor (HERE'in 10 saniyelik gecikmesinin çok daha uzun karşılığı). **Henüz tekrar test edilmedi / doğrulanmadı — sıradaki adım.**

**SMTP — ADR-CE-03 yorumu, Cem'in açık kararıyla:** Kod teyidi — `server.js` içinde `nodemailer`, varsayılanlar `smtp.gmail.com` / `noreply@tulipfleet.com` / gönderen adı hardcoded `"TulipFleet"` (satır 687-693, 767, 7040-7098). Cem'in kararı: Cebi de **aynı `info@tulipfleet.com` adresini** kullansın (HERE/Maps'teki "ayrı hesap" pattern'i burada uygulanmadı — bilinçli, açık bir karar). Teknik keşif: bu adres Gmail/Google Workspace değil, **Zoho Mail** (`mail.zoho.eu`, MX kayıtları Zoho'ya yönlü). Zoho da Gmail gibi hesap başına birden fazla, birbirinden bağımsız iptal edilebilir **Application-Specific Password** üretmeye izin veriyor — `accounts.zoho.eu/home#security/app-passwords` üzerinden Cebi'ye özel bir app password oluşturuldu (adres paylaşıldı, şifre paylaşılmadı — kısmi ADR-CE-03 uyumu). `SMTP_HOST=smtp.zoho.eu`, `SMTP_PORT=587`, `SMTP_USER`/`SMTP_FROM=info@tulipfleet.com`.

**Doğrulama:** `nodemailer`'ın kendi `transporter.verify()` metoduyla (gerçek mail göndermeden, sadece SMTP bağlantı+auth kontrolü) `cebi-backend` container'ı içinden test edildi — `OK - SMTP bağlantısı ve kimlik doğrulama başarılı`. Not: test script'i `/tmp`'e değil **`/app`**'e kopyalanarak çalıştırıldı — `/tmp`'te `node_modules` yok, `nodemailer` gibi bağımlılık gerektiren script'ler `MODULE_NOT_FOUND` ile patlıyor; container'ın çalışma dizini (`/app`) kullanılmalı.

**Tali not:** `server.js`'deki SMTP gönderen adı hala hardcoded `"TulipFleet"` (Cebi'ye özel bir marka adı değil) — bu bir ürün/marka netliği konusu, acil değil, ileride ele alınabilir.

**Sonuç:** SMTP tamamlandı ve doğrulandı. Dış servis durumu: HERE ✓, Google Maps ✓, SMTP ✓, OpenWeather (key oluşturuldu, aktivasyon bekleniyor — henüz doğrulanmadı). OSRM/CARTO ve MQTT bilinçli olarak erteleniyor (bkz. `cebi.env.example` yorumları).

## 2026-10-18 (gece, devam 5) — OPENWEATHER_API_KEY doğrulandı; dış servis tedariki tamamlandı

**Bulgu/çözülen hata — `OPENWEATHER_API_KEY` bir şekilde boşaldı:** ~1 saat sonra 401 devam edince kontrol edildi (`grep '^OPENWEATHER_API_KEY=' | sed 's/^OPENWEATHER_API_KEY=//' | awk '{print length}'`) → uzunluk **0** çıktı, satır `OPENWEATHER_API_KEY=` olarak tamamen boşalmıştı (ilk yazımda `grep -c` ile `1`/dolu doğrulanmıştı). Kesin sebebi bu oturumda tespit edilemedi (muhtemelen dosyanın elle düzenlenmesi veya bir yan etki) — **not edilsin:** bundan sonra her secret yazımından hemen sonra sadece varlık değil, **uzunluk da** doğrulanmalı (`awk '{print length}'`), tek başına `grep -c` yeterli değilmiş (satırın "dolu" görünüp sonradan sessizce boşalabildiğini gösterdi). Değer tekrar girildi, uzunluk `32` (OpenWeatherMap key formatıyla tutarlı) doğrulandı.

**Sonuç — fonksiyonel doğrulandı:** İstanbul koordinatı ile gerçek hava durumu verisi döndü (`clear sky, 14.44C`).

**Dış servis tedariki TAMAMLANDI:** `HERE_API_KEY` ✓ · `GOOGLE_MAPS_API_KEY` ✓ · `SMTP_*` ✓ · `OPENWEATHER_API_KEY` ✓ — hepsi canlı, fonksiyonel doğrulanmış. Bilinçli olarak ertelenenler: `OSRM_BASE_URL`/`CARTO_API_KEY` (sıfırdan entegrasyon gerektiriyor, kod yok), MQTT (ADR-CE-02 henüz karara bağlanmadı, v1 varsayılanı HTTPS toplu senkronizasyon).

**Kalan açık maddeler (Faz 4 sonrası):** Weighbridge bounded context (kod/migration yok), ADR-CE-04 "planlanan sefer sayısı" veri kaynağı sorusu, §9.2 tartım cihazı marka/model kararı.

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
