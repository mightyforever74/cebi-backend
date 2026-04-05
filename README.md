# Sunucuda calistir:
# ssh root@46.224.1.192
# Sonra asagidaki komutu yapistir:

cat > /opt/fleet/backend/README.md << 'READMEEOF'
# TulipFleet Backend

Fastify-based REST API and MQTT integration for the TulipFleet fleet management platform.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 |
| Framework | Fastify |
| Database | PostgreSQL 15 + TimescaleDB |
| MQTT Broker | EMQX |
| Cache | Redis |
| Container | Docker + Docker Compose |

---

## Repository Structure

```
tulipfleet-backend/
├── server.js           # Main entry point — Fastify app, all route registrations
├── plugins/            # Fastify plugins (auth, db, mqtt)
├── routes/             # Modular route handlers
│   ├── driver.js       # Driver endpoints (provision, stats, tasks)
│   ├── geofences.js    # Geofence management
│   └── ...
├── services/           # Business logic (geofenceService, etc.)
├── Dockerfile          # Container build
├── package.json
└── .gitignore
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
# Database
DATABASE_URL=postgresql://fleetadmin:PASSWORD@localhost:5433/fleet_tracking
DB_PASSWORD=PASSWORD

# JWT
JWT_SECRET=your_jwt_secret

# MQTT (EMQX)
MQTT_HOST=mqtt.tulipfleet.com
MQTT_PORT=8883
MQTT_USERNAME=fleet-backend
MQTT_PASSWORD=your_mqtt_password

# Redis
REDIS_URL=redis://localhost:6380

# Smart Cards (Faz 2)
HERE_API_KEY=
OPENWEATHER_API_KEY=
```

> **Warning:** DATABASE_URL and DB_PASSWORD are two separate variables. Both must be updated together during credential rotation.

---

## Production Deploy (Docker)

```bash
# Restart after server.js changes
docker rm -f fleet-backend && docker compose up -d --no-deps backend

# Logs
docker logs fleet-backend --tail 50 -f

# Health check
curl https://api.tulipfleet.com/health
```

> **Warning:** docker restart does NOT reload .env changes. Always use rm + compose up.

---

## Staging Deploy (PM2)

```bash
cd /opt/fleet/backend-staging
node --check server.js
pm2 restart fleet-staging
curl https://staging-api.tulipfleet.com/health
```

---

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Service health (DB, MQTT, Redis) |
| POST | /api/auth/login | JWT login |
| GET | /api/driver/stats | Driver stats (completed, today_km, month_km) |
| GET | /api/driver/vehicle | Assigned vehicle |
| GET | /api/driver/tasks | Task list |
| POST | /api/driver/validate-serial | ESP32 serial validation |
| POST | /api/devices/activate | Device activation |
| GET | /api/locations/latest | Fleet map positions |

---

## MQTT Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| fleet/device/{id}/location | ESP32 to Backend | GPS + accelerometer |
| fleet/device/{id}/status | ESP32 to Backend | Online/offline |
| fleet/device/{id}/command | Backend to ESP32 | RESET_PROVISION, FACTORY_RESET |
| fleet/device/{id}/geofence_event | ESP32 to Backend | Geofence entry/exit |

---

## Infrastructure

| Environment | URL | Path | Process |
|------------|-----|------|---------|
| Production | api.tulipfleet.com | /opt/fleet/backend/server.js | Docker (fleet-backend) |
| Staging | staging-api.tulipfleet.com | /opt/fleet/backend-staging/server.js | PM2 (fleet-staging) |

Server: Hetzner fleet-prod-01 / 46.224.1.192

---

## Critical Notes

- node_modules runs in a separate Docker volume — host npm install does NOT affect container
- EMQX passwords: Dashboard UI only (port 18083) — CLI does not work
- TimescaleDB retention: location data 7 days
READMEEOF

# Git push
cd /opt/fleet/backend
git add README.md server.js
git commit -m "feat: today_km + month_km stats, README eklendi"
git push origin main
