// The response plans: how each incident type flows down the org chart.
//
// This is the choreography the demo shows as prose. It is grounded in the actual
// skills (their agents, levels, and capabilities); the plan names which domain
// expert (L1) takes an incident, which workers (L2) it leans on, and which of
// those escalate the dangerous 911 call to the shared tool specialist (L3).
//
// The narration walks these hops. The dangerous hops (dangerous: true) are the
// ones whose concrete action goes through the Broker and requires human consent;
// everything above them is the orchestration that led there.

export const RESPONSE_PLANS = Object.freeze({
  "traffic-accident": {
    l1: "accident",
    chain: [
      { from: "accident", to: "ambulatory", doing: "assess whether anyone needs EMS" },
      { from: "ambulatory", to: "emergency-dispatch", doing: "request an ambulance", dangerous: true },
      { from: "accident", to: "police", doing: "decide whether police must be notified" },
      { from: "police", to: "emergency-dispatch", doing: "place the call to police", dangerous: true },
      { from: "accident", to: "procurement", doing: "line up a crane if heavy recovery is needed" },
      { from: "procurement", to: "procurement-gateway", doing: "authorize the crane callout (public spend)", dangerous: true },
      { from: "accident", to: "evidence-desk", doing: "keep a camera on the scene" },
      { from: "evidence-desk", to: "surveillance-ops", doing: "export the collision footage as evidence", dangerous: true },
    ],
  },
  fire: {
    l1: "fire",
    chain: [
      { from: "fire", to: "fire-department", doing: "request a fire response" },
      { from: "fire-department", to: "emergency-dispatch", doing: "place the fire-dispatch call", dangerous: true },
      { from: "fire", to: "ambulatory", doing: "assess whether anyone needs EMS" },
      { from: "ambulatory", to: "emergency-dispatch", doing: "request an ambulance", dangerous: true },
      { from: "fire", to: "procurement", doing: "line up a private hazmat contractor if the load is unknown" },
      { from: "procurement", to: "procurement-gateway", doing: "authorize the hazmat vendor callout (public spend)", dangerous: true },
    ],
  },
  "utility-hazard": {
    l1: "utility",
    chain: [
      { from: "utility", to: "utility-ops", doing: "read the affected grid segment" },
      { from: "utility", to: "utility-control", doing: "cut power to the block", dangerous: true },
      { from: "utility", to: "utility-control", doing: "shut off gas to the block", dangerous: true },
      { from: "utility", to: "utility-ops", doing: "restore power once the hazard is cleared" },
    ],
  },
  "public-warning": {
    l1: "comms",
    chain: [
      { from: "comms", to: "public-info", doing: "size the audience for the affected area" },
      { from: "comms", to: "notify-gateway", doing: "post a neighborhood advisory", dangerous: true },
      { from: "comms", to: "notify-gateway", doing: "send a reverse-911 to residents", dangerous: true },
    ],
  },
  "fallen-signage": {
    l1: "roadside",
    chain: [
      { from: "roadside", to: "roadside", doing: "open a work order to clear the obstruction" },
    ],
  },
  "road-maintenance": {
    l1: "roadside",
    chain: [
      { from: "roadside", to: "roadside", doing: "open a Seattle DOT work order" },
    ],
  },
});

export function planFor(incidentType) {
  return RESPONSE_PLANS[incidentType] ?? RESPONSE_PLANS["road-maintenance"];
}
