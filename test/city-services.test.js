import { test } from "node:test";
import assert from "node:assert/strict";
import { createCityServices } from "../src/mock/city-services.js";
import { buildCapabilityIndex, loadSkills } from "../src/skills/load.js";

const registry = buildCapabilityIndex(loadSkills().skills);

// Drive the handler directly with a fake req/res, no socket.
function call(svc, method, path, body) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const req = { method, url: path, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
  return new Promise((resolve) => {
    let status, payload;
    const res = { writeHead(s) { status = s; }, end(b) { payload = JSON.parse(b); resolve({ status, body: payload }); } };
    svc.handle(req, res);
  });
}

test("the catalog reports every route with OpenShell protection from the real manifest", async () => {
  const svc = createCityServices({ registry });
  const { body } = await call(svc, "GET", "/api/catalog");
  const byPath = Object.fromEntries(body.routes.map((r) => [`${r.method} ${r.path}`, r]));
  // reads are open
  assert.equal(byPath["GET /api/dispatch/units"].openshell_protected, false);
  assert.equal(byPath["GET /api/dispatch/{call_id}"].openshell_protected, false);
  // dispatching a unit is protected (create + legal)
  assert.equal(byPath["POST /api/dispatch"].openshell_protected, true);
  assert.equal(byPath["POST /api/dispatch"].consent, "approval");
  // cancelling a live callout is the two-person one
  assert.equal(byPath["DELETE /api/dispatch/{call_id}"].consent, "two-person");
  // a roadside work order is reversible, not protected
  assert.equal(byPath["POST /api/roads/workorders"].openshell_protected, false);
});

test("dispatch returns units and an ETA, and marks itself dangerous", async () => {
  const svc = createCityServices({ registry, now: () => 0 });
  const { status, body } = await call(svc, "POST", "/api/dispatch", { service: "fire", location: "5th & Pine", incident: "vehicle fire" });
  assert.equal(status, 201);
  assert.equal(body.dangerous, true);
  assert.equal(body.service, "fire");
  assert.equal(body.routed_to, "Seattle Fire Dispatch");
  assert.ok(body.units[0].unit_id);
  assert.equal(body.eta_seconds, 360);
});

test("status evolves against the clock: routing -> en_route -> on_scene", async () => {
  let t = 0;
  const svc = createCityServices({ registry, now: () => t });
  const d = (await call(svc, "POST", "/api/dispatch", { service: "police" })).body; // eta 300
  assert.equal((await call(svc, "GET", `/api/dispatch/${d.call_id}`)).body.status, "routing");
  t = 60_000; // 60s later
  const enroute = (await call(svc, "GET", `/api/dispatch/${d.call_id}`)).body;
  assert.equal(enroute.status, "en_route");
  assert.equal(enroute.eta_seconds, 240, "ETA counts down");
  t = 400_000; // past the ETA
  assert.equal((await call(svc, "GET", `/api/dispatch/${d.call_id}`)).body.status, "on_scene");
});

test("a cancelled callout reports cancelled and stands down its unit", async () => {
  const svc = createCityServices({ registry, now: () => 0 });
  const d = (await call(svc, "POST", "/api/dispatch", { service: "ems" })).body;
  const c = (await call(svc, "DELETE", `/api/dispatch/${d.call_id}`)).body;
  assert.equal(c.status, "cancelled");
  assert.equal(c.dangerous, true);
  assert.deepEqual(c.units, []);
});

test("fleet status flips a unit to deployed while a call is active", async () => {
  const svc = createCityServices({ registry, now: () => 0 });
  const before = (await call(svc, "GET", "/api/dispatch/units")).body.units.filter((u) => u.status === "deployed").length;
  await call(svc, "POST", "/api/dispatch", { service: "fire" });
  const after = (await call(svc, "GET", "/api/dispatch/units")).body.units.filter((u) => u.status === "deployed").length;
  assert.equal(after, before + 1);
});

test("a roadside work order is pollable and not dangerous", async () => {
  let t = 0;
  const svc = createCityServices({ registry, now: () => t });
  const wo = (await call(svc, "POST", "/api/roads/workorders", { type: "tow", segment: "SR-99" })).body;
  assert.equal(wo.dangerous, false);
  assert.equal(wo.status, "scheduled");
  t = 60_000;
  assert.equal((await call(svc, "GET", `/api/roads/workorders/${wo.work_order_id}`)).body.status, "crew_dispatched");
});

test("unknown routes 404 with a hint", async () => {
  const svc = createCityServices({ registry });
  const { status, body } = await call(svc, "GET", "/api/nope");
  assert.equal(status, 404);
  assert.match(body.hint, /catalog/);
});
