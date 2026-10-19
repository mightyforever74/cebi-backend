#!/usr/bin/env node
// TulipFleet Customer Edition (Cebi) — tek seferlik test kullanıcısı şifre
// hashleme yardımcı scripti. `docker exec cebi-backend node /app/hash_pw.js
// <şifre>` olarak çağrılır (scripts/dev/*.sh e2e scriptleri bu yolu
// bekliyor); `COPY . .` sayesinde image build'inde otomatik `/app/hash_pw.js`
// konumuna gelir.
//
// BULGU (2026-10-19): bu dosya daha önce git'e girmeden, ad-hoc olarak bir
// container'ın yazılabilir katmanına elle eklenmişti — her `docker compose
// up -d --build cebi-backend` (container recreate) sonrası sessizce
// kayboluyordu. Sonuç: `docker exec cebi-backend node /app/hash_pw.js ...`
// `MODULE_NOT_FOUND` ile stderr'e hata yazıyor, `$(...)` komut ikamesi
// bunu YAKALAMIYOR (sadece stdout), ve çağıran script'teki değişken
// SESSİZCE boş string oluyor — sonraki INSERT/UPDATE, `password_hash`
// sütununa boş string yazıyor, login her zaman "Invalid credentials"
// (401) ile başarısız oluyor, hiçbir hata fırlatmadan. Bu, cebi-dispatcher
// panelinin fleet-enterprise-01 Caddy'si üzerinden canlı doğrulanması
// turunda (`browsertest@cebi-test.local`) yakalandı. Artık git'te olduğu
// için bu sınıf hata tekrarlanmaz.
//
// `bcryptjs` kullanılıyor (native `bcrypt` DEĞİL) — server.js:624'teki
// `/api/auth/login` karşılaştırması `const bcrypt = require("bcryptjs")`
// ile yapılıyor; farklı bir kütüphaneyle hashlenmiş bir değer formatı
// uyumlu olsa da, tutarlılık için burada da aynı paket kullanılır.
const bcrypt = require("bcryptjs");

const password = process.argv[2];
if (!password) {
  console.error("Kullanım: node hash_pw.js <şifre>");
  process.exit(1);
}

bcrypt
  .hash(password, 10)
  .then((hash) => {
    console.log(hash);
  })
  .catch((err) => {
    console.error("hash_pw.js hata:", err);
    process.exit(1);
  });
