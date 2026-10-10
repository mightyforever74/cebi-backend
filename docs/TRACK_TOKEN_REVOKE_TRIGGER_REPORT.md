# Takip portali: token iptali DB trigger'i (10.10.2026)

## Sorun
`public_tracking_tokens.is_revoked` yalniz handler'larda guncelleniyordu
(`DELETE /api/tasks/:id/public-link`, statu handler'lari). SQL ile ya da
handler disinda kapali statuye gecen gorevde token acik kaliyordu
(TLP-26-00002 ve 00003'te elle kapatildi). Statu kapisi 404'u zaten
veriyor; bu defans derinligi.

## Cozum
`migrations/1783200000000_tracking-token-revoke-trigger.sql`:
`AFTER UPDATE OF status ON public.tasks` trigger'i; yeni statu
completed / cancelled / withdrawn ise ve statu gercekten degistiyse
o gorevin acik token'larini `is_revoked = true` yapar. Idempotent
(`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`).

## Uygulama
Elle, `docker exec -i ... psql -d <db> < migrations/...sql` ile.
Once `fleet_tracking_staging`, sonra `fleet_tracking`. Kod degisikligi yok,
backend yeniden baslatilmadi.

## Kanit
- Staging: TLP-26-00016 (in_progress) icin test token eklendi, SQL ile
  `cancelled` yapildi -> token `is_revoked = t`.
- Prod: `pg_trigger` listesinde `trg_revoke_tracking_tokens_on_close`;
  TLP-26-00006 (assigned, tokenli) SQL ile `cancelled` -> `is_revoked = t`,
  handler calismadan.

## Not
Handler'lardaki revoke kodu yerinde durdu (ayni isi iki kez yapmak
zararsiz). Statu kumesi genislerse (yeni kapali statu) trigger'daki liste
de guncellenir; publicTrack.js'teki kapali kume ile ayni tutulur.
