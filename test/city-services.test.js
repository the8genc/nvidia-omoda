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

test("every catalogued route resolves to a declared tool: nothing points off the service layer", async () => {
  const svc = createCityServices({ registry });
  const { body } = await call(svc, "GET", "/api/catalog");
  for (const r of body.routes) {
    assert.ok(registry.isDeclared(r.tool), `${r.method} ${r.path} -> ${r.tool} must be a declared tool`);
    // protection is derived from the manifest, never null/unknown
    assert.equal(typeof r.openshell_protected, "boolean", `${r.tool} must have a known protection state`);
  }
});

test("the incident-response routes are catalogued and protected per the manifest", async () => {
  const svc = createCityServices({ registry });
  const { body } = await call(svc, "GET", "/api/catalog");
  const byPath = Object.fromEntries(body.routes.map((r) => [`${r.method} ${r.path}`, r]));
  assert.equal(byPath["POST /api/incidents"].consent, "approval");
  assert.equal(byPath["POST /api/incidents"].openshell_protected, true);
  assert.equal(byPath["DELETE /api/incidents/{id}"].consent, "two-person");
  assert.equal(byPath["POST /api/notify"].consent, "review");
  assert.equal(byPath["POST /api/notify"].openshell_protected, true);
  // polling a filed record is a read, so it is open
  assert.equal(byPath["GET /api/incidents/{id}"].openshell_protected, false);
});

test("filing an incident is dangerous, pollable, and retractable", async () => {
  let t = 0;
  const svc = createCityServices({ registry, now: () => t });
  const inc = (await call(svc, "POST", "/api/incidents", { kind: "collision", location: "5th & Pine", summary: "two-car" })).body;
  assert.equal(inc.dangerous, true, "a filed record under our name is a governed write");
  assert.equal(inc.status, "filed");
  assert.ok(inc.incident_id.startsWith("INC-"));
  t = 60_000;
  assert.equal((await call(svc, "GET", `/api/incidents/${inc.incident_id}`)).body.status, "acknowledged");
  const ret = (await call(svc, "DELETE", `/api/incidents/${inc.incident_id}`)).body;
  assert.equal(ret.status, "retracted");
  assert.equal(ret.dangerous, true);
});

test("notifying a supervisor is a governed write and delivers", async () => {
  const svc = createCityServices({ registry, now: () => 0 });
  const { status, body } = await call(svc, "POST", "/api/notify", { to: "shift supervisor", subject: "incident filed" });
  assert.equal(status, 201);
  assert.equal(body.dangerous, true);
  assert.equal(body.status, "delivered");
  assert.ok(body.notice_id.startsWith("NTF-"));
});

test("procurement is the financial beat: authorize is approval, cancel is two-person", async () => {
  const svc = createCityServices({ registry });
  const { body: cat } = await call(svc, "GET", "/api/catalog");
  const byPath = Object.fromEntries(cat.routes.map((r) => [`${r.method} ${r.path}`, r]));
  assert.equal(byPath["POST /api/procurement/callouts"].consent, "approval");
  assert.equal(byPath["POST /api/procurement/callouts"].impact.includes("financial"), true, "financial impact domain is exercised");
  assert.equal(byPath["DELETE /api/procurement/callouts/{id}"].consent, "two-person");
  // authorize returns a running cost and marks itself dangerous
  const po = (await call(svc, "POST", "/api/procurement/callouts", { vendor_id: "V-CRANE-1", need: "lift" })).body;
  assert.equal(po.dangerous, true);
  assert.equal(po.rate_per_hour, 1200);
  assert.ok(po.callout_id.startsWith("PO-"));
  const cancel = (await call(svc, "DELETE", `/api/procurement/callouts/${po.callout_id}`)).body;
  assert.equal(cancel.status, "cancelled");
  assert.equal(cancel.dangerous, true);
  assert.ok(cancel.cancellation_fee > 0);
});

test("utility exercises the update verb: de-energize is approval, restore is contained", async () => {
  const svc = createCityServices({ registry });
  const { body: cat } = await call(svc, "GET", "/api/catalog");
  const byPath = Object.fromEntries(cat.routes.map((r) => [`${r.method} ${r.path}`, r]));
  assert.equal(byPath["PUT /api/utility/power/deenergize"].verb, "update");
  assert.equal(byPath["PUT /api/utility/power/deenergize"].consent, "approval");
  assert.equal(byPath["PUT /api/utility/power/restore"].openshell_protected, false, "restore is a contained update");
  // de-energize flips grid state and is dangerous; restore brings it back and is not
  const off = (await call(svc, "PUT", "/api/utility/power/deenergize", { segment: "GRID-7" })).body;
  assert.equal(off.energized, false);
  assert.equal(off.dangerous, true);
  const on = (await call(svc, "PUT", "/api/utility/power/restore", { segment: "GRID-7" })).body;
  assert.equal(on.energized, true);
  assert.equal(on.dangerous, false);
});

test("surveillance draws the privacy line: ptz contained, export approval, retract two-person", async () => {
  const svc = createCityServices({ registry });
  const { body: cat } = await call(svc, "GET", "/api/catalog");
  const byPath = Object.fromEntries(cat.routes.map((r) => [`${r.method} ${r.path}`, r]));
  assert.equal(byPath["PUT /api/cameras/ptz"].openshell_protected, false, "steering a camera is contained");
  assert.equal(byPath["POST /api/evidence/clips"].consent, "approval");
  assert.equal(byPath["DELETE /api/evidence/clips/{id}"].consent, "two-person");
  const ptz = (await call(svc, "PUT", "/api/cameras/ptz", { camera_id: "CAM-1", pan: 30 })).body;
  assert.equal(ptz.dangerous, false);
  const clip = (await call(svc, "POST", "/api/evidence/clips", { camera_id: "CAM-1" })).body;
  assert.equal(clip.dangerous, true);
  assert.match(clip.chain_of_custody, /custody/);
  const ret = (await call(svc, "DELETE", `/api/evidence/clips/${clip.clip_id}`)).body;
  assert.equal(ret.status, "retracted");
  assert.equal(ret.dangerous, true);
});

test("comms is the review -> approval ladder: advisory reviews, reverse-911 approves", async () => {
  const svc = createCityServices({ registry });
  const { body: cat } = await call(svc, "GET", "/api/catalog");
  const byPath = Object.fromEntries(cat.routes.map((r) => [`${r.method} ${r.path}`, r]));
  assert.equal(byPath["POST /api/comms/advisories"].consent, "review");
  assert.equal(byPath["POST /api/comms/reverse911"].consent, "approval");
  const adv = (await call(svc, "POST", "/api/comms/advisories", { area: "Pike/Pine" })).body;
  assert.equal(adv.status, "posted");
  assert.equal(adv.dangerous, true, "a review is still human-gated");
  const r911 = (await call(svc, "POST", "/api/comms/reverse911", { zone: "Z1", action: "evacuate" })).body;
  assert.equal(r911.status, "sent");
  assert.ok(r911.recipients > 0);
});

test("unknown routes 404 with a hint", async () => {
  const svc = createCityServices({ registry });
  const { status, body } = await call(svc, "GET", "/api/nope");
  assert.equal(status, 404);
  assert.match(body.hint, /catalog/);
});
