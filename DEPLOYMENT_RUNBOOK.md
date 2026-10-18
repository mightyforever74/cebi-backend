# DEPLOYMENT_RUNBOOK.md — cebi-backend Faz 4 Kurulumu

Bu runbook, Cem'in kendi SSH erişimiyle çalıştıracağı adımları içerir. **Bu session'ın Hetzner sunucularına (10.0.0.0/16 private network, SSH port 22) ağ erişimi yok** (doğrulandı: `46.224.1.192:22`'ye bağlantı denendi, bloklandı) — bu yüzden aşağıdaki komutlar buradan çalıştırılamadı, Cem'in kendisi çalıştırmalı.

## 0. Açık kararlar (başlamadan önce)

Bu üçü benim tarafımdan varsayılamaz, Cem'in onayı/seçimi gerekiyor:

1. **Hangi sunucu — fleet-prod-01 mı fleet-enterprise-01 mi?** Cem'in kararı ikisini de "tercihen" olarak bıraktı. **Önerim: `fleet-enterprise-01`.** Gerekçe: `fleet-prod-01` ana ürünün müşteriye açık (gelecekteki ilk pilot/gerçek müşteri) production API'sini barındırıyor — kaynak çekişmesi (CPU/RAM/disk I/O) veya yanlış bir Cebi deploy adımının bu makineyi etkileme riski, enterprise-01'e göre daha yüksek maliyetli bir hata olur. `fleet-enterprise-01` şu an daha düşük trafikli (enterprise-backend, henüz ödeyen müşteri yok). Eşit derecede mantıklı bir karşı-argüman da var: `fleet-enterprise-01` Weighbridge/Trip&Dispatch mantığının referans alınacağı enterprise-backend'i barındırıyor, oraya bir şey daha koymak o makineyi daha da "kritik" hale getirir. Nihai karar Cem'de.
2. **Domain/subdomain adlandırması:** Cebi, TulipFleet'in kendi markası değil, müşteriye özel bir "Customer Edition". `cebi-api.tulipfleet.com` gibi bir alt domain mi kullanılacak (TulipFleet markasıyla görünür bağ kurar) yoksa tamamen ayrı/müşteri-nötr bir domain mi (örn. `api.<müşteri-kod-adı>.com`) tercih edilir? Bu, `.env.example`'daki `PUBLIC_TRACK_BASE_URL` ve mobile/dispatcher'ın `EXPO_PUBLIC_API_URL`/`REACT_APP_CEBI_API_URL` değerlerini belirler.
3. **DB motoru:** `docker-compose.cebi.yml` varsayılan olarak `timescale/timescaledb:2.17.0-pg16` seçti (ana projeyle tutarlılık için). Weighbridge/konum verisi için TimescaleDB'nin time-series avantajları gerekiyorsa bu doğru; basit bir `postgres:16-alpine` yeterliyse değiştirilebilir — Cem'in onayı gerekiyor.

## 1. Sunucuya bağlan ve repoyu çek

```bash
ssh root@<SEÇİLEN_SUNUCU_IP>   # fleet-prod-01=46.224.1.192 veya fleet-enterprise-01=49.12.246.212
mkdir -p /opt/cebi
cd /opt/cebi
git clone https://github.com/mightyforever74/cebi-backend.git .
```

## 2. Port çakışma kontrolü (ZORUNLU — atlama)

```bash
docker ps --format '{{.Names}}\t{{.Ports}}'
ss -tlnp | grep -E ':(5433|3100)\b'
```

`docker-compose.cebi.yml`'deki varsayılan portlar (`5433` host→cebi-db, `3100` host→cebi-backend) bu sunucuda **boşsa** devam et. Doluysa `docker-compose.cebi.yml`'de `CEBI_BACKEND_PORT`/port mapping'i değiştir (env ile override edilebilir, dosyayı elleme).

## 3. Secrets üret ve `cebi.env` oluştur

```bash
cp cebi.env.example cebi.env
# JWT_SECRET ve CEBI_DB_PASSWORD'ü ÜRET (ana projenin değerlerini KOPYALAMA):
openssl rand -hex 32   # → JWT_SECRET
openssl rand -hex 24   # → CEBI_DB_PASSWORD
# cebi.env'i editörle aç, bu iki değeri ve dış servis anahtarlarını (HERE,
# OSRM/CARTO, SMTP, Google Maps, OpenWeather — hepsi YENİ hesaplar) doldur.
```

`cebi.env` zaten `.gitignore`'da (bkz. bu repo) — commit edilmeyecek.

## 4. Stack'i başlat

```bash
docker compose -f docker-compose.cebi.yml up -d --build
docker compose -f docker-compose.cebi.yml logs -f cebi-backend   # "Server running on port 3000" görülmeli
```

## 5. Doğrulama (ispat et)

```bash
# cebi-backend ana projeden tamamen izole mi?
docker network inspect cebi-net   # sadece cebi-db + cebi-backend olmalı
docker exec cebi-backend env | grep -E "JWT_SECRET|DATABASE_URL"   # ana projenin değerleriyle AYNI OLMAMALI
curl -s http://localhost:3100/   # (veya hangi healthcheck route varsa)
```

## 6. Sonraki adımlar

- `cebi-mobile`: `.env`'de `EXPO_PUBLIC_API_URL=http://<sunucu-ip>:3100` (veya kararlaştırılan domain) ayarla, build al.
- `cebi-dispatcher`: `.env`'de `REACT_APP_CEBI_API_URL=http://<sunucu-ip>:3100` (veya domain) ayarla, build al.
- DNS/subdomain kurulumu (açık karar #2 netleşince).
- Weighbridge bounded context'inin ilk migration'ları (`cebi-backend/migrations/`) — henüz yazılmadı, Faz 4'ün bir sonraki adımı.
