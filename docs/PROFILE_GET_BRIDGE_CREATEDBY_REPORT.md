# GET /api/user/profile + bridge `created_by`

Dal: `main` · Taban: `origin/main` `9b70d98` · Tarih: 2026-09-27  
Ortam: **staging only** (`staging-api.tulipfleet.com` / PM2 `fleet-staging` / `fleet_tracking_staging`). Prod §3 yapılmadı.

## Okunan kaynaklar

- `C:\tulipfleet-qa\WORKING_RULES.md` — staging → test → prod; sır değeri basılmaz
- `INFRASTRUCTURE.md` Ortam Matrisi + Server.js Deploy Prosedürü §1–2
- `SESSION_NOTES.md` şema referansı: `companies.name` (kolon `company_name` değil); `drivers.user_id` ≠ `users.id`

## A — GET `/api/user/profile`

Önce yalnız `PUT /api/user/profile` vardı (`server.js` alias). Mobil `userAPI.getProfile` (`C:\argon\src\services\api.js`) `GET /api/user/profile` çağırır; ekranlar (`AdminSettings.js`, `EditProfileScreen.js`) AuthContext `user.firstName || user.first_name` / `last_name` / `phone` / `email` bekler. Dispatcher `useUserAccount.ts` aynı GET’i JSON kökünde `firstName`/`email`/`phone` okur.

- `preHandler: authenticate`; `WHERE u.id = $1` (`request.user.id`) — self-scope
- SQL: `users` ⟕ `companies` → `c.name AS company_name`
- 404 yalnız satır yoksa
- Yanıt: SQL alanları + `user` sarmalayıcı + `firstName`/`lastName` alias

## D — `routes/internalBridge.js`

- Payload: `created_by_user_id` (opsiyonel) → `INSERT created_by`
- `description == null` → SQL `NULL` (boş string zorlanmaz)
- `derivedTitle` aynı: `title || start → end`, 255 kırpma

### Şema kanıtı (staging `information_schema`, 2026-09-27)

```
 column_name | is_nullable | data_type
 created_by  | YES         | uuid
 description | YES         | text
```

`docker exec -i 6601902c43f0_fleet-postgres psql -U fleetadmin -d fleet_tracking_staging`  
Karar: her iki kolon nullable → `NULL` yazılır; `''` kullanılmaz.

## Staging uygulama (§1–2)

Yedek: `server.js.bak.20260927_221632`, `internalBridge.js.bak.20260927_221632`  
`node --check` her iki dosya → OK  
`pm2 restart fleet-staging --update-env` → online  
`curl https://staging-api.tulipfleet.com/health` → **200**

### Profil curl (token/şifre yok)

| Kimlik (doküman) | HTTP | `company_name` | `role` | self `id` = JWT `id` |
|---|---|---|---|---|
| `demo@tulipfleet.com` | **200** | Dobbe Transport | company_admin | evet |
| `driver@tulipfleet.com` | **200** | Dobbe Transport | driver | evet |
| `anna@tulipfleet.com` | **200** | Dobbe Transport | driver | evet |
| `test@fleet.com` | **200** | Tulip Lojistik | driver | evet |

Kök alanlar: `user,id,email,role,first_name,last_name,firstName,lastName,phone,language,company_id,company_name`

Not: INFRASTRUCTURE §2 örneği `test@tulipfleet.com` staging’de yok; sürücü `test@fleet.com` / `driver@tulipfleet.com`.

## Prod

§3 kopya + Docker recreate **yapılmadı**. Cem onayı beklenir.

## Kapsam dışı

- Dispatcher navbar kimliği (mini-sprint B)
- Enterprise’ın `created_by_user_id` göndermesi (çekirdek yalnız kabul eder)
- `GET /api/users/profile` (eski, `company_name` yok)
