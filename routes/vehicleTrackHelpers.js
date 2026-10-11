/**
 * routes/vehicleTrackHelpers.js
 * Harita Dokümanı v2 §9.7 uyumlu araç geçmiş rotası (track) sorgu modülü.
 * Test edilebilirlik için veritabanı client'ı dışarıdan enjekte edilir
 * (routes/alertsHelpers.js presedenti).
 *
 * §9.7 bulgusu: eski sorgu `ORDER BY l.time ASC LIMIT N` kullanıyordu.
 * Uzun zaman aralıklarında (N'den fazla nokta varsa) bu, rotanın GÜNCEL/
 * BİTİŞ kısmını sessizce kesiyordu — polyline "doğru yönde" (start→end)
 * çiziliyor gibi görünüyordu ama gerçek bitiş noktasına hiç ulaşmıyordu.
 * Düzeltme: `ORDER BY l.time DESC LIMIT N` ile en SON N noktayı garanti
 * al, sonra ASC sıraya çevir — kesilme olacaksa artık eski uçtan olur.
 */

const DEFAULT_LIMIT = 1000;

/**
 * Bir aracın geçmiş konum noktalarını (track) zaman aralığına göre çeker.
 * @param {Object} client - pg client (dışarıdan enjekte edilir)
 * @param {Object} params - { vehicleId, start, end, limit }
 * @returns {Promise<{points: Array}>} ASC (eski->yeni) sıralı noktalar
 */
async function fetchVehicleTrack(client, params) {
  const { vehicleId, start, end, limit = DEFAULT_LIMIT } = params;

  let query = `
    SELECT l.latitude, l.longitude, l.speed, l.heading, l.time, l.accuracy
    FROM locations l
    JOIN vehicles v ON l.device_id = v.esp32_device_id
    WHERE v.id = $1
  `;
  const queryParams = [vehicleId];
  let paramIndex = 2;

  if (start) {
    query += ` AND l.time >= $${paramIndex}`;
    queryParams.push(start);
    paramIndex++;
  }
  if (end) {
    query += ` AND l.time <= $${paramIndex}`;
    queryParams.push(end);
    paramIndex++;
  }

  // §9.7: DESC + LIMIT -> en SON N nokta garanti (rotanın bitişi korunur).
  // Sonuç JS'te ASC'ye çevrilir (client start->end sırasında bekliyor).
  query += ` ORDER BY l.time DESC LIMIT $${paramIndex}`;
  queryParams.push(parseInt(limit, 10));

  const result = await client.query(query, queryParams);
  return { points: result.rows.slice().reverse() };
}

module.exports = { fetchVehicleTrack, DEFAULT_LIMIT };
