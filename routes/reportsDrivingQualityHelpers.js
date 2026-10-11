/**
 * routes/reportsDrivingQualityHelpers.js
 *
 * §5 Reports (Mayıs listesinden açık) — "Driving Quality trend:
 * compare_with_previous=true + previous_period (backend) + delta UI"
 * (11 Ekim 2026, Cem'in kararıyla başlatıldı — FEAT-007-EXT kapanışının
 * ardından sıradaki gerçek feature).
 *
 * Mevcut `GET /api/reports/drivers/performance` endpoint'i tek bir dönem
 * için sürücü bazlı `driving_score` hesaplıyordu (routes/reports.js,
 * Sprint D1). Bu dosya o mantığı saf/test edilebilir parçalara ayırır ve
 * "önceki dönemle karşılaştır" özelliğini ekler.
 *
 * Cem'in 3 ek gereksinimi (11 Ekim 2026):
 *   1. "Yarım dönem" sorunu: önceki dönemde skor hesaplanamıyorsa (yeni
 *      sürücü / <10km) delta YANLIŞ bir "-100%" göstermez —
 *      computeScoreDelta bu durumda score_delta/trend=null döner ve
 *      trend_note: "insufficient_history" ile işaretler (UI "-100%" yerine
 *      "henüz karşılaştırılacak geçmiş yok" gösterebilir).
 *   2. `days` parametresi zaten dinamik (30 sabit değil) — bu modül
 *      herhangi bir `days` için simetrik iki dönem üretir.
 *   3. Performans: fetchDriverPerformanceRows'un SQL'i mevcut sorguyla
 *      AYNI filtre kolonlarını kullanır (driver_id, vehicle_id,
 *      created_at) — iki kez (güncel+önceki) çalıştığında index ihtiyacı
 *      ayrı migration'da ele alındı (bkz.
 *      migrations/*_driving-quality-trend-indexes.sql). Üst sınır artık
 *      NOW() değil, dönemin kendi `to` değeri — önceki dönem sorgusu gerçek
 *      "şu an"a kadar değil, kendi dönem sonuna kadar alert topluyor
 *      (eski davranışta NOW() kullanılıyordu, bu önceki dönem için yanlış
 *      olurdu — bu refactor'da düzeltildi).
 *
 * Test edilebilirlik için `fetchDriverPerformanceRows(client, ...)` ve
 * `buildDriverPerformanceReport(client, ...)` DB client'ı dışarıdan enjekte
 * eder (routes/vehicleTrackHelpers.js presedenti).
 */

const { sqlAlertTypeFilter } = require("../services/alerts/alertTypes");

const DEFAULT_DAYS = 30;
const MIN_KM_FOR_SCORE = 10;

/**
 * Sürüş skorunu hesaplar (saf fonksiyon — eski inline mantığın extract
 * edilmiş hali, formül DEĞİŞMEDİ):
 *   base 100 − hard_brake_count×3 − hard_turn_count×2 − hard_accel_count×2
 *   (100km'ye normalize), 0'ın altına düşmez.
 * <10km mesafe varsa skor hesaplanmaz (score_note: "insufficient_distance").
 *
 * @param {Object} row - { total_km, hard_brake_count, hard_turn_count, hard_accel_count }
 * @returns {{driving_score: number|null, score_note: string|null}}
 */
function computeDrivingScore(row) {
  const km = parseFloat(row.total_km) || 0;

  if (km < MIN_KM_FOR_SCORE) {
    return { driving_score: null, score_note: "insufficient_distance" };
  }

  const per100km = 100 / km;
  const penalty =
    ((row.hard_brake_count || 0) * 3 +
      (row.hard_turn_count || 0) * 2 +
      (row.hard_accel_count || 0) * 2) *
    per100km;

  return {
    driving_score: Math.max(0, Math.round(100 - penalty)),
    score_note: null,
  };
}

/**
 * Güncel ve önceki dönem skorları arasındaki farkı hesaplar.
 *
 * Cem'in "yarım dönem" gereksinimi: önceki dönem skoru null'sa (yeni
 * sürücü, henüz sistemde değildi, veya önceki dönemde <10km) bu bir "skor
 * düşüşü" DEĞİLDİR — delta/trend null kalır, trend_note ile işaretlenir.
 * Güncel skor null'sa (bu dönem <10km) zaten score_note bunu açıklıyor,
 * ekstra trend_note eklenmez.
 *
 * @param {number|null} currentScore
 * @param {number|null} previousScore
 * @returns {{previous_driving_score: number|null, score_delta: number|null, trend: "up"|"down"|"same"|null, trend_note: string|null}}
 */
function computeScoreDelta(currentScore, previousScore) {
  if (currentScore === null || currentScore === undefined) {
    return {
      previous_driving_score: previousScore ?? null,
      score_delta: null,
      trend: null,
      trend_note: null,
    };
  }

  if (previousScore === null || previousScore === undefined) {
    return {
      previous_driving_score: null,
      score_delta: null,
      trend: null,
      trend_note: "insufficient_history",
    };
  }

  const score_delta = currentScore - previousScore;
  const trend = score_delta > 0 ? "up" : score_delta < 0 ? "down" : "same";

  return {
    previous_driving_score: previousScore,
    score_delta,
    trend,
    trend_note: null,
  };
}

/**
 * Belirli bir [from, to) dönemi için şirketin TÜM sürücülerinin görev +
 * alert ham verisini döner (LEFT JOIN ile görevi olmayan sürücüler de
 * dahil — "yeni sürücü" senaryosu için gerekli).
 *
 * Üst sınır artık NOW() DEĞİL, `to` parametresi — önceki dönem sorgusu
 * kendi dönem sonuna kadar veri toplar (eski davranıştaki NOW() hatası
 * düzeltildi).
 *
 * @param {Object} client - pg client (dışarıdan enjekte edilir, testability)
 * @param {string} companyId
 * @param {string} from - ISO timestamp (dahil)
 * @param {string} to - ISO timestamp (hariç)
 * @returns {Promise<Array>}
 */
async function fetchDriverPerformanceRows(client, companyId, from, to) {
  const { rows } = await client.query(
    `
    SELECT
      d.id as driver_id,
      u.first_name,
      u.last_name,
      u.email,

      COUNT(DISTINCT t.id)::int as total_tasks,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'completed')::int as completed_tasks,
      COUNT(DISTINCT t.id) FILTER (
        WHERE t.status = 'completed'
        AND t.planned_end IS NOT NULL
        AND t.actual_end > t.planned_end + INTERVAL '15 minutes'
      )::int as delayed_tasks,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (t.actual_end - t.actual_start)) / 60
      ) FILTER (
        WHERE t.status = 'completed'
        AND t.actual_start IS NOT NULL
        AND t.actual_end IS NOT NULL
      ))::int as avg_duration_min,

      ROUND(COALESCE(SUM(t.actual_distance_km) FILTER (
        WHERE t.status = 'completed'
      ), 0), 1)::numeric as total_km,

      COUNT(DISTINCT a.id) FILTER (WHERE ${sqlAlertTypeFilter(
        "a.alert_type",
        "HARD_BRAKE"
      )})::int as hard_brake_count,
      COUNT(DISTINCT a.id) FILTER (WHERE ${sqlAlertTypeFilter(
        "a.alert_type",
        "HARD_TURN"
      )})::int as hard_turn_count,
      COUNT(DISTINCT a.id) FILTER (WHERE ${sqlAlertTypeFilter(
        "a.alert_type",
        "HARD_ACCEL"
      )})::int as hard_accel_count,
      COUNT(DISTINCT a.id) FILTER (WHERE ${sqlAlertTypeFilter(
        "a.alert_type",
        "OVERSPEED"
      )})::int as overspeed_count,
      COUNT(DISTINCT a.id) FILTER (WHERE ${sqlAlertTypeFilter(
        "a.alert_type",
        "IMPACT"
      )})::int as impact_count,
      COUNT(DISTINCT a.id)::int as total_alerts

    FROM drivers d
    JOIN users u ON u.id = d.user_id
    LEFT JOIN tasks t ON t.driver_id = d.id
      AND t.created_at >= $2 AND t.created_at < $3
    LEFT JOIN vehicles v ON v.id = d.assigned_vehicle_id
    LEFT JOIN alerts a ON a.vehicle_id = t.vehicle_id
      AND a.created_at >= COALESCE(t.actual_start, $2)
      AND a.created_at <= COALESCE(t.actual_end, $3)
    WHERE d.company_id = $1
    GROUP BY d.id, u.first_name, u.last_name, u.email
    ORDER BY completed_tasks DESC, total_alerts ASC
    `,
    [companyId, from, to]
  );
  return rows;
}

/**
 * Tam sürücü performans raporunu (opsiyonel önceki-dönem karşılaştırmasıyla)
 * üretir. `compareWithPrevious: false` ise eski davranışla birebir aynı
 * tek-dönem yanıtı döner (previous_period alanı response'a hiç eklenmez).
 *
 * @param {Object} client - pg client (dışarıdan enjekte edilir, testability)
 * @param {string} companyId
 * @param {Object} options
 * @param {number} [options.days] - default 30
 * @param {boolean} [options.compareWithPrevious] - default false
 * @param {Date} [options.now] - test edilebilirlik için enjekte edilebilir (default: new Date())
 * @returns {Promise<Object>} data payload (company_name, period, drivers[], [previous_period], limitations[])
 */
async function buildDriverPerformanceReport(client, companyId, options = {}) {
  const days = Number(options.days) || DEFAULT_DAYS;
  const compareWithPrevious = !!options.compareWithPrevious;
  const now = options.now instanceof Date ? options.now : new Date();

  const to = now.toISOString();
  const from = new Date(now.getTime() - days * 86400000).toISOString();

  const companyResult = await client.query(
    `SELECT name FROM companies WHERE id = $1`,
    [companyId]
  );
  const company_name = companyResult.rows[0]?.name || null;

  const currentRows = await fetchDriverPerformanceRows(
    client,
    companyId,
    from,
    to
  );

  let previousRowsByDriverId = null;
  let previousPeriod = null;

  if (compareWithPrevious) {
    const prevTo = from;
    const prevFrom = new Date(
      new Date(from).getTime() - days * 86400000
    ).toISOString();
    const previousRows = await fetchDriverPerformanceRows(
      client,
      companyId,
      prevFrom,
      prevTo
    );
    previousRowsByDriverId = new Map(previousRows.map((r) => [r.driver_id, r]));
    previousPeriod = { days, from: prevFrom, to: prevTo };
  }

  const drivers = currentRows.map((row) => {
    const { driving_score, score_note } = computeDrivingScore(row);
    const base = { ...row, driving_score, score_note };

    if (!compareWithPrevious) {
      return base;
    }

    const prevRow = previousRowsByDriverId.get(row.driver_id);
    const previousScore = prevRow
      ? computeDrivingScore(prevRow).driving_score
      : null;
    const delta = computeScoreDelta(driving_score, previousScore);

    return { ...base, ...delta };
  });

  const result = {
    company_name,
    period: { days, from },
    drivers,
    limitations: [
      "Sürüş skoru taslak formüldür — olay şiddeti (g-force) hesaba katılmıyor",
      "Trafik ve hava koşulları bağlamı yok",
      "GPS mesafesi < 10km olan sürücüler için skor hesaplanmaz",
      "Alert verileri araç bazlıdır — sürücü değişimlerinde geçmiş alertler birden fazla sürücüye atanabilir",
    ],
  };

  if (compareWithPrevious) {
    result.previous_period = previousPeriod;
  }

  return result;
}

module.exports = {
  computeDrivingScore,
  computeScoreDelta,
  fetchDriverPerformanceRows,
  buildDriverPerformanceReport,
  DEFAULT_DAYS,
  MIN_KM_FOR_SCORE,
};
