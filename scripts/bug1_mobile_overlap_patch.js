#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = process.argv[2];
if (!path) { console.error("Kullanım: node bug1_mobile_overlap_patch.js <server.js yolu>"); process.exit(1); }
let src = fs.readFileSync(path, "utf8");
const MARK = "BUG-1 Faz B-mobil";
if (src.includes(MARK)) { console.log("Zaten yamalı — dokunulmadı."); process.exit(0); }
function assertOnce(anchor, tag) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) { console.error(`ANCHOR FAIL [${tag}]: beklenen 1, bulunan ${n} — hiçbir şey yazılmadı.`); process.exit(1); }
}
const OVERLAP_SQL = `SELECT task_no,
                  ROUND(EXTRACT(EPOCH FROM (
                    LEAST(scheduled_end, $3::timestamp) -
                    GREATEST(scheduled_start, $2::timestamp)
                  )) / 60.0)::int AS overlap_minutes
           FROM tasks
           WHERE vehicle_id = $1
             AND status IN ('assigned','accepted','in_progress','pending_review')
             AND scheduled_start IS NOT NULL
             AND scheduled_end IS NOT NULL
             AND tsrange(scheduled_start, scheduled_end) &&
                 tsrange($2::timestamp, $3::timestamp)`;
const A1 = `      }

      // Multi-tenant task code: CCC-YY-NNNNN`;
assertOnce(A1, "create-numarator");
const CREATE_CHECK = `      }

      // ${MARK} (2026-08-02): zaman penceresi çakışma denetimi.
      // Mobil admin kanalı SERT 409 — override YOKTUR (Spec v3 §B kanal ayrımı).
      // Yalnız vehicle_id + her iki pencere doluysa koşulur (karar 2b: NULL muaf).
      // Numaratörden ÖNCE koşulur — 409'da task_no sayacı yanmaz.
      if (hasVehicle && scheduled_start && scheduled_end) {
        const { rows: confRows } = await client.query(
          \`${OVERLAP_SQL}
           ORDER BY scheduled_start ASC
           LIMIT 1\`,
          [vehicle_id, scheduled_start, scheduled_end]
        );
        if (confRows.length > 0) {
          return reply.code(409).send({
            error: "Conflict",
            message: \`Bu araca belirtilen aralıkta atanmış görev var (\${confRows[0].task_no}, çakışma ~\${confRows[0].overlap_minutes} dk).\`,
            conflict_metadata: {
              conflicting_task_no: confRows[0].task_no,
              overlap_minutes: confRows[0].overlap_minutes,
            },
          });
        }
      }

      // Multi-tenant task code: CCC-YY-NNNNN`;
src = src.replace(A1, CREATE_CHECK);
const A2 = `      const { rows: existing } = await client.query(
        "SELECT id FROM tasks WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );`;
assertOnce(A2, "update-existing-select");
src = src.replace(A2, `      const { rows: existing } = await client.query(
        // ${MARK}: efektif araç hesabı için vehicle_id de çekilir
        "SELECT id, vehicle_id FROM tasks WHERE id = $1 AND company_id = $2",
        [id, companyId]
      );`);
const A3 = `      const wpJson = Array.isArray(waypoints)`;
assertOnce(A3, "update-wpjson");
const UPDATE_CHECK = `      // ${MARK} (2026-08-02): UPDATE kanalında da SERT 409, override yok.
      // Efektif değerler: araç = body ?? mevcut (COALESCE), pencereler = body
      // değeri (düz SET — koddan kanıtlı). Kendisi hariç (id <> $4).
      {
        const effVehicleId =
          vehicle_id != null && String(vehicle_id).trim() !== ""
            ? vehicle_id
            : existing[0].vehicle_id;
        const effStart = scheduled_start || null;
        const effEnd = scheduled_end || null;
        if (effVehicleId && effStart && effEnd) {
          const { rows: confRows } = await client.query(
            \`${OVERLAP_SQL}
             AND id <> $4
             ORDER BY scheduled_start ASC
             LIMIT 1\`,
            [effVehicleId, effStart, effEnd, id]
          );
          if (confRows.length > 0) {
            return reply.code(409).send({
              error: "Conflict",
              message: \`Bu araca belirtilen aralıkta atanmış görev var (\${confRows[0].task_no}, çakışma ~\${confRows[0].overlap_minutes} dk).\`,
              conflict_metadata: {
                conflicting_task_no: confRows[0].task_no,
                overlap_minutes: confRows[0].overlap_minutes,
              },
            });
          }
        }
      }

${A3}`;
src = src.replace(A3, UPDATE_CHECK);
fs.writeFileSync(path + ".bak", fs.readFileSync(path));
fs.writeFileSync(path, src);
console.log("YAMA TAMAM (yedek: server.js.bak)");
