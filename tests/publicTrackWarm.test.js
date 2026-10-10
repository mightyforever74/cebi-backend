"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { warmPublicRoute } = require("../routes/publicTrack");

const GEOMETRY = [
  [51.89, 4.42],
  [51.88, 4.35],
  [51.87, 4.3],
];

function buildFastify(options) {
  const state = {
    routeJson: options.routeJson === undefined ? null : options.routeJson,
    hereCalls: 0,
    updates: 0,
    released: 0,
    rows: options.rows,
  };
  const provider = {
    async computeRoute() {
      state.hereCalls += 1;
      if (options.hereFails) {
        const e = new Error("HERE down");
        e.code = "HERE_DOWN";
        throw e;
      }
      return { durationSec: 900, distanceM: 10000, geometry: GEOMETRY };
    },
  };
  const fastify = {
    routingProvider: provider,
    pg: {
      async connect() {
        return {
          query: async (sql, params) => {
            const s = sql.replace(/\s+/g, " ").trim();
            if (s.startsWith("SELECT")) {
              if (state.rows) return { rows: state.rows };
              return {
                rows: [
                  {
                    start_location: "Waalhaven, Rotterdam",
                    end_location: "Botlek",
                    route_json: state.routeJson,
                    pickup_location: { lat: 51.89, lng: 4.42, address: "Waalhaven" },
                    dropoff_location: { lat: 51.87, lng: 4.3, address: "Botlek" },
                  },
                ],
              };
            }
            if (s.startsWith("UPDATE")) {
              state.updates += 1;
              state.updateSql = s;
              const patch = JSON.parse(params[1]);
              state.routeJson = Object.assign({}, state.routeJson || {}, patch);
              return { rows: [], rowCount: 1 };
            }
            throw new Error("unexpected sql: " + s);
          },
          async release() {
            state.released += 1;
          },
        };
      },
    },
  };
  return { fastify, state };
}

test("warm computes HERE truck route once and caches it under public_route", async () => {
  const { fastify, state } = buildFastify({ taskId: "t-1" });
  const geometry = await warmPublicRoute(fastify, "t-1", null);
  assert.deepEqual(geometry, GEOMETRY);
  assert.equal(state.hereCalls, 1);
  assert.equal(state.updates, 1);
  assert.match(state.updateSql, /'public_route'/);
  assert.equal(state.routeJson.public_route.provider, "here");
  assert.deepEqual(state.routeJson.public_route.geometry, GEOMETRY);
  assert.equal(Object.keys(state.routeJson).length, 1, "writes only its own sub-key");
  assert.equal(state.released, 1);

  const again = await warmPublicRoute(fastify, "t-1", null);
  assert.deepEqual(again, GEOMETRY);
  assert.equal(state.hereCalls, 1, "cached geometry makes no second HERE call");
  assert.equal(state.released, 2);
});

test("warm returns null without throwing when HERE fails, and releases the client", async () => {
  const { fastify, state } = buildFastify({ hereFails: true });
  const geometry = await warmPublicRoute(fastify, "t-2", null);
  assert.equal(geometry, null);
  assert.equal(state.updates, 0);
  assert.equal(state.released, 1);
});

test("warm returns null when the task has no resolvable coordinates", async () => {
  const { fastify, state } = buildFastify({
    rows: [
      {
        start_location: "A",
        end_location: "B",
        route_json: null,
        pickup_location: null,
        dropoff_location: null,
      },
    ],
  });
  const geometry = await warmPublicRoute(fastify, "t-3", null);
  assert.equal(geometry, null);
  assert.equal(state.hereCalls, 0);
  assert.equal(state.released, 1);
});

test("warm tolerates a missing task and a missing pg decorator", async () => {
  const { fastify } = buildFastify({ rows: [] });
  assert.equal(await warmPublicRoute(fastify, "nope", null), null);
  assert.equal(await warmPublicRoute({}, "nope", null), null);
});
