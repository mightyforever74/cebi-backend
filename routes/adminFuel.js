'use strict';

/**
 * TulipFleet - Admin Fuel & Carbon Management Routes
 * Fastify Format
 * Updated: 22 Ocak 2026
 */

// CO2 emission factors (kg CO2 per liter)
const CO2_FACTORS = {
  diesel: 2.64,
  gasoline: 2.31,
  petrol: 2.31,
  lpg: 1.51,
  cng: 2.75,
  electric: 0
};

// EU Commercial Vehicle Limit (g/km) - 2026
const EU_LIMIT_G_PER_KM = 225;

module.exports = async function(fastify, opts) {
  
  // ============================================
  // FUEL ENDPOINTS
  // ============================================

  /**
   * GET /api/admin/fuel/stats
   * Şirket geneli yakıt istatistikleri
   */
  fastify.get('/fuel/stats', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { company_id, role } = request.user;
      
      if (role !== 'company_admin' && role !== 'super_admin') {
        return reply.code(403).send({ success: false, error: 'Yetkisiz erişim' });
      }

      // Bu ay
      const currentMonthStart = new Date();
      currentMonthStart.setDate(1);
      currentMonthStart.setHours(0, 0, 0, 0);
      
      // Geçen ay
      const lastMonthStart = new Date(currentMonthStart);
      lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
      const lastMonthEnd = new Date(currentMonthStart);
      lastMonthEnd.setSeconds(lastMonthEnd.getSeconds() - 1);

      // Bu ay istatistikleri
      const currentStats = await client.query(`
        SELECT 
          COALESCE(SUM(liters_filled), 0) as total_liters,
          COALESCE(SUM(total_cost), 0) as total_cost,
          COALESCE(SUM(km_traveled), 0) as total_distance,
          COALESCE(AVG(consumption_per_100km), 0) as avg_consumption,
          COUNT(*) as record_count
        FROM fuel_records
        WHERE company_id = $1 AND record_date >= $2
      `, [company_id, currentMonthStart]);

      // Geçen ay istatistikleri
      const lastStats = await client.query(`
        SELECT 
          COALESCE(SUM(liters_filled), 0) as total_liters,
          COALESCE(SUM(total_cost), 0) as total_cost,
          COALESCE(SUM(km_traveled), 0) as total_distance,
          COALESCE(AVG(consumption_per_100km), 0) as avg_consumption
        FROM fuel_records
        WHERE company_id = $1 AND record_date >= $2 AND record_date <= $3
      `, [company_id, lastMonthStart, lastMonthEnd]);

      const current = currentStats.rows[0];
      const last = lastStats.rows[0];

      // Yüzde değişim hesapla
      const calcChange = (curr, prev) => {
        if (!prev || prev == 0) return 0;
        return Math.round(((curr - prev) / prev) * 100);
      };

      return reply.send({
        success: true,
        data: {
          totalLiters: parseFloat(current.total_liters) || 0,
          totalCost: parseFloat(current.total_cost) || 0,
          totalDistance: parseFloat(current.total_distance) || 0,
          averageConsumption: parseFloat(current.avg_consumption).toFixed(1) || '0',
          recordCount: parseInt(current.record_count) || 0,
          previousMonth: {
            totalLiters: parseFloat(last.total_liters) || 0,
            totalCost: parseFloat(last.total_cost) || 0,
            totalDistance: parseFloat(last.total_distance) || 0,
            averageConsumption: parseFloat(last.avg_consumption).toFixed(1) || '0'
          },
          percentageChange: {
            liters: calcChange(current.total_liters, last.total_liters),
            cost: calcChange(current.total_cost, last.total_cost),
            distance: calcChange(current.total_distance, last.total_distance),
            consumption: calcChange(current.avg_consumption, last.avg_consumption)
          }
        }
      });
    } catch (error) {
      fastify.log.error('Fuel stats error:', error);
      return reply.code(500).send({ success: false, error: 'Yakıt istatistikleri alınamadı' });
    } finally {
      client.release();
    }
  });

  /**
   * GET /api/admin/fuel/trends
   * Aylık yakıt trend verileri
   */
  fastify.get('/fuel/trends', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { company_id, role } = request.user;
      
      if (role !== 'company_admin' && role !== 'super_admin') {
        return reply.code(403).send({ success: false, error: 'Yetkisiz erişim' });
      }

      const months = parseInt(request.query.months) || 6;

      const result = await client.query(`
        SELECT 
          TO_CHAR(record_date, 'YYYY-MM') as month,
          TO_CHAR(record_date, 'Mon') as month_name,
          COALESCE(SUM(liters_filled), 0) as total_liters,
          COALESCE(SUM(total_cost), 0) as total_cost,
          COALESCE(AVG(consumption_per_100km), 0) as avg_consumption,
          COALESCE(SUM(km_traveled), 0) as total_km
        FROM fuel_records
        WHERE company_id = $1 
          AND record_date >= NOW() - INTERVAL '${months} months'
        GROUP BY TO_CHAR(record_date, 'YYYY-MM'), TO_CHAR(record_date, 'Mon')
        ORDER BY month ASC
      `, [company_id]);

      const trends = result.rows.map(row => ({
        month: row.month,
        monthName: row.month_name,
        liters: parseFloat(row.total_liters) || 0,
        cost: parseFloat(row.total_cost) || 0,
        consumption: parseFloat(row.avg_consumption).toFixed(1) || '0',
        distance: parseFloat(row.total_km) || 0
      }));

      return reply.send({
        success: true,
        data: trends
      });
    } catch (error) {
      fastify.log.error('Fuel trends error:', error);
      return reply.code(500).send({ success: false, error: 'Trend verileri alınamadı' });
    } finally {
      client.release();
    }
  });

  /**
   * GET /api/admin/fuel/vehicles
   * Araç bazlı yakıt verileri
   */
  fastify.get('/fuel/vehicles', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { company_id, role } = request.user;
      
      if (role !== 'company_admin' && role !== 'super_admin') {
        return reply.code(403).send({ success: false, error: 'Yetkisiz erişim' });
      }

      const result = await client.query(`
        SELECT 
          v.id,
          v.plate_no,
          v.brand,
          v.model,
          v.fuel_type,
          COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '') as driver_name,
          COALESCE(SUM(fr.liters_filled), 0) as total_liters,
          COALESCE(SUM(fr.total_cost), 0) as total_cost,
          COALESCE(SUM(fr.km_traveled), 0) as total_km,
          COALESCE(AVG(fr.consumption_per_100km), 0) as avg_consumption,
          COUNT(fr.id) as record_count
        FROM vehicles v
        LEFT JOIN drivers d ON d.assigned_vehicle_id = v.id
        LEFT JOIN users u ON u.id = d.user_id
        LEFT JOIN fuel_records fr ON fr.vehicle_id = v.id
        WHERE v.company_id = $1
        GROUP BY v.id, v.plate_no, v.brand, v.model, v.fuel_type, u.first_name, u.last_name
        ORDER BY total_liters DESC
      `, [company_id]);

      const vehicles = result.rows.map(row => ({
        id: row.id,
        plateNo: row.plate_no,
        brand: row.brand,
        model: row.model,
        fuelType: row.fuel_type,
        driverName: row.driver_name?.trim() || 'Atanmamış',
        totalLiters: parseFloat(row.total_liters) || 0,
        totalCost: parseFloat(row.total_cost) || 0,
        totalKm: parseFloat(row.total_km) || 0,
        avgConsumption: parseFloat(row.avg_consumption).toFixed(1) || '0',
        recordCount: parseInt(row.record_count) || 0
      }));

      return reply.send({
        success: true,
        data: {
          vehicles,
          count: vehicles.length
        }
      });
    } catch (error) {
      fastify.log.error('Fuel vehicles error:', error);
      return reply.code(500).send({ success: false, error: 'Araç verileri alınamadı' });
    } finally {
      client.release();
    }
  });

  /**
   * GET /api/admin/fuel/costs
   * Yakıt maliyet analizi
   */
  fastify.get('/fuel/costs', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { company_id, role } = request.user;
      
      if (role !== 'company_admin' && role !== 'super_admin') {
        return reply.code(403).send({ success: false, error: 'Yetkisiz erişim' });
      }

      // Yakıt tipine göre maliyet dağılımı
      const byType = await client.query(`
        SELECT 
          COALESCE(v.fuel_type, 'diesel') as fuel_type,
          COALESCE(SUM(fr.total_cost), 0) as total_cost,
          COALESCE(SUM(fr.liters_filled), 0) as total_liters
        FROM fuel_records fr
        JOIN vehicles v ON v.id = fr.vehicle_id
        WHERE fr.company_id = $1
        GROUP BY v.fuel_type
      `, [company_id]);

      const costByType = byType.rows.map(row => ({
        type: row.fuel_type || 'diesel',
        cost: parseFloat(row.total_cost) || 0,
        liters: parseFloat(row.total_liters) || 0
      }));

      // Ortalama yakıt fiyatı
      const avgPrice = await client.query(`
        SELECT 
          COALESCE(AVG(price_per_liter), 0) as avg_price,
          COALESCE(MIN(price_per_liter), 0) as min_price,
          COALESCE(MAX(price_per_liter), 0) as max_price
        FROM fuel_records
        WHERE company_id = $1 AND price_per_liter > 0
      `, [company_id]);

      // Aylık maliyet trendi
      const monthlyTrend = await client.query(`
        SELECT 
          TO_CHAR(record_date, 'YYYY-MM') as month,
          COALESCE(SUM(total_cost), 0) as total_cost
        FROM fuel_records
        WHERE company_id = $1 
          AND record_date >= NOW() - INTERVAL '6 months'
        GROUP BY TO_CHAR(record_date, 'YYYY-MM')
        ORDER BY month ASC
      `, [company_id]);

      return reply.send({
        success: true,
        data: {
          byType: costByType,
          priceStats: {
            average: parseFloat(avgPrice.rows[0]?.avg_price).toFixed(2) || '0',
            min: parseFloat(avgPrice.rows[0]?.min_price).toFixed(2) || '0',
            max: parseFloat(avgPrice.rows[0]?.max_price).toFixed(2) || '0'
          },
          monthlyTrend: monthlyTrend.rows.map(row => ({
            month: row.month,
            cost: parseFloat(row.total_cost) || 0
          }))
        }
      });
    } catch (error) {
      fastify.log.error('Fuel costs error:', error);
      return reply.code(500).send({ success: false, error: 'Maliyet verileri alınamadı' });
    } finally {
      client.release();
    }
  });

  /**
   * GET /api/admin/fuel/records
   * Son yakıt kayıtları
   */
  fastify.get('/fuel/records', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { company_id, role } = request.user;
      
      if (role !== 'company_admin' && role !== 'super_admin') {
        return reply.code(403).send({ success: false, error: 'Yetkisiz erişim' });
      }

      const limit = parseInt(request.query.limit) || 10;
      const offset = parseInt(request.query.offset) || 0;

      // Toplam kayıt sayısı
      const countResult = await client.query(`
        SELECT COUNT(*) as total FROM fuel_records WHERE company_id = $1
      `, [company_id]);

      // Kayıtları getir
      const result = await client.query(`
        SELECT 
          fr.id,
          fr.record_date,
          fr.liters_filled,
          fr.total_cost,
          fr.price_per_liter,
          fr.odometer_km,
          fr.km_traveled,
          fr.consumption_per_100km,
          fr.station_name,
          
          v.plate_no,
          v.brand,
          v.model,
          COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '') as driver_name
        FROM fuel_records fr
        JOIN vehicles v ON v.id = fr.vehicle_id
        LEFT JOIN drivers d ON d.id = fr.driver_id
        LEFT JOIN users u ON u.id = d.user_id
        WHERE fr.company_id = $1
        ORDER BY fr.record_date DESC
        LIMIT $2 OFFSET $3
      `, [company_id, limit, offset]);

      const records = result.rows.map(row => ({
        id: row.id,
        date: row.record_date,
        liters: parseFloat(row.liters_filled) || 0,
        cost: parseFloat(row.total_cost) || 0,
        pricePerLiter: parseFloat(row.price_per_liter) || 0,
        odometer: parseFloat(row.odometer_km) || 0,
        kmTraveled: parseFloat(row.km_traveled) || 0,
        consumption: parseFloat(row.consumption_per_100km)?.toFixed(1) || '0',
        station: row.station_name || '',
        
        vehicle: {
          plateNo: row.plate_no,
          brand: row.brand,
          model: row.model
        },
        driverName: row.driver_name?.trim() || 'Bilinmiyor'
      }));

      return reply.send({
        success: true,
        data: {
          records,
          total: parseInt(countResult.rows[0].total),
          limit,
          offset
        }
      });
    } catch (error) {
      fastify.log.error('Fuel records error:', error);
      return reply.code(500).send({ success: false, error: 'Kayıtlar alınamadı' });
    } finally {
      client.release();
    }
  });

  // ============================================
  // CARBON FOOTPRINT ENDPOINTS
  // ============================================

  /**
   * GET /api/admin/carbon/stats
   * Karbon ayak izi istatistikleri
   */
  fastify.get('/carbon/stats', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { company_id, role } = request.user;
      
      if (role !== 'company_admin' && role !== 'super_admin') {
        return reply.code(403).send({ success: false, error: 'Yetkisiz erişim' });
      }

      // Bu ay yakıt verileri
      const currentMonthStart = new Date();
      currentMonthStart.setDate(1);
      currentMonthStart.setHours(0, 0, 0, 0);

      const result = await client.query(`
        SELECT 
          COALESCE(v.fuel_type, 'diesel') as fuel_type,
          COALESCE(SUM(fr.liters_filled), 0) as total_liters,
          COALESCE(SUM(fr.km_traveled), 0) as total_km
        FROM fuel_records fr
        JOIN vehicles v ON v.id = fr.vehicle_id
        WHERE fr.company_id = $1 AND fr.record_date >= $2
        GROUP BY v.fuel_type
      `, [company_id, currentMonthStart]);

      let totalCO2 = 0;
      let totalKm = 0;
      let totalLiters = 0;

      result.rows.forEach(row => {
        const fuelType = row.fuel_type || 'diesel';
        const liters = parseFloat(row.total_liters) || 0;
        const km = parseFloat(row.total_km) || 0;
        const factor = CO2_FACTORS[fuelType] || CO2_FACTORS.diesel;
        
        totalCO2 += liters * factor;
        totalKm += km;
        totalLiters += liters;
      });

      // g/km hesapla
      const gPerKm = totalKm > 0 ? (totalCO2 * 1000) / totalKm : 0;
      
      // EU limitine göre durum
      const complianceStatus = gPerKm <= EU_LIMIT_G_PER_KM ? 'compliant' : 'exceeded';
      const compliancePercent = EU_LIMIT_G_PER_KM > 0 ? Math.round((gPerKm / EU_LIMIT_G_PER_KM) * 100) : 0;

      // Ağaç eşdeğeri (1 ağaç yılda ~22kg CO2 emer)
      const treeEquivalent = Math.round(totalCO2 / 22);

      // Limit üstündeki araç sayısı
      const vehiclesAboveLimit = await client.query(`
        SELECT COUNT(DISTINCT v.id) as count
        FROM vehicles v
        JOIN fuel_records fr ON fr.vehicle_id = v.id
        WHERE v.company_id = $1 
          AND fr.record_date >= $2
        GROUP BY v.id
        HAVING (SUM(fr.liters_filled) * $3 * 1000) / NULLIF(SUM(fr.km_traveled), 0) > $4
      `, [company_id, currentMonthStart, CO2_FACTORS.diesel, EU_LIMIT_G_PER_KM]);

      // Geçen aya göre değişim
      const lastMonthStart = new Date(currentMonthStart);
      lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
      
      const lastMonthResult = await client.query(`
        SELECT 
          COALESCE(v.fuel_type, 'diesel') as fuel_type,
          COALESCE(SUM(fr.liters_filled), 0) as total_liters
        FROM fuel_records fr
        JOIN vehicles v ON v.id = fr.vehicle_id
        WHERE fr.company_id = $1 
          AND fr.record_date >= $2 
          AND fr.record_date < $3
        GROUP BY v.fuel_type
      `, [company_id, lastMonthStart, currentMonthStart]);

      let lastMonthCO2 = 0;
      lastMonthResult.rows.forEach(row => {
        const fuelType = row.fuel_type || 'diesel';
        const liters = parseFloat(row.total_liters) || 0;
        const factor = CO2_FACTORS[fuelType] || CO2_FACTORS.diesel;
        lastMonthCO2 += liters * factor;
      });

      const changePercent = lastMonthCO2 > 0 
        ? Math.round(((totalCO2 - lastMonthCO2) / lastMonthCO2) * 100)
        : 0;

      return reply.send({
        success: true,
        data: {
          totalCO2kg: Math.round(totalCO2 * 100) / 100,
          totalKm: Math.round(totalKm),
          gPerKm: Math.round(gPerKm * 10) / 10,
          euLimit: EU_LIMIT_G_PER_KM,
          complianceStatus,
          compliancePercent,
          treeEquivalent,
          vehiclesAboveLimit: parseInt(vehiclesAboveLimit.rows[0]?.count || 0),
          changePercent
        }
      });
    } catch (error) {
      fastify.log.error('Carbon stats error:', error);
      return reply.code(500).send({ success: false, error: 'Karbon istatistikleri alınamadı' });
    } finally {
      client.release();
    }
  });

  /**
   * GET /api/admin/carbon/trends
   * Aylık karbon trend verileri
   */
  fastify.get('/carbon/trends', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { company_id, role } = request.user;
      
      if (role !== 'company_admin' && role !== 'super_admin') {
        return reply.code(403).send({ success: false, error: 'Yetkisiz erişim' });
      }

      const months = parseInt(request.query.months) || 6;

      const result = await client.query(`
        SELECT 
          TO_CHAR(fr.record_date, 'YYYY-MM') as month,
          TO_CHAR(fr.record_date, 'Mon') as month_name,
          COALESCE(v.fuel_type, 'diesel') as fuel_type,
          COALESCE(SUM(fr.liters_filled), 0) as total_liters,
          COALESCE(SUM(fr.km_traveled), 0) as total_km
        FROM fuel_records fr
        JOIN vehicles v ON v.id = fr.vehicle_id
        WHERE fr.company_id = $1 
          AND fr.record_date >= NOW() - INTERVAL '${months} months'
        GROUP BY TO_CHAR(fr.record_date, 'YYYY-MM'), TO_CHAR(fr.record_date, 'Mon'), v.fuel_type
        ORDER BY month ASC
      `, [company_id]);

      // Aylara göre grupla
      const monthlyData = {};
      result.rows.forEach(row => {
        const month = row.month;
        if (!monthlyData[month]) {
          monthlyData[month] = {
            month,
            monthName: row.month_name,
            totalCO2: 0,
            totalKm: 0
          };
        }
        
        const fuelType = row.fuel_type || 'diesel';
        const liters = parseFloat(row.total_liters) || 0;
        const km = parseFloat(row.total_km) || 0;
        const factor = CO2_FACTORS[fuelType] || CO2_FACTORS.diesel;
        
        monthlyData[month].totalCO2 += liters * factor;
        monthlyData[month].totalKm += km;
      });

      const trends = Object.values(monthlyData).map(data => ({
        month: data.month,
        monthName: data.monthName,
        co2kg: Math.round(data.totalCO2 * 100) / 100,
        km: Math.round(data.totalKm),
        gPerKm: data.totalKm > 0 
          ? Math.round((data.totalCO2 * 1000) / data.totalKm * 10) / 10 
          : 0
      }));

      return reply.send({
        success: true,
        data: trends
      });
    } catch (error) {
      fastify.log.error('Carbon trends error:', error);
      return reply.code(500).send({ success: false, error: 'Trend verileri alınamadı' });
    } finally {
      client.release();
    }
  });

  /**
   * GET /api/admin/carbon/vehicles
   * Araç bazlı karbon verileri
   */
  fastify.get('/carbon/vehicles', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      const { company_id, role } = request.user;
      
      if (role !== 'company_admin' && role !== 'super_admin') {
        return reply.code(403).send({ success: false, error: 'Yetkisiz erişim' });
      }

      const result = await client.query(`
        SELECT 
          v.id,
          v.plate_no,
          v.brand,
          v.model,
          COALESCE(v.fuel_type, 'diesel') as fuel_type,
          COALESCE(SUM(fr.liters_filled), 0) as total_liters,
          COALESCE(SUM(fr.km_traveled), 0) as total_km
        FROM vehicles v
        LEFT JOIN fuel_records fr ON fr.vehicle_id = v.id
        WHERE v.company_id = $1
        GROUP BY v.id, v.plate_no, v.brand, v.model, v.fuel_type
        ORDER BY total_liters DESC
      `, [company_id]);

      const vehicles = result.rows.map(row => {
        const fuelType = row.fuel_type || 'diesel';
        const liters = parseFloat(row.total_liters) || 0;
        const km = parseFloat(row.total_km) || 0;
        const factor = CO2_FACTORS[fuelType] || CO2_FACTORS.diesel;
        const co2 = liters * factor;
        const gPerKm = km > 0 ? (co2 * 1000) / km : 0;
        
        return {
          id: row.id,
          plateNo: row.plate_no,
          brand: row.brand,
          model: row.model,
          fuelType,
          totalLiters: liters,
          totalKm: Math.round(km),
          totalCO2kg: Math.round(co2 * 100) / 100,
          gPerKm: Math.round(gPerKm * 10) / 10,
          complianceStatus: gPerKm <= EU_LIMIT_G_PER_KM ? 'compliant' : 'exceeded'
        };
      });

      const totalCO2 = vehicles.reduce((sum, v) => sum + v.totalCO2kg, 0);
      const totalKm = vehicles.reduce((sum, v) => sum + v.totalKm, 0);

      return reply.send({
        success: true,
        data: {
          vehicles,
          summary: {
            totalCO2kg: Math.round(totalCO2 * 100) / 100,
            totalKm,
            vehicleCount: vehicles.length
          }
        }
      });
    } catch (error) {
      fastify.log.error('Carbon vehicles error:', error);
      return reply.code(500).send({ success: false, error: 'Araç karbon verileri alınamadı' });
    } finally {
      client.release();
    }
  });

};