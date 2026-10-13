"use strict";

/**
 * routes/liveCapacityHelpers.js
 *
 * FEAT-020 Phase 1.3b (Katman C, backend dilimi, 2026-10-13, Cem onayli).
 * Spec: tulipfleet-dispatcher/docs/functions/FEAT-020-capacity-aware-delivery-promising.md §6.
 *
 * Suruculerun mobil uygulamadan bildirdigi ANLIK bos kapasite — Phase 1.1'in
 * statik cargo_capacity_* kolonlarindan (vehicleCapacityHelpers.js, aracin
 * TOPLAM/MAX kapasitesi, admin girer, nadiren degisir) AYRI: bu her sefer
 * raporunda degisebilen, suruculerun kendi bildirdigi BOS kapasite. Hazmat
 * sertifikasi bu kapsamin disinda (hep statik kalir, surucu rapor etmiyor).
 *
 * Pure validation/parsing only — vehicleCapacityHelpers.js'teki
 * parseOptionalNonNegativeNumber yeniden kullanilir (ayni kural: bos/null/
 * undefined -> null, sifir gecerli bir deger, negatif/NaN -> invalid).
 *
 * @param {Object} body - raw HTTP request body (PATCH /api/driver/live-capacity)
 * @returns {{ok: true, volumeM3: number|null, weightKg: number|null}
 *          | {ok: false, error: string}}
 */
const { parseOptionalNonNegativeNumber, INVALID } = require("./vehicleCapacityHelpers");

function parseLiveCapacityFields(body) {
  const raw = body || {};

  const volumeM3 = parseOptionalNonNegativeNumber(raw.volume_m3);
  if (volumeM3 === INVALID) {
    return { ok: false, error: "invalid_volume" };
  }

  const weightKg = parseOptionalNonNegativeNumber(raw.weight_kg);
  if (weightKg === INVALID) {
    return { ok: false, error: "invalid_weight" };
  }

  return { ok: true, volumeM3, weightKg };
}

module.exports = { parseLiveCapacityFields };
