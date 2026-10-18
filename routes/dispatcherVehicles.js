"use strict";

/**
 * Dispatcher vehicles endpoint — Faz A (Çekirdek Operasyon) portu.
 *
 * GET /api/dispatcher/vehicles
 *
 * Kaynak: tulipfleet-enterprise-backend/routes/vehicles.js — BİREBİR port.
 * Company-scoped (ADR-0009 §4.4 tenant isolation).
 *
 * NOT (ilk canlı deploy'da doğrulanacak): kaynak dosyadaki kargo kapasite
 * kolonları (cargo_capacity_volume_m3/weight_kg, hazmat_certified_classes,
 * live_cargo_*, companies.cargo_capacity_tracking) ve bakım kolonları
 * (last_maintenance_date, next_maintenance_km, emission_class) cebi-backend
 * migrations/ dizininde CEBI-özel delta olarak bulunamadı — bu, taban
 * tulipfleet-backend şemasından (fork öncesi) geldikleri anlamına gelebilir
 * (esp32_device_id/total_km/public.locations gibi diğer taban kolonlarıyla
 * aynı örüntü). SSH/doğrudan DB erişimi bu sandbox'tan yok; ilk e2e test
 * çalıştırmasında 500 dönerse (eksik kolon), SELECT listesi daraltılır —
 * weighbridge/mobil telemetri'deki hypertable bulgusuyla aynı "canlıda bul,
 * canlıda düzelt" disiplini.
 */
async function dispatcherVehiclesRoutes(fastify) {
  fastify.get(
    "/api/dispatcher/vehicles",
    {
      preHandler: [fastify.authenticate, fastify.requireRole("company_admin", "super_admin")],
    },
    async (request, reply) => {
      const companyId = request.user.company_id;

      if (!companyId) {
        return reply.code(403).send({
          error: "Forbidden",
          message: "Token missing company_id claim",
        });
      }

      try {
        const result = await fastify.pg.query(
          `SELECT v.id, v.plate_no, v.brand, v.model, v.year, v.status, v.vehicle_category,
          v.fuel_type, v.current_fuel_level, v.fuel_capacity, v.total_km, v.last_maintenance_date, v.next_maintenance_km, v.emission_class,
          v.ownership_type, v.owner_name,
          v.cargo_capacity_volume_m3, v.cargo_capacity_weight_kg, v.hazmat_certified_classes,
          v.live_cargo_volume_m3, v.live_cargo_weight_kg, v.live_cargo_reported_at,
          c.cargo_capacity_tracking,
          v.company_id, v.created_at, v.updated_at
   FROM public.vehicles v
   LEFT JOIN public.companies c ON c.id = v.company_id
   WHERE v.company_id = $1
   ORDER BY v.plate_no ASC`,
          [companyId]
        );

        return {
          vehicles: result.rows,
          count: result.rowCount,
        };
      } catch (err) {
        request.log.error({ err }, "Failed to fetch dispatcher vehicles");
        return reply.code(500).send({
          error: "Internal Server Error",
          message: "Failed to fetch vehicles",
        });
      }
    }
  );
}

module.exports = dispatcherVehiclesRoutes;
