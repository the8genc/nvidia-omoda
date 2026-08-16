// The mock external service layer: a stand-in for the city and private services
// an agent would call in production (911 dispatch, fire, EMS, police, roadside,
// Seattle DOT). It exists so the demo shows the full agent capability, calling
// out, getting JSON back, and polling live status, without placing a single real
// emergency call.
//
// It also makes the danger boundary explicit: GET /api/catalog reports, for
// every route, the backing tool and whether the call is OpenShell-protected,
// derived from the actual skills manifest so the labelling cannot drift from the
// real policy. Reads are open; the writes that dispatch or cancel a real-world
// response are the protected ones.
//
// Deterministic where it matters (ETAs are fixed per service), live where it
// helps (status counts down against the wall clock so a demo shows units
// arriving). No external dependencies; runs as its own process in our port block.

import { createServer } from "node:http";
import { createHash } from "node:crypto";

// Fixed ETAs per service, so a demo is repeatable. Seconds.
const ETA = Object.freeze({ fire: 360, ems: 480, police: 300, tow: 900, debris: 1200, pothole: 172800 });

const FLEET = Object.freeze([
  { unit_id: "E-17", type: "fire engine", service: "fire", home: "Station 17" },
  { unit_id: "L-9", type: "ladder truck", service: "fire", home: "Station 9" },
  { unit_id: "M-2", type: "ambulance", service: "ems", home: "Harborview" },
  { unit_id: "M-5", type: "ambulance", service: "ems", home: "Swedish" },
  { unit_id: "P-31", type: "patrol car", service: "police", home: "West Precinct" },
  { unit_id: "TOW-4", type: "tow truck", service: "tow", home: "SDOT Yard 3" },
]);

/** Deterministic pick: hash the call id to choose a unit for the service. */
function unitFor(service, id) {
  const pool = FLEET.filter((u) => u.service === service);
  if (pool.length === 0) return FLEET[0];
  const n = parseInt(createHash("sha256").update(id).digest("hex").slice(0, 4), 16);
  return pool[n % pool.length];
}

/** Status of a call given how long ago it was placed. */
function phaseOf(elapsedSec, etaSec) {
  if (elapsedSec < 5) return "routing";
  if (elapsedSec < etaSec) return "en_route";
  return "on_scene";
}

const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
};

/**
 * @param {object} opts
 * @param {() => number} [opts.now]  injectable clock (ms) for tests
 * @param {Map} [opts.registry]     tool -> {verb, impact, consent}; when present,
 *                                  the catalog's protection labels come from the
 *                                  real policy instead of a hand-maintained copy
 */
export function createCityServices({ now = () => Date.now(), registry = null } = {}) {
  const calls = new Map();      // call_id -> { service, location, incident, unit, eta, placed_at }
  const workorders = new Map(); // wo_id   -> { type, segment, crew_eta, placed_at }
  let counter = 0;
  const nextId = (prefix) => `${prefix}-${(++counter).toString().padStart(4, "0")}`;

  // Route -> backing tool, so the catalog can report OpenShell protection from
  // the manifest. protected = the tool needs a recorded decision (consent).
  const ROUTES = [
    { method: "GET", path: "/api/dispatch/units", tool: "dispatch.status.read", summary: "fleet status: which units are available or deployed" },
    { method: "POST", path: "/api/dispatch", tool: "dispatch.unit.request", summary: "request a unit (fire/EMS/police) to an incident" },
    { method: "GET", path: "/api/dispatch/{call_id}", tool: "dispatch.status.read", summary: "poll a dispatched call: status, units, ETA" },
    { method: "DELETE", path: "/api/dispatch/{call_id}", tool: "dispatch.callout.cancel", summary: "cancel a live callout" },
    { method: "GET", path: "/api/roads/segments/{id}", tool: "roadside.segment.read", summary: "read a road segment's condition" },
    { method: "POST", path: "/api/roads/workorders", tool: "roadside.workorder.create", summary: "open a roadside/DOT work order (tow, debris, pothole)" },
    { method: "GET", path: "/api/roads/workorders/{id}", tool: "roadside.workorder.create", summary: "poll a work order: status and crew ETA" },
    { method: "DELETE", path: "/api/roads/workorders/{id}", tool: "roadside.workorder.cancel", summary: "cancel a work order" },
  ];

  function protectionFor(tool) {
    const row = registry?.lookup?.(tool);
    if (!row) return { verb: null, impact: [], openshell_protected: null, consent: null };
    return {
      verb: row.verb,
      impact: row.impact ?? [],
      consent: row.consent ?? "none",
      openshell_protected: (row.consent ?? "none") !== "none",
    };
  }

  function dispatchView(id, rec) {
    const elapsed = Math.max(0, Math.floor((now() - rec.placed_at) / 1000));
    const status = rec.cancelled ? "cancelled" : phaseOf(elapsed, rec.eta);
    const remaining = rec.cancelled ? null : Math.max(0, rec.eta - elapsed);
    return {
      call_id: id,
      service: rec.service,
      routed_to: rec.routed_to,
      status,
      units: rec.cancelled ? [] : [{
        unit_id: rec.unit.unit_id, type: rec.unit.type, from: rec.unit.home,
        eta_seconds: remaining,
        distance: status === "on_scene" ? "on scene" : `${(remaining / 60).toFixed(1)} min out`,
      }],
      eta_seconds: remaining,
      elapsed_seconds: elapsed,
      incident: rec.incident,
      location: rec.location,
      placed_at: new Date(rec.placed_at).toISOString(),
    };
  }

  function workorderView(id, rec) {
    const elapsed = Math.max(0, Math.floor((now() - rec.placed_at) / 1000));
    const status = rec.cancelled ? "cancelled"
      : elapsed < 30 ? "scheduled"
        : elapsed < rec.crew_eta ? "crew_dispatched"
          : elapsed < rec.crew_eta + 600 ? "on_site" : "complete";
    return {
      work_order_id: id, type: rec.type, segment: rec.segment, status,
      crew: rec.cancelled ? null : { unit_id: rec.unit.unit_id, type: rec.unit.type, eta_seconds: Math.max(0, rec.crew_eta - elapsed) },
      opened_at: new Date(rec.placed_at).toISOString(),
    };
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (chunks.length === 0) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const m = req.method;

    if (p === "/health") return json(res, 200, { ok: true, service: "city-services-mock" });

    // The danger map: every route, its backing tool, and whether it is
    // OpenShell-protected, straight from the manifest.
    if (p === "/api/catalog") {
      return json(res, 200, {
        service: "OMODA mock city-services layer",
        note: "reads are open; the writes that dispatch or cancel a real-world response are OpenShell-protected",
        routes: ROUTES.map((r) => ({ ...r, ...protectionFor(r.tool) })),
      });
    }

    // ── emergency dispatch (fire / EMS / police) ─────────────────────────
    if (p === "/api/dispatch/units" && m === "GET") {
      const deployed = new Set([...calls.values()].filter((c) => !c.cancelled).map((c) => c.unit.unit_id));
      return json(res, 200, { units: FLEET.map((u) => ({ ...u, status: deployed.has(u.unit_id) ? "deployed" : "available" })) });
    }
    if (p === "/api/dispatch" && m === "POST") {
      const body = await readBody(req);
      const service = ["fire", "ems", "police"].includes(body.service) ? body.service : "police";
      const id = nextId("CAD");
      const rec = {
        service, location: body.location ?? "unknown", incident: body.incident ?? "unspecified",
        unit: unitFor(service, id), eta: ETA[service] ?? 300,
        routed_to: { fire: "Seattle Fire Dispatch", ems: "King County Medic One", police: "SPD Dispatch" }[service],
        placed_at: now(),
      };
      calls.set(id, rec);
      return json(res, 201, { ...dispatchView(id, rec), dangerous: true, message: `${service.toUpperCase()} unit ${rec.unit.unit_id} dispatched` });
    }
    const cadMatch = p.match(/^\/api\/dispatch\/([A-Za-z0-9-]+)$/);
    if (cadMatch) {
      const id = cadMatch[1];
      const rec = calls.get(id);
      if (!rec) return json(res, 404, { error: "unknown call_id" });
      if (m === "GET") return json(res, 200, dispatchView(id, rec));
      if (m === "DELETE") { rec.cancelled = true; return json(res, 200, { ...dispatchView(id, rec), dangerous: true, message: "callout cancelled" }); }
    }

    // ── roadside / Seattle DOT ───────────────────────────────────────────
    const segMatch = p.match(/^\/api\/roads\/segments\/([A-Za-z0-9-]+)$/);
    if (segMatch && m === "GET") {
      return json(res, 200, { segment_id: segMatch[1], surface: "dry", lanes_open: 2, lanes_total: 3, obstruction: "partial", updated_at: new Date(now()).toISOString() });
    }
    if (p === "/api/roads/workorders" && m === "POST") {
      const body = await readBody(req);
      const type = ["tow", "debris", "pothole"].includes(body.type) ? body.type : "debris";
      const id = nextId("WO");
      const rec = { type, segment: body.segment ?? "unknown", unit: unitFor("tow", id), crew_eta: ETA[type] ?? 900, placed_at: now() };
      workorders.set(id, rec);
      return json(res, 201, { ...workorderView(id, rec), dangerous: false, message: `work order ${id} opened` });
    }
    const woMatch = p.match(/^\/api\/roads\/workorders\/([A-Za-z0-9-]+)$/);
    if (woMatch) {
      const id = woMatch[1];
      const rec = workorders.get(id);
      if (!rec) return json(res, 404, { error: "unknown work_order_id" });
      if (m === "GET") return json(res, 200, workorderView(id, rec));
      if (m === "DELETE") { rec.cancelled = true; return json(res, 200, { ...workorderView(id, rec), message: "work order cancelled" }); }
    }

    return json(res, 404, { error: "no such route", hint: "GET /api/catalog lists every route" });
  }

  return { handle, server: createServer(handle), _state: { calls, workorders } };
}
