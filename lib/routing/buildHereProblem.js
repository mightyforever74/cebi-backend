"use strict";

/**
 * buildHereProblem, Faz A-3 portu. Kaynak: tulipfleet-enterprise-backend/
 * lib/routing/buildHereProblem.js, BİREBİR (saf fonksiyon, DB erişimi yok,
 * side-effect yok, shared_library katmanı, Mock ve gerçek HERE sağlayıcısı
 * ortak kullanabilir).
 *
 * HERE Tour Planning v3 `/v3/problems` (ve `/async` varyantı) request
 * gövdesi inşası. capacity/demand dizisi sırası sabit ve iki boyutlu:
 * [volume_m3, weight_kg], public.vehicles.cargo_capacity_volume_m3/
 * cargo_capacity_weight_kg ve enterprise.dispatch_tasks.capacity_required
 * jsonb'siyle birebir hizalı. Her enterprise.dispatch_tasks satırı hem
 * pickup_location hem dropoff_location taşıdığı için, buildHereProblem'ın
 * ürettiği her job doğası gereği karışık pickup+delivery job'u (HERE'de
 * ayrı bir "shipment" tipi yok).
 *
 * Phase 1 kapsamı: yalnızca tasks + vehicles (core VRP). appointments/
 * tollCostMatrix/routingMode/evMode gibi forward-compatible parametreler
 * bu portun kapsamı dışında (YAGNI).
 */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

const DEFAULT_PROFILE_NAME = "truck";
const HAZMAT_PROFILE_NAME = "truck_hazmat";
const DEFAULT_ACTIVITY_DURATION_SECONDS = 180;

// HERE Tour Planning v3'te ADR Sınıf 1-9 <-> HERE'in kategorik taksonomi
// eşlemesi şema belirsizliği nedeniyle Phase 2'ye ertelendi. Herhangi bir
// hazmat_classes niteliği olan araç, en katı tünel kategorisine (E, tüm
// tehlikeli maddeler için yasak) atanır, "veri yok" ile "hazmat yok"
// karıştırılmaz, ama "hangi hazmat" ayrımı da yapılmaz (güvenlik-önce
// tercih, fazla kısıtlama riskini kabul eder).
const HAZMAT_TUNNEL_CATEGORY = "E";

// HERE'in OpenAPI şeması fleet.types[].costs alanını ZORUNLU kılıyor.
// Gerçek maliyet modellemesi (araç bazlı sabit/km/saat ücretleri) henüz
// hiçbir yerde toplanmıyor (Phase 2), "toplam mesafeyi minimize et"
// varsayımına karşılık gelen sabit bir varsayılan kullanılıyor.
const DEFAULT_VEHICLE_COSTS = { fixed: 0, distance: 1, time: 0 };

function isPlainLocation(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// HERE'in location şeması STRICT (additionalProperties:false), task/vehicle
// location objelerindeki `address` alanı HERE tarafından reddedilir. Adres
// zaten enterprise.dispatch_tasks'ta ayrıca saklanıyor (normalizeHereSolution
// oradan okur), HERE'e giden location'da yalnızca lat/lng'ye izin var.
function toHereLocation(location) {
  return { lat: location.lat, lng: location.lng };
}

function uniqueConcat(a, b) {
  const merged = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  return Array.from(new Set(merged));
}

// Gerçek çağıranların hiçbiri (routes/dispatcherTasks.js optimize body'si,
// cebi-dispatcher OptimizeTaskInput formu) task'a id VERMİYOR, gerçek
// dispatch_tasks.id, submitVrp çağrısından SONRA (Draft Doğum adımında)
// üretiliyor. `index` parametresiyle her zaman stabil, benzersiz bir id
// garanti edilir (`job-${index}`). HereTourPlanningProvider'ın sonuç
// normalizasyonu bu id'yi KULLANMIYOR (dispatch_tasks'ı routing_job_id ile
// sorgulayarak gerçek id'leri alıyor), job-${index} yeterli.
function buildJob(task, index) {
  if (!task || !isPlainLocation(task.pickup_location) || !isPlainLocation(task.dropoff_location)) {
    throw new ValidationError(
      "Each task requires id, pickup_location and dropoff_location ({lat, lng})."
    );
  }

  const capacityRequired = task.capacity_required || {};
  const demand = [capacityRequired.volume_m3 ?? 0, capacityRequired.weight_kg ?? 0];

  const job = {
    id: task.id != null ? String(task.id) : `job-${index}`,
    tasks: {
      pickups: [
        {
          places: [
            { location: toHereLocation(task.pickup_location), duration: DEFAULT_ACTIVITY_DURATION_SECONDS },
          ],
          demand,
        },
      ],
      deliveries: [
        {
          places: [
            { location: toHereLocation(task.dropoff_location), duration: DEFAULT_ACTIVITY_DURATION_SECONDS },
          ],
          demand,
        },
      ],
    },
  };

  const skills = uniqueConcat(task.skill_required, capacityRequired.hazmat_classes);
  if (skills.length > 0) {
    job.skills = skills;
  }

  return job;
}

function buildFleetType(vehicle) {
  if (!vehicle || !isPlainLocation(vehicle.start_location)) {
    throw new ValidationError("Each vehicle requires id and start_location ({lat, lng}).");
  }

  const start = { location: toHereLocation(vehicle.start_location) };
  if (vehicle.shift_start) {
    start.time = vehicle.shift_start;
  }

  const shift = { start };
  if (isPlainLocation(vehicle.end_location) || vehicle.shift_end) {
    const end = {};
    if (isPlainLocation(vehicle.end_location)) {
      end.location = toHereLocation(vehicle.end_location);
    }
    if (vehicle.shift_end) {
      end.time = vehicle.shift_end;
    }
    shift.end = end;
  }

  const vehicleHazmatClasses = Array.isArray(vehicle.hazmat_classes) ? vehicle.hazmat_classes : [];
  const fleetType = {
    id: vehicle.id,
    profile: vehicleHazmatClasses.length > 0 ? HAZMAT_PROFILE_NAME : DEFAULT_PROFILE_NAME,
    amount: 1,
    capacity: [vehicle.capacity_volume_m3 ?? 0, vehicle.capacity_weight_kg ?? 0],
    costs: vehicle.costs || DEFAULT_VEHICLE_COSTS,
    shifts: [shift],
  };

  const skills = uniqueConcat(vehicle.skills, vehicle.hazmat_classes);
  if (skills.length > 0) {
    fleetType.skills = skills;
  }

  return fleetType;
}

/**
 * @param {Array<Object>} tasks - enterprise.dispatch_tasks iç temsili satırlar
 * @param {Array<Object>} vehicles - public.vehicles iç temsili satırlar
 * @returns {{fleet: Object, plan: Object}} HERE Tour Planning v3 problem gövdesi
 */
function buildHereProblem(tasks, vehicles) {
  if (!Array.isArray(tasks)) {
    throw new ValidationError("tasks must be an array.");
  }
  if (!Array.isArray(vehicles)) {
    throw new ValidationError("vehicles must be an array.");
  }

  const types = vehicles.map(buildFleetType);

  const profiles = [{ name: DEFAULT_PROFILE_NAME, type: DEFAULT_PROFILE_NAME }];
  if (types.some((t) => t.profile === HAZMAT_PROFILE_NAME)) {
    profiles.push({
      name: HAZMAT_PROFILE_NAME,
      type: DEFAULT_PROFILE_NAME,
      options: { tunnelCategory: HAZMAT_TUNNEL_CATEGORY },
    });
  }

  return {
    fleet: {
      types,
      profiles,
    },
    plan: {
      jobs: tasks.map((task, index) => buildJob(task, index)),
    },
  };
}

module.exports = {
  buildHereProblem,
  ValidationError,
  DEFAULT_ACTIVITY_DURATION_SECONDS,
};
