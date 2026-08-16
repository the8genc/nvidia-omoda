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
    ],
  },
  fire: {
    l1: "fire",
    chain: [
      { from: "fire", to: "fire-department", doing: "request a fire response" },
      { from: "fire-department", to: "emergency-dispatch", doing: "place the fire-dispatch call", dangerous: true },
      { from: "fire", to: "ambulatory", doing: "assess whether anyone needs EMS" },
      { from: "ambulatory", to: "emergency-dispatch", doing: "request an ambulance", dangerous: true },
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
