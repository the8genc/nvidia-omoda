// The Policy Compiler. The ONLY writer of policy in the system.
//
// One manifest in, three artifacts out:
//   1. an OpenShell network/filesystem policy fragment  ("can it?")
//   2. a consent plan                                    ("should it?")
//   3. a capability registry                             (the human-readable table)
//
// The load-bearing line is in taxonomy.methodsFor(): a write carrying an impact
// domain compiles to ["GET"]. The write method is ABSENT from the emitted policy,
// so the refusal comes from the L7 proxy rather than from our code, and no prompt
// can talk its way past it.

import { stringify } from "yaml";
import { parseManifest } from "../schema/manifest.js";
import {
  methodsFor,
  consentKind,
  requiresConsent,
  requiresInverse,
  isWrite,
} from "../domain/taxonomy.js";

/** Group capabilities by host:port so one endpoint carries all its allowed rules. */
function groupByEndpoint(capabilities) {
  const groups = new Map();
  for (const cap of capabilities) {
    if (!cap.egress) continue;
    const key = `${cap.egress.host}:${cap.egress.port}`;
    if (!groups.has(key)) {
      groups.set(key, { host: cap.egress.host, port: cap.egress.port, caps: [] });
    }
    groups.get(key).caps.push(cap);
  }
  return [...groups.values()];
}

/**
 * Emit the OpenShell fragment. Shape matches the real NemoClaw preset schema
 * read off the box: preset{name,description}, network_policies{key{name,endpoints,binaries}},
 * endpoints carrying protocol:rest + enforcement:enforce + rules[{allow:{method,path}}].
 */
export function compileOpenShellFragment(manifest) {
  const m = parseManifest(manifest);
  const groups = groupByEndpoint(m.capabilities);

  const network_policies = {};
  for (const g of groups) {
    const rules = [];
    const seen = new Set();
    for (const cap of g.caps) {
      for (const method of methodsFor(cap.verb, cap.impact)) {
        const sig = `${method} ${cap.egress.path}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        rules.push({ allow: { method, path: cap.egress.path } });
      }
    }
    rules.sort((a, b) =>
      `${a.allow.method}${a.allow.path}`.localeCompare(`${b.allow.method}${b.allow.path}`),
    );
    const key = g.host.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
    network_policies[key] = {
      name: key,
      endpoints: [
        {
          host: g.host,
          port: g.port,
          // protocol: rest is what makes per-request method and path filtering
          // real. Without it the entry degrades to a raw L4 tunnel and every
          // rule below becomes decorative.
          protocol: "rest",
          enforcement: "enforce",
          rules,
        },
      ],
      binaries: m.binaries.map((path) => ({ path })),
    };
  }

  const fragment = {
    preset: {
      name: `omoda-${m.skill}`,
      description: m.description ?? `OMODA compiled envelope for skill ${m.skill}`,
    },
  };

  if (Object.keys(network_policies).length > 0) fragment.network_policies = network_policies;

  if (m.filesystem.read.length || m.filesystem.write.length) {
    fragment.filesystem_policy = {
      include_workdir: true,
      ...(m.filesystem.read.length ? { read_only: [...m.filesystem.read].sort() } : {}),
      ...(m.filesystem.write.length ? { read_write: [...m.filesystem.write].sort() } : {}),
    };
  }

  return fragment;
}

/** What consent each capability needs, and why. Feeds the Paperclip executionPolicy. */
export function compileConsentPlan(manifest) {
  const m = parseManifest(manifest);
  return m.capabilities
    .filter((c) => requiresConsent(c.verb, c.impact))
    .map((c) => ({
      tool: c.tool,
      verb: c.verb,
      impact: c.impact,
      stage: consentKind(c.verb, c.impact),
      inverseRequired: requiresInverse(c.verb),
    }));
}

/** The generated per-agent capability table (PRD section 11). */
export function compileRegistry(manifest) {
  const m = parseManifest(manifest);
  return m.capabilities.map((c) => {
    const methods = methodsFor(c.verb, c.impact);
    const gated = requiresConsent(c.verb, c.impact);
    return {
      agent: m.agent,
      skill: m.skill,
      tool: c.tool,
      verb: c.verb,
      impact: c.impact,
      grant: c.egress
        ? `${methods.join(",")} ${c.egress.host}${c.egress.path}${gated ? " (read-only until consented)" : ""}`
        : isWrite(c.verb)
          ? "local filesystem only"
          : "local read only",
      consent: gated ? consentKind(c.verb, c.impact) : "none",
      inverseRequired: requiresInverse(c.verb),
      // The concrete egress, so the Broker can build the request it governs and
      // an executor can reach the service layer once a decision materialises it.
      egress: c.egress ?? null,
    };
  });
}

export function compile(manifest) {
  return {
    fragment: compileOpenShellFragment(manifest),
    consent: compileConsentPlan(manifest),
    registry: compileRegistry(manifest),
  };
}

export function fragmentToYaml(fragment) {
  return (
    "# Generated by the OMODA Policy Compiler. Do not edit by hand.\n" +
    "# The compiler is the only writer of policy; edit the skill manifest instead.\n" +
    stringify(fragment, { lineWidth: 0 })
  );
}
