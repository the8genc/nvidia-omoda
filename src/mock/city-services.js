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
  const incidents = new Map();  // inc_id  -> { kind, location, summary, placed_at, retracted }
  const notices = new Map();    // ntf_id  -> { to, subject, placed_at }
  const callouts = new Map();   // po_id   -> { vendor, need, location, placed_at, cancelled }
  const clips = new Map();      // ev_id   -> { camera_id, span, reason, placed_at, retracted }
  const advisories = new Map(); // adv/r911 id -> { kind, area, message, placed_at }
  const segments = new Map();   // seg_id  -> { energized, gas_flowing, hazard }
  let counter = 0;
  const nextId = (prefix) => `${prefix}-${(++counter).toString().padStart(4, "0")}`;

  // Private vendors on contract, and the public notification channels: static
  // reference the reads return.
  const VENDORS = Object.freeze([
    { vendor_id: "V-CRANE-1", name: "Ballard Heavy Lift", kind: "crane", rate_per_hour: 1200, status: "available" },
    { vendor_id: "V-TOW-HD1", name: "Rainier Heavy Recovery", kind: "heavy-tow", rate_per_hour: 480, status: "available" },
    { vendor_id: "V-HAZ-1", name: "Cascade Hazmat Services", kind: "hazmat", rate_per_hour: 2100, status: "available" },
  ]);
  const CHANNELS = Object.freeze([
    { channel_id: "ADV-BOARD", name: "Neighborhood advisory board", kind: "advisory", audience: 4200 },
    { channel_id: "R911-Z1", name: "Reverse-911 zone 1", kind: "reverse911", audience: 1850 },
  ]);

  // The write calls that put something in the real world are dangerous. The
  // source of truth is the manifest: a tool is dangerous iff its consent is not
  // "none". A static set is the fallback for a mock stood up without a registry,
  // so the flag never silently becomes false.
  const DANGEROUS_FALLBACK = new Set([
    "dispatch.unit.request", "dispatch.callout.cancel",
    "incident.record.create", "incident.record.retract", "supervisor.notify",
    "procurement.callout.authorize", "procurement.callout.cancel",
    "utility.gas.shutoff", "utility.power.deenergize",
    "evidence.clip.export", "evidence.clip.retract",
    "comms.advisory.post", "comms.reverse911.send",
  ]);
  function isDangerous(tool) {
    if (!registry) return DANGEROUS_FALLBACK.has(tool);
    return protectionFor(tool).openshell_protected ?? DANGEROUS_FALLBACK.has(tool);
  }

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
    { method: "POST", path: "/api/incidents", tool: "incident.record.create", summary: "file an incident record with the county of record" },
    { method: "GET", path: "/api/incidents/{id}", tool: "incident.status.read", summary: "poll a filed incident record" },
    { method: "DELETE", path: "/api/incidents/{id}", tool: "incident.record.retract", summary: "retract a filed incident record" },
    { method: "POST", path: "/api/notify", tool: "supervisor.notify", summary: "notify a supervisor / on-call under our name" },
    // procurement / finance (the financial impact domain)
    { method: "GET", path: "/api/procurement/vendors", tool: "procurement.vendor.read", summary: "list private vendors on contract (crane, heavy tow, hazmat)" },
    { method: "POST", path: "/api/procurement/callouts", tool: "procurement.callout.authorize", summary: "authorize a private vendor callout (commits public money)" },
    { method: "GET", path: "/api/procurement/callouts/{id}", tool: "procurement.callout.status", summary: "poll a vendor callout: status and running cost" },
    { method: "DELETE", path: "/api/procurement/callouts/{id}", tool: "procurement.callout.cancel", summary: "cancel a paid vendor contract" },
    // utility / infrastructure (the update verb)
    { method: "GET", path: "/api/utility/segments/{id}", tool: "utility.grid.read", summary: "read a grid segment: energized, gas, load, hazard" },
    { method: "PUT", path: "/api/utility/power/restore", tool: "utility.power.restore", summary: "restore power to a segment after a hazard is cleared" },
    { method: "PUT", path: "/api/utility/gas/shutoff", tool: "utility.gas.shutoff", summary: "shut off gas to a segment" },
    { method: "PUT", path: "/api/utility/power/deenergize", tool: "utility.power.deenergize", summary: "cut power to a block" },
    // surveillance / evidence (the privacy line)
    { method: "PUT", path: "/api/cameras/ptz", tool: "camera.ptz.control", summary: "pan/tilt/zoom a camera to follow an incident" },
    { method: "POST", path: "/api/evidence/clips", tool: "evidence.clip.export", summary: "export CCTV footage as legal evidence" },
    { method: "GET", path: "/api/evidence/clips/{id}", tool: "evidence.clip.status", summary: "poll an exported evidence clip" },
    { method: "DELETE", path: "/api/evidence/clips/{id}", tool: "evidence.clip.retract", summary: "retract an exported evidence clip" },
    // public-safety comms (the review -> approval ladder)
    { method: "GET", path: "/api/comms/channels", tool: "comms.channel.read", summary: "list notification channels and audience size" },
    { method: "POST", path: "/api/comms/advisories", tool: "comms.advisory.post", summary: "post a neighborhood advisory" },
    { method: "POST", path: "/api/comms/reverse911", tool: "comms.reverse911.send", summary: "send a reverse-911 to residents (evacuate / shelter)" },
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

  function incidentView(id, rec) {
    const elapsed = Math.max(0, Math.floor((now() - rec.placed_at) / 1000));
    const status = rec.retracted ? "retracted" : elapsed < 30 ? "filed" : "acknowledged";
    return {
      incident_id: id, kind: rec.kind, location: rec.location, summary: rec.summary,
      status, routed_to: "King County incident registry", filed_at: new Date(rec.placed_at).toISOString(),
    };
  }

  function calloutView(id, rec) {
    const elapsed = Math.max(0, Math.floor((now() - rec.placed_at) / 1000));
    const status = rec.cancelled ? "cancelled" : elapsed < 30 ? "authorized" : elapsed < 600 ? "dispatched" : "on_site";
    const hours = Math.max(1, Math.ceil(elapsed / 3600));
    return {
      callout_id: id, vendor: rec.vendor.name, kind: rec.vendor.kind, need: rec.need, location: rec.location,
      status, rate_per_hour: rec.vendor.rate_per_hour, running_cost: rec.cancelled ? rec.vendor.rate_per_hour : rec.vendor.rate_per_hour * hours,
      authorized_at: new Date(rec.placed_at).toISOString(),
    };
  }

  function segmentState(id) {
    const s = segments.get(id) ?? { energized: true, gas_flowing: true, hazard: "downed line reported" };
    return { segment_id: id, ...s, updated_at: new Date(now()).toISOString() };
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
      return json(res, 201, { ...dispatchView(id, rec), dangerous: isDangerous("dispatch.unit.request"), message: `${service.toUpperCase()} unit ${rec.unit.unit_id} dispatched` });
    }
    const cadMatch = p.match(/^\/api\/dispatch\/([A-Za-z0-9-]+)$/);
    if (cadMatch) {
      const id = cadMatch[1];
      const rec = calls.get(id);
      if (!rec) return json(res, 404, { error: "unknown call_id" });
      if (m === "GET") return json(res, 200, dispatchView(id, rec));
      if (m === "DELETE") { rec.cancelled = true; return json(res, 200, { ...dispatchView(id, rec), dangerous: isDangerous("dispatch.callout.cancel"), message: "callout cancelled" }); }
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
      return json(res, 201, { ...workorderView(id, rec), dangerous: isDangerous("roadside.workorder.create"), message: `work order ${id} opened` });
    }
    const woMatch = p.match(/^\/api\/roads\/workorders\/([A-Za-z0-9-]+)$/);
    if (woMatch) {
      const id = woMatch[1];
      const rec = workorders.get(id);
      if (!rec) return json(res, 404, { error: "unknown work_order_id" });
      if (m === "GET") return json(res, 200, workorderView(id, rec));
      if (m === "DELETE") { rec.cancelled = true; return json(res, 200, { ...workorderView(id, rec), dangerous: isDangerous("roadside.workorder.cancel"), message: "work order cancelled" }); }
    }

    // ── incident records (the See-track responder files these) ───────────
    // A record filed with a county under our name is a consequential write:
    // OpenShell holds the POST until a human approves, and the DELETE (retract)
    // takes two people. This is the same taxonomy applied to a middle service
    // tier, not a bespoke rule for emergencies.
    if (p === "/api/incidents" && m === "POST") {
      const body = await readBody(req);
      const id = nextId("INC");
      const rec = { kind: body.kind ?? "detection", location: body.location ?? "unknown", summary: body.summary ?? "unspecified", placed_at: now() };
      incidents.set(id, rec);
      return json(res, 201, { ...incidentView(id, rec), dangerous: isDangerous("incident.record.create"), message: `incident ${id} filed` });
    }
    const incMatch = p.match(/^\/api\/incidents\/([A-Za-z0-9-]+)$/);
    if (incMatch) {
      const id = incMatch[1];
      const rec = incidents.get(id);
      if (!rec) return json(res, 404, { error: "unknown incident_id" });
      if (m === "GET") return json(res, 200, incidentView(id, rec));
      if (m === "DELETE") { rec.retracted = true; return json(res, 200, { ...incidentView(id, rec), dangerous: isDangerous("incident.record.retract"), message: "incident record retracted" }); }
    }

    // ── supervisor / on-call notification ────────────────────────────────
    if (p === "/api/notify" && m === "POST") {
      const body = await readBody(req);
      const id = nextId("NTF");
      const rec = { to: body.to ?? "on-call supervisor", subject: body.subject ?? "incident notification", placed_at: now() };
      notices.set(id, rec);
      return json(res, 201, { notice_id: id, to: rec.to, subject: rec.subject, status: "delivered", dangerous: isDangerous("supervisor.notify"), sent_at: new Date(rec.placed_at).toISOString(), message: `notification ${id} sent to ${rec.to}` });
    }

    // ── procurement / private vendors (the financial impact domain) ──────
    // Authorizing a private callout commits public money, so the POST is held
    // for approval; cancelling a paid contract has a fee and a legal cost, so
    // the DELETE takes two people. Reads run free.
    if (p === "/api/procurement/vendors" && m === "GET") {
      return json(res, 200, { vendors: VENDORS.map((v) => ({ ...v })) });
    }
    if (p === "/api/procurement/callouts" && m === "POST") {
      const body = await readBody(req);
      const vendor = VENDORS.find((v) => v.vendor_id === body.vendor_id) ?? VENDORS[0];
      const id = nextId("PO");
      const rec = { vendor, need: body.need ?? "heavy recovery", location: body.location ?? "unknown", placed_at: now() };
      callouts.set(id, rec);
      return json(res, 201, { ...calloutView(id, rec), dangerous: isDangerous("procurement.callout.authorize"), message: `${vendor.name} (${vendor.kind}) authorized at $${vendor.rate_per_hour}/hr` });
    }
    const poMatch = p.match(/^\/api\/procurement\/callouts\/([A-Za-z0-9-]+)$/);
    if (poMatch) {
      const id = poMatch[1];
      const rec = callouts.get(id);
      if (!rec) return json(res, 404, { error: "unknown callout_id" });
      if (m === "GET") return json(res, 200, calloutView(id, rec));
      if (m === "DELETE") {
        rec.cancelled = true;
        return json(res, 200, { ...calloutView(id, rec), cancellation_fee: rec.vendor.rate_per_hour, dangerous: isDangerous("procurement.callout.cancel"), message: "vendor contract cancelled" });
      }
    }

    // ── utility / infrastructure (the update verb) ───────────────────────
    // Cutting power to a block and shutting off gas are updates to a real grid
    // state, held for approval. Restoring power after a hazard clears is a
    // reversible, contained update that runs autonomously.
    const segMatch2 = p.match(/^\/api\/utility\/segments\/([A-Za-z0-9-]+)$/);
    if (segMatch2 && m === "GET") return json(res, 200, segmentState(segMatch2[1]));
    if (p === "/api/utility/power/deenergize" && m === "PUT") {
      const body = await readBody(req);
      const seg = body.segment ?? "unknown";
      segments.set(seg, { ...(segments.get(seg) ?? { gas_flowing: true, hazard: "downed line reported" }), energized: false });
      return json(res, 200, { ...segmentState(seg), dangerous: isDangerous("utility.power.deenergize"), message: `power cut to ${seg}` });
    }
    if (p === "/api/utility/gas/shutoff" && m === "PUT") {
      const body = await readBody(req);
      const seg = body.segment ?? "unknown";
      segments.set(seg, { ...(segments.get(seg) ?? { energized: true, hazard: "gas leak reported" }), gas_flowing: false });
      return json(res, 200, { ...segmentState(seg), dangerous: isDangerous("utility.gas.shutoff"), message: `gas shut off to ${seg}` });
    }
    if (p === "/api/utility/power/restore" && m === "PUT") {
      const body = await readBody(req);
      const seg = body.segment ?? "unknown";
      segments.set(seg, { ...(segments.get(seg) ?? { gas_flowing: true, hazard: null }), energized: true, hazard: null });
      return json(res, 200, { ...segmentState(seg), dangerous: isDangerous("utility.power.restore"), message: `power restored to ${seg}` });
    }

    // ── surveillance / evidence (the privacy line) ───────────────────────
    // Steering a camera is a reversible, contained update. Exporting footage as
    // evidence starts a chain of custody (approval); retracting it is spoliation
    // risk (two-person). Facial recognition and public release are prohibited and
    // never reach here.
    if (p === "/api/cameras/ptz" && m === "PUT") {
      const body = await readBody(req);
      return json(res, 200, { camera_id: body.camera_id ?? "CAM-1", view: { pan: body.pan ?? 0, tilt: body.tilt ?? 0, zoom: body.zoom ?? 1 }, dangerous: isDangerous("camera.ptz.control"), message: "camera repositioned" });
    }
    if (p === "/api/evidence/clips" && m === "POST") {
      const body = await readBody(req);
      const id = nextId("EV");
      const rec = { camera_id: body.camera_id ?? "CAM-1", span: body.span ?? "00:00-00:30", reason: body.reason ?? "incident evidence", placed_at: now() };
      clips.set(id, rec);
      return json(res, 201, { clip_id: id, camera_id: rec.camera_id, span: rec.span, chain_of_custody: `custody opened for ${id}`, status: "exported", dangerous: isDangerous("evidence.clip.export"), exported_at: new Date(rec.placed_at).toISOString(), message: `clip ${id} exported as evidence` });
    }
    const evMatch = p.match(/^\/api\/evidence\/clips\/([A-Za-z0-9-]+)$/);
    if (evMatch) {
      const id = evMatch[1];
      const rec = clips.get(id);
      if (!rec) return json(res, 404, { error: "unknown clip_id" });
      if (m === "GET") return json(res, 200, { clip_id: id, camera_id: rec.camera_id, span: rec.span, status: rec.retracted ? "retracted" : "held", exported_at: new Date(rec.placed_at).toISOString() });
      if (m === "DELETE") { rec.retracted = true; return json(res, 200, { clip_id: id, status: "retracted", dangerous: isDangerous("evidence.clip.retract"), message: "evidence clip retracted" }); }
    }

    // ── public-safety comms (the review -> approval ladder) ──────────────
    if (p === "/api/comms/channels" && m === "GET") {
      return json(res, 200, { channels: CHANNELS.map((c) => ({ ...c })) });
    }
    if (p === "/api/comms/advisories" && m === "POST") {
      const body = await readBody(req);
      const id = nextId("ADV");
      advisories.set(id, { kind: "advisory", area: body.area ?? "unknown", message: body.message ?? "", placed_at: now() });
      return json(res, 201, { advisory_id: id, area: body.area ?? "unknown", reach: CHANNELS[0].audience, status: "posted", dangerous: isDangerous("comms.advisory.post"), message: `advisory ${id} posted` });
    }
    if (p === "/api/comms/reverse911" && m === "POST") {
      const body = await readBody(req);
      const id = nextId("R911");
      advisories.set(id, { kind: "reverse911", area: body.zone ?? "zone 1", message: body.message ?? "", placed_at: now() });
      return json(res, 201, { alert_id: id, zone: body.zone ?? "zone 1", action: body.action ?? "shelter-in-place", recipients: CHANNELS[1].audience, status: "sent", dangerous: isDangerous("comms.reverse911.send"), message: `reverse-911 ${id} sent to ${CHANNELS[1].audience} residents` });
    }

    return json(res, 404, { error: "no such route", hint: "GET /api/catalog lists every route" });
  }

  return { handle, server: createServer(handle), _state: { calls, workorders, incidents, notices, callouts, clips, advisories, segments } };
}
