'use strict';

/**
 * TulipFleet - Fuel Management Routes
 * Yakıt Analiz & Tasarruf Modülü API
 * 
 * NOT: users tablosunda 'name' yerine 'first_name' ve 'last_name' var
 */

module.exports = async function (fastify, opts) {
  
  // ============================================
  // DRIVER ENDPOINTS (Minimal)
  // ============================================
  
  /**
   * POST /records
   * Yeni yakıt kaydı ekle (Driver)
   */
  fastify.post('/records', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { user } = request;
    const { vehicle_id, odometer_km, liters_filled, price_per_liter, total_cost, station_name, is_full_tank, currency } = request.body;
    
    try {
      // 1. Driver'ın şirketini ve araç bilgisini al
      const vehicleResult = await fastify.pg.query(`
        SELECT v.id, v.company_id, v.fuel_capacity, v.fuel_type, v.plate_no
        FROM vehicles v
        JOIN drivers d ON d.assigned_vehicle_id = v.id
        WHERE d.user_id = $1 AND v.id = $2
      `, [user.id, vehicle_id]);
      
      if (vehicleResult.rows.length === 0) {
        return reply.status(403).send({ error: 'Bu araca erişim yetkiniz yok' });
      }
      
      const vehicle = vehicleResult.rows[0];
      
      // 2. Validation - NULL kontrolü ekle
      const tankCapacity = parseFloat(vehicle.fuel_capacity) || 60;  // Varsayılan 60L
      if (liters_filled > tankCapacity) {
        return reply.status(400).send({ 
          error: `Maksimum ${tankCapacity}L girebilirsiniz` 
        });
      }
      
      // 3. Son kaydı bul
      const lastRecordResult = await fastify.pg.query(`
        SELECT odometer_km, record_date 
        FROM fuel_records 
        WHERE vehicle_id = $1 
        ORDER BY record_date DESC, created_at DESC 
        LIMIT 1
      `, [vehicle_id]);
      
      const lastRecord = lastRecordResult.rows[0];
      
      // 4. KM validation
      if (lastRecord && odometer_km <= lastRecord.odometer_km) {
        return reply.status(400).send({ 
          error: `KM sayacı önceki kayıttan (${lastRecord.odometer_km}) büyük olmalı` 
        });
      }
      
      // 5. Hesaplamalar (sadece FULL tank ise)
      let km_traveled = null;
      let consumption_per_100km = null;
      let cost_per_km = null;
      
      if (is_full_tank !== false && lastRecord && odometer_km > lastRecord.odometer_km) {
        km_traveled = odometer_km - lastRecord.odometer_km;
        consumption_per_100km = (liters_filled / km_traveled) * 100;
        
        if (total_cost) {
          cost_per_km = total_cost / km_traveled;
        }
        
        // Mantıklı tüketim kontrolü
        if (consumption_per_100km < 1 || consumption_per_100km > 30) {
          return reply.status(400).send({ 
            error: `Hesaplanan tüketim (${consumption_per_100km.toFixed(1)} L/100km) mantıksız görünüyor` 
          });
        }
      }
      
      // 6. Driver ID'yi bul
      const driverResult = await fastify.pg.query(`
        SELECT id FROM drivers WHERE user_id = $1
      `, [user.id]);
      
      const driver_id = driverResult.rows[0]?.id;
      
      // 7. Kaydet
      const insertResult = await fastify.pg.query(`
        INSERT INTO fuel_records 
        (company_id, vehicle_id, driver_id, odometer_km, liters_filled, 
         price_per_liter, total_cost, station_name, is_full_tank,
         km_traveled, consumption_per_100km, cost_per_km, currency)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `, [
        vehicle.company_id, vehicle_id, driver_id, odometer_km, liters_filled,
        price_per_liter || null, total_cost || null, station_name || null, 
        is_full_tank !== false,
        km_traveled, consumption_per_100km ? consumption_per_100km.toFixed(2) : null, 
        cost_per_km ? cost_per_km.toFixed(3) : null,
        currency || 'TRY'
      ]);
      
      // 8. Baseline güncelle (gerekirse)
      await updateBaselineIfNeeded(fastify, vehicle.company_id);
      
      return reply.send({
        success: true,
        data: {
          ...insertResult.rows[0],
          vehicle_plate: vehicle.plate_no
        }
      });
      
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Kayıt eklenirken hata oluştu' });
    }
  });
  
  
  /**
   * GET /last-record/:vehicleId
   * Son KM bilgisi (Driver form için)
   */
  fastify.get('/last-record/:vehicleId', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { vehicleId } = request.params;
    
    try {
      const result = await fastify.pg.query(`
        SELECT odometer_km, record_date, liters_filled, consumption_per_100km
        FROM fuel_records 
        WHERE vehicle_id = $1 
        ORDER BY record_date DESC, created_at DESC 
        LIMIT 1
      `, [vehicleId]);
      
      if (result.rows.length === 0) {
        return reply.send({ data: null });
      }
      
      return reply.send({ data: result.rows[0] });
      
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Veri alınamadı' });
    }
  });
  
  
  // ============================================
  // ADMIN ENDPOINTS (Detaylı)
  // ============================================
  
  /**
   * GET /company/records
   * Tüm şirket yakıt kayıtları (Admin)
   */
  fastify.get('/company/records', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { user } = request;
    const { page = 1, limit = 50, vehicle_id, driver_id, from_date, to_date } = request.query;
    const offset = (page - 1) * limit;
    
    // Admin kontrolü
    if (user.role !== 'company_admin' && user.role !== 'super_admin') {
      return reply.status(403).send({ error: 'Admin access required' });
    }
    
    try {
      let whereClause = 'WHERE fr.company_id = $1';
      const params = [user.company_id];
      let paramIndex = 2;
      
      if (vehicle_id) {
        whereClause += ` AND fr.vehicle_id = $${paramIndex}`;
        params.push(vehicle_id);
        paramIndex++;
      }
      
      if (driver_id) {
        whereClause += ` AND fr.driver_id = $${paramIndex}`;
        params.push(driver_id);
        paramIndex++;
      }
      
      if (from_date) {
        whereClause += ` AND fr.record_date >= $${paramIndex}`;
        params.push(from_date);
        paramIndex++;
      }
      
      if (to_date) {
        whereClause += ` AND fr.record_date <= $${paramIndex}`;
        params.push(to_date);
        paramIndex++;
      }
      
      const result = await fastify.pg.query(`
        SELECT 
          fr.*,
          v.plate_no,
          v.fuel_type,
          COALESCE(u.first_name || ' ' || u.last_name, u.first_name, 'İsimsiz') as driver_name
        FROM fuel_records fr
        LEFT JOIN vehicles v ON v.id = fr.vehicle_id
        LEFT JOIN drivers d ON d.id = fr.driver_id
        LEFT JOIN users u ON u.id = d.user_id
        ${whereClause}
        ORDER BY fr.record_date DESC, fr.created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `, [...params, limit, offset]);
      
      // Toplam kayıt sayısı
      const countResult = await fastify.pg.query(`
        SELECT COUNT(*) as total 
        FROM fuel_records fr 
        ${whereClause}
      `, params);
      
      return reply.send({
        data: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countResult.rows[0].total)
        }
      });
      
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Veri alınamadı' });
    }
  });
  
  
  /**
   * GET /company/analytics
   * Filo analizi + skorlar (Admin Dashboard)
   */
  fastify.get('/company/analytics', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { user } = request;
    
    // Admin kontrolü
    if (user.role !== 'company_admin' && user.role !== 'super_admin') {
      return reply.status(403).send({ error: 'Admin access required' });
    }
    
    try {
      // 1. Genel istatistikler
      const statsResult = await fastify.pg.query(`
        SELECT 
          COUNT(DISTINCT vehicle_id) as total_vehicles,
          COUNT(*) as total_records,
          SUM(liters_filled) as total_liters,
          SUM(total_cost) as total_cost,
          AVG(consumption_per_100km) FILTER (WHERE consumption_per_100km IS NOT NULL) as avg_consumption,
          SUM(km_traveled) as total_km
        FROM fuel_records
        WHERE company_id = $1
          AND record_date >= CURRENT_DATE - INTERVAL '30 days'
      `, [user.company_id]);
      
      // 2. Araç bazlı analiz (verimlilik sıralaması)
      const vehicleStatsResult = await fastify.pg.query(`
        SELECT 
          v.id as vehicle_id,
          v.plate_no,
          v.fuel_type,
          COALESCE(u.first_name || ' ' || u.last_name, u.first_name, 'Atanmamış') as driver_name,
          COUNT(fr.id) as record_count,
          AVG(fr.consumption_per_100km) as avg_consumption,
          STDDEV(fr.consumption_per_100km) as std_consumption,
          SUM(fr.liters_filled) as total_liters,
          SUM(fr.total_cost) as total_cost,
          SUM(fr.km_traveled) as total_km,
          -- Stabilite skoru
          CASE 
            WHEN AVG(fr.consumption_per_100km) > 0 
            THEN 1 - (COALESCE(STDDEV(fr.consumption_per_100km), 0) / AVG(fr.consumption_per_100km))
            ELSE NULL 
          END as stability_score
        FROM vehicles v
        LEFT JOIN fuel_records fr ON fr.vehicle_id = v.id 
          AND fr.consumption_per_100km IS NOT NULL
          AND fr.record_date >= CURRENT_DATE - INTERVAL '90 days'
        LEFT JOIN drivers d ON d.assigned_vehicle_id = v.id
        LEFT JOIN users u ON u.id = d.user_id
        WHERE v.company_id = $1
        GROUP BY v.id, v.plate_no, v.fuel_type, u.first_name, u.last_name
        ORDER BY avg_consumption ASC NULLS LAST
      `, [user.company_id]);
      
      // 3. Filo ortalaması
      const fleetAvg = parseFloat(statsResult.rows[0].avg_consumption) || 0;
      
      // 4. Araçları işle ve anomali tespiti yap
      const vehicles = vehicleStatsResult.rows.map(v => {
        const avgConsumption = parseFloat(v.avg_consumption) || 0;
        const deviation = fleetAvg > 0 ? ((avgConsumption - fleetAvg) / fleetAvg) * 100 : 0;
        
        return {
          ...v,
          avg_consumption: avgConsumption ? avgConsumption.toFixed(2) : null,
          stability_score: v.stability_score ? parseFloat(v.stability_score).toFixed(2) : null,
          deviation_percent: deviation.toFixed(1),
          is_anomaly: deviation > 20,
          performance: deviation < -10 ? 'excellent' : deviation < 0 ? 'good' : deviation < 20 ? 'average' : 'poor'
        };
      });
      
      // 5. CO2 emisyonu hesapla (dizel: 2.68 kg/L)
      const totalLiters = parseFloat(statsResult.rows[0].total_liters) || 0;
      const co2_emissions = totalLiters * 2.68;
      
      return reply.send({
        data: {
          summary: {
            total_vehicles: parseInt(statsResult.rows[0].total_vehicles) || 0,
            total_records: parseInt(statsResult.rows[0].total_records) || 0,
            total_liters: totalLiters.toFixed(2),
            total_cost: parseFloat(statsResult.rows[0].total_cost || 0).toFixed(2),
            avg_consumption: fleetAvg.toFixed(2),
            total_km: parseInt(statsResult.rows[0].total_km) || 0,
            co2_emissions_kg: co2_emissions.toFixed(2)
          },
          vehicles,
          alerts: vehicles.filter(v => v.is_anomaly)
        }
      });
      
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Analiz verisi alınamadı' });
    }
  });
  
  
  /**
   * GET /company/savings
   * ROI / Tasarruf raporu (Admin)
   */
  fastify.get('/company/savings', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { user } = request;
    
    // Admin kontrolü
    if (user.role !== 'company_admin' && user.role !== 'super_admin') {
      return reply.status(403).send({ error: 'Admin access required' });
    }
    
    try {
      // 1. Baseline al
      const baselineResult = await fastify.pg.query(`
        SELECT * FROM company_fuel_baseline WHERE company_id = $1
      `, [user.company_id]);
      
      const baseline = baselineResult.rows[0];
      
      if (!baseline || !baseline.baseline_consumption) {
        return reply.send({
          data: {
            has_baseline: false,
            message: 'Henüz yeterli veri yok. En az 10 kayıt gerekli.'
          }
        });
      }
      
      // 2. Güncel ortalama
      const currentResult = await fastify.pg.query(`
        SELECT 
          AVG(consumption_per_100km) as current_consumption,
          AVG(cost_per_km) as current_cost_per_km,
          SUM(km_traveled) as total_km,
          SUM(liters_filled) as total_liters,
          SUM(total_cost) as total_cost,
          COUNT(*) as record_count
        FROM fuel_records
        WHERE company_id = $1
          AND consumption_per_100km IS NOT NULL
          AND record_date > $2
      `, [user.company_id, baseline.baseline_date]);
      
      const current = currentResult.rows[0];
      const baselineConsumption = parseFloat(baseline.baseline_consumption);
      const currentConsumption = parseFloat(current.current_consumption) || baselineConsumption;
      const totalKm = parseInt(current.total_km) || 0;
      
      // 3. Tasarruf hesapla
      const consumptionImprovement = ((baselineConsumption - currentConsumption) / baselineConsumption) * 100;
      const litersPerKmSaved = (baselineConsumption - currentConsumption) / 100;
      const litersSaved = litersPerKmSaved * totalKm;
      
      // Yakıt fiyatı tahmini (ortalama)
      const avgFuelPrice = current.total_liters > 0 
        ? parseFloat(current.total_cost) / parseFloat(current.total_liters) 
        : 42; // Varsayılan
      
      const moneySaved = litersSaved * avgFuelPrice;
      const co2Saved = litersSaved * 2.68;
      
      // 4. Aylık trend
      const trendResult = await fastify.pg.query(`
        SELECT 
          TO_CHAR(record_date, 'YYYY-MM') as month,
          AVG(consumption_per_100km) as avg_consumption,
          SUM(km_traveled) as total_km,
          SUM(total_cost) as total_cost
        FROM fuel_records
        WHERE company_id = $1
          AND consumption_per_100km IS NOT NULL
          AND record_date >= CURRENT_DATE - INTERVAL '6 months'
        GROUP BY TO_CHAR(record_date, 'YYYY-MM')
        ORDER BY month ASC
      `, [user.company_id]);
      
      // 5. Kümülatif tasarruf hesapla
      let cumulativeSavings = 0;
      const monthlyTrend = trendResult.rows.map(m => {
        const monthConsumption = parseFloat(m.avg_consumption);
        const monthKm = parseInt(m.total_km) || 0;
        const monthSavingsLiters = ((baselineConsumption - monthConsumption) / 100) * monthKm;
        const monthSavingsMoney = monthSavingsLiters * avgFuelPrice;
        cumulativeSavings += monthSavingsMoney;
        
        return {
          month: m.month,
          avg_consumption: monthConsumption.toFixed(2),
          total_km: monthKm,
          savings: monthSavingsMoney.toFixed(2),
          cumulative_savings: cumulativeSavings.toFixed(2)
        };
      });
      
      // 6. Yıllık projeksiyon
      const monthsActive = trendResult.rows.length || 1;
      const avgMonthlySavings = moneySaved / monthsActive;
      const yearlyProjection = avgMonthlySavings * 12;
      
      return reply.send({
        data: {
          has_baseline: true,
          baseline: {
            date: baseline.baseline_date,
            consumption: baselineConsumption.toFixed(2),
            records_used: baseline.total_records
          },
          current: {
            consumption: currentConsumption.toFixed(2),
            total_km: totalKm,
            total_liters: parseFloat(current.total_liters || 0).toFixed(2),
            total_cost: parseFloat(current.total_cost || 0).toFixed(2),
            record_count: parseInt(current.record_count) || 0
          },
          savings: {
            consumption_improvement_percent: consumptionImprovement.toFixed(1),
            liters_saved: litersSaved.toFixed(2),
            money_saved: moneySaved.toFixed(2),
            co2_saved_kg: co2Saved.toFixed(2),
            yearly_projection: yearlyProjection.toFixed(2)
          },
          trend: monthlyTrend
        }
      });
      
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Tasarruf verisi alınamadı' });
    }
  });
  
  
  /**
   * GET /vehicle/:id
   * Araç detay analizi (Admin)
   */
  fastify.get('/vehicle/:id', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { user } = request;
    const { id } = request.params;
    const companyId = request.companyId || user.company_id;
    const hasCompanyFilter = !!companyId;
    
    // Admin kontrolü
    if (user.role !== 'company_admin' && user.role !== 'super_admin') {
      return reply.status(403).send({ error: 'Admin access required' });
    }
    
    try {
      // 1. Araç bilgisi
      const baseSql = `
        SELECT 
          v.*, 
          COALESCE(u.first_name || ' ' || u.last_name, u.email, 'Atanmamış') as driver_name
        FROM vehicles v
        LEFT JOIN drivers d ON d.assigned_vehicle_id = v.id
        LEFT JOIN users u ON u.id = d.user_id
        WHERE v.id = $1`;
      const sql = hasCompanyFilter ? baseSql + ` AND v.company_id = $2` : baseSql;
      const params = hasCompanyFilter ? [id, companyId] : [id];
      const vehicleResult = await fastify.pg.query(sql, params);
      
      if (vehicleResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Araç bulunamadı' });
      }
      
      const vehicle = vehicleResult.rows[0];
      
      // 2. Yakıt istatistikleri
      const statsResult = await fastify.pg.query(`
        SELECT 
          COUNT(*) as record_count,
          AVG(consumption_per_100km) as avg_consumption,
          STDDEV(consumption_per_100km) as std_consumption,
          MIN(consumption_per_100km) as min_consumption,
          MAX(consumption_per_100km) as max_consumption,
          SUM(liters_filled) as total_liters,
          SUM(total_cost) as total_cost,
          SUM(km_traveled) as total_km,
          COUNT(*) FILTER (WHERE total_cost IS NOT NULL) as records_with_cost
        FROM fuel_records
        WHERE vehicle_id = $1
          AND consumption_per_100km IS NOT NULL
      `, [id]);
      
      const stats = statsResult.rows[0];
      
      // 3. Integrity Score hesapla
      const integrityScore = await calculateIntegrityScore(fastify, id);
      
      // 4. Son 10 kayıt
      const recentResult = await fastify.pg.query(`
        SELECT *
        FROM fuel_records
        WHERE vehicle_id = $1
        ORDER BY record_date DESC, created_at DESC
        LIMIT 10
      `, [id]);
      
      // 5. 6 aylık trend
      const trendResult = await fastify.pg.query(`
        SELECT 
          TO_CHAR(record_date, 'YYYY-MM') as month,
          AVG(consumption_per_100km) as avg_consumption,
          SUM(km_traveled) as total_km,
          COUNT(*) as record_count
        FROM fuel_records
        WHERE vehicle_id = $1
          AND consumption_per_100km IS NOT NULL
          AND record_date >= CURRENT_DATE - INTERVAL '6 months'
        GROUP BY TO_CHAR(record_date, 'YYYY-MM')
        ORDER BY month ASC
      `, [id]);
      
      // 6. Stabilite skoru
      const avgConsumption = parseFloat(stats.avg_consumption) || 0;
      const stdConsumption = parseFloat(stats.std_consumption) || 0;
      const stabilityScore = avgConsumption > 0 
        ? (1 - (stdConsumption / avgConsumption)).toFixed(2) 
        : null;
      
      return reply.send({
        data: {
          vehicle: {
            id: vehicle.id,
            plate_no: vehicle.plate_no,
            fuel_type: vehicle.fuel_type,
            fuel_capacity: vehicle.fuel_capacity,
            driver_name: vehicle.driver_name
          },
          stats: {
            record_count: parseInt(stats.record_count) || 0,
            avg_consumption: avgConsumption.toFixed(2),
            min_consumption: parseFloat(stats.min_consumption || 0).toFixed(2),
            max_consumption: parseFloat(stats.max_consumption || 0).toFixed(2),
            total_liters: parseFloat(stats.total_liters || 0).toFixed(2),
            total_cost: parseFloat(stats.total_cost || 0).toFixed(2),
            total_km: parseInt(stats.total_km) || 0,
            data_completeness: stats.record_count > 0 
              ? ((parseInt(stats.records_with_cost) / parseInt(stats.record_count)) * 100).toFixed(0)
              : 0
          },
          scores: {
            integrity: integrityScore,
            stability: stabilityScore
          },
          recent_records: recentResult.rows,
          trend: trendResult.rows.map(t => ({
            month: t.month,
            avg_consumption: parseFloat(t.avg_consumption).toFixed(2),
            total_km: parseInt(t.total_km) || 0,
            record_count: parseInt(t.record_count) || 0
          }))
        }
      });
      
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Araç verisi alınamadı' });
    }
  });
  
  
  /**
   * GET /alerts
   * Dikkat gerektiren araçlar (Admin)
   */
  fastify.get('/alerts', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { user } = request;
    
    // Admin kontrolü
    if (user.role !== 'company_admin' && user.role !== 'super_admin') {
      return reply.status(403).send({ error: 'Admin access required' });
    }
    
    try {
      // Filo ortalaması
      const avgResult = await fastify.pg.query(`
        SELECT AVG(consumption_per_100km) as fleet_avg
        FROM fuel_records
        WHERE company_id = $1
          AND consumption_per_100km IS NOT NULL
          AND record_date >= CURRENT_DATE - INTERVAL '90 days'
      `, [user.company_id]);
      
      const fleetAvg = parseFloat(avgResult.rows[0].fleet_avg) || 10;
      
      // Anomali tespiti
      const alertsResult = await fastify.pg.query(`
        SELECT 
          v.id as vehicle_id,
          v.plate_no,
          COALESCE(u.first_name || ' ' || u.last_name, u.first_name, 'Atanmamış') as driver_name,
          fr.consumption_per_100km as last_consumption,
          fr.record_date as last_date,
          (
            SELECT AVG(consumption_per_100km)
            FROM fuel_records
            WHERE vehicle_id = v.id
              AND consumption_per_100km IS NOT NULL
              AND record_date >= CURRENT_DATE - INTERVAL '30 days'
          ) as vehicle_avg,
          (
            SELECT COUNT(*)
            FROM fuel_records
            WHERE vehicle_id = v.id
              AND total_cost IS NULL
              AND record_date >= CURRENT_DATE - INTERVAL '30 days'
          ) as missing_cost_count
        FROM vehicles v
        LEFT JOIN drivers d ON d.assigned_vehicle_id = v.id
        LEFT JOIN users u ON u.id = d.user_id
        LEFT JOIN LATERAL (
          SELECT consumption_per_100km, record_date
          FROM fuel_records
          WHERE vehicle_id = v.id
          ORDER BY record_date DESC, created_at DESC
          LIMIT 1
        ) fr ON true
        WHERE v.company_id = $1
      `, [user.company_id]);
      
      const alerts = [];
      
      alertsResult.rows.forEach(row => {
        const vehicleAvg = parseFloat(row.vehicle_avg) || 0;
        const lastConsumption = parseFloat(row.last_consumption) || 0;
        const deviation = fleetAvg > 0 ? ((vehicleAvg - fleetAvg) / fleetAvg) * 100 : 0;
        
        // Yüksek tüketim uyarısı
        if (deviation > 20) {
          alerts.push({
            type: 'high_consumption',
            severity: 'warning',
            vehicle_id: row.vehicle_id,
            plate_no: row.plate_no,
            driver_name: row.driver_name,
            message: `Filo ortalamasının %${deviation.toFixed(0)} üzerinde tüketim`,
            value: vehicleAvg.toFixed(2),
            fleet_avg: fleetAvg.toFixed(2)
          });
        }
        
        // Eksik veri uyarısı
        if (row.missing_cost_count > 3) {
          alerts.push({
            type: 'missing_data',
            severity: 'info',
            vehicle_id: row.vehicle_id,
            plate_no: row.plate_no,
            driver_name: row.driver_name,
            message: `${row.missing_cost_count} kayıtta fiyat bilgisi eksik`,
            value: row.missing_cost_count
          });
        }
      });
      
      return reply.send({ 
        data: alerts.sort((a, b) => {
          const severityOrder = { warning: 0, info: 1 };
          return severityOrder[a.severity] - severityOrder[b.severity];
        })
      });
      
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Uyarılar alınamadı' });
    }
  });
  
};


// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Baseline güncelleme (ilk 10 kayıttan sonra)
 */
async function updateBaselineIfNeeded(fastify, companyId) {
  try {
    // Mevcut baseline var mı?
    const existingBaseline = await fastify.pg.query(`
      SELECT * FROM company_fuel_baseline WHERE company_id = $1
    `, [companyId]);
    
    if (existingBaseline.rows.length > 0) {
      return; // Zaten var, güncelleme
    }
    
    // Kayıt sayısını kontrol et
    const countResult = await fastify.pg.query(`
      SELECT COUNT(*) as count
      FROM fuel_records
      WHERE company_id = $1 AND consumption_per_100km IS NOT NULL
    `, [companyId]);
    
    const recordCount = parseInt(countResult.rows[0].count);
    
    if (recordCount < 10) {
      return; // Henüz yeterli veri yok
    }
    
    // Baseline hesapla (ilk 10 kayıttan)
    const baselineResult = await fastify.pg.query(`
      SELECT 
        AVG(consumption_per_100km) as avg_consumption,
        AVG(cost_per_km) as avg_cost_per_km,
        MIN(record_date) as first_date
      FROM (
        SELECT consumption_per_100km, cost_per_km, record_date
        FROM fuel_records
        WHERE company_id = $1 AND consumption_per_100km IS NOT NULL
        ORDER BY record_date ASC, created_at ASC
        LIMIT 10
      ) first_records
    `, [companyId]);
    
    const baseline = baselineResult.rows[0];
    
    // Baseline kaydet
    await fastify.pg.query(`
      INSERT INTO company_fuel_baseline 
      (company_id, baseline_date, baseline_consumption, baseline_cost_per_km, total_records)
      VALUES ($1, $2, $3, $4, 10)
    `, [
      companyId, 
      baseline.first_date,
      baseline.avg_consumption,
      baseline.avg_cost_per_km
    ]);
    
    fastify.log.info(`Baseline created for company ${companyId}: ${baseline.avg_consumption} L/100km`);
    
  } catch (error) {
    fastify.log.error('Baseline update error:', error);
  }
}


/**
 * Fuel Integrity Score hesaplama
 */
async function calculateIntegrityScore(fastify, vehicleId) {
  try {
    // 1. KM tutarlılığı
    const kmResult = await fastify.pg.query(`
      WITH ordered AS (
        SELECT odometer_km,
               LAG(odometer_km) OVER (ORDER BY record_date, created_at) as prev_km
        FROM fuel_records
        WHERE vehicle_id = $1
      )
      SELECT 
        COUNT(*) FILTER (WHERE odometer_km > prev_km OR prev_km IS NULL) as consistent,
        COUNT(*) as total
      FROM ordered
    `, [vehicleId]);
    
    const kmConsistency = kmResult.rows[0].total > 0
      ? (kmResult.rows[0].consistent / kmResult.rows[0].total) * 100
      : 100;
    
    // 2. Tüketim varyansı
    const varianceResult = await fastify.pg.query(`
      SELECT 
        AVG(consumption_per_100km) as avg,
        STDDEV(consumption_per_100km) as std
      FROM fuel_records
      WHERE vehicle_id = $1 AND consumption_per_100km IS NOT NULL
    `, [vehicleId]);
    
    const avg = parseFloat(varianceResult.rows[0].avg) || 1;
    const std = parseFloat(varianceResult.rows[0].std) || 0;
    const cv = std / avg; // Coefficient of variation
    
    let varianceScore;
    if (cv < 0.1) varianceScore = 100;
    else if (cv < 0.2) varianceScore = 80;
    else if (cv < 0.3) varianceScore = 60;
    else varianceScore = 40;
    
    // 3. Veri tamlığı
    const completenessResult = await fastify.pg.query(`
      SELECT 
        COUNT(*) FILTER (WHERE total_cost IS NOT NULL) as with_cost,
        COUNT(*) as total
      FROM fuel_records
      WHERE vehicle_id = $1
    `, [vehicleId]);
    
    const completeness = completenessResult.rows[0].total > 0
      ? (completenessResult.rows[0].with_cost / completenessResult.rows[0].total) * 100
      : 0;
    
    // Ağırlıklı toplam
    const totalScore = (kmConsistency * 0.4) + (varianceScore * 0.35) + (completeness * 0.25);
    
    // Grade
    let grade;
    if (totalScore >= 90) grade = 'A';
    else if (totalScore >= 75) grade = 'B';
    else if (totalScore >= 60) grade = 'C';
    else grade = 'D';
    
    return {
      total: Math.round(totalScore),
      grade,
      breakdown: {
        km_consistency: Math.round(kmConsistency),
        consumption_variance: Math.round(varianceScore),
        data_completeness: Math.round(completeness)
      }
    };
    
  } catch (error) {
    return { total: 0, grade: 'N/A', breakdown: {} };
  }
}