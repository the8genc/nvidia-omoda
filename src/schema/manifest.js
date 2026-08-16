// Schema for `omoda.skill.yaml`, the sidecar that sits beside Paperclip's SKILL.md.
//
// Paperclip's catalog already carries trustLevel, but that describes what a skill
// FILE CONTAINS. This describes what a skill DOES. The compiler reads nothing else.
//
// Strict everywhere (S5): an unknown field is a rejected manifest, not a warning.
// Capability drift under time pressure is exactly how a policy layer rots.

import { z } from "zod";
import { VERB, IMPACT } from "../domain/taxonomy.js";

const Verb = z.enum([VERB.READ, VERB.CREATE, VERB.UPDATE, VERB.DELETE]);
const Impact = z.enum([IMPACT.FINANCIAL, IMPACT.LEGAL, IMPACT.REPUTATIONAL]);

const AbsolutePath = z
  .string()
  .min(1)
  .refine((p) => p.startsWith("/"), { message: "must be an absolute path" })
  .refine((p) => !p.includes(".."), { message: "must not traverse with .." });

export const EgressSpec = z
  .object({
    host: z.string().min(1).regex(/^[a-z0-9.*-]+$/i, "hostname-ish"),
    port: z.number().int().min(1).max(65535).default(443),
    path: z.string().startsWith("/").default("/**"),
  })
  .strict();

export const CapabilitySpec = z
  .object({
    tool: z.string().min(1),
    verb: Verb,
    resource: z.string().min(1).optional(),
    // The declaration the operator is trusted for. The verb is NOT trusted from
    // here; it is derived from the call at runtime.
    impact: z.array(Impact).default([]),
    // Absent for local-only tools (fs, shell). Present for anything reaching out.
    egress: EgressSpec.optional(),
  })
  .strict();

export const SkillManifest = z
  .object({
    skill: z.string().min(1).regex(/^[a-z0-9-]+$/, "lowercase kebab-case"),
    agent: z.string().min(1).regex(/^[a-z0-9-]+$/, "lowercase kebab-case"),
    description: z.string().optional(),
    // The agent's rank in the organization (PRD section 23.3). The level is the
    // only thing that changes how an agent engages, and it is enforced HERE, at
    // compile time, so an over-leveled manifest fails the same way a malformed
    // one does. Default 2 preserves every manifest written before levels existed.
    //   0 orchestrator   inference, no tools
    //   1 domain expert  domain inference plus retrieval, no tools
    //   2 worker         tools, NO inference; consequential work goes to L3
    //   3 tool specialist connectivity only, no inference, no task context
    level: z.number().int().min(0).max(3).default(2),
    // An explicit inference grant. Only levels 0 and 1 may hold one.
    inference: z.boolean().default(false),
    capabilities: z.array(CapabilitySpec).default([]),
    filesystem: z
      .object({
        read: z.array(AbsolutePath).default([]),
        write: z.array(AbsolutePath).default([]),
      })
      .strict()
      .default({ read: [], write: [] }),
    // Which executables inside the sandbox may use these endpoints. Narrowing
    // this is the second axis of least privilege after methods.
    binaries: z.array(AbsolutePath).default(["/usr/local/bin/node"]),
  })
  .strict()
  .superRefine((m, ctx) => {
    const fail = (message) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });

    if (m.inference && m.level >= 2) {
      fail(`level ${m.level} may not hold an inference grant: an L2 that can call a model can be talked into calling it, which is the failure the level exists to remove`);
    }
    if (m.level <= 1 && m.capabilities.length > 0) {
      fail(`level ${m.level} declares ${m.capabilities.length} capability(ies): L0 and L1 direct work, they do not execute tools`);
    }
    if (m.level >= 2 && m.capabilities.length === 0) {
      fail(`level ${m.level} declares no capabilities: a worker or tool specialist with no tools does nothing`);
    }
    if (m.level === 3) {
      // Tool connectivity and nothing else. A connectivity agent that can also
      // write the filesystem is a worker wearing a specialist's badge.
      for (const c of m.capabilities) {
        if (!c.egress) fail(`level 3 capability "${c.tool}" has no egress: an L3 is pure tool connectivity, local work belongs to an L2`);
      }
      if (m.filesystem.write.length > 0) {
        fail("level 3 declares filesystem writes: an L3 is pure tool connectivity, nothing beyond it");
      }
    }
  });

export function parseManifest(obj) {
  return SkillManifest.parse(obj);
}

export function safeParseManifest(obj) {
  return SkillManifest.safeParse(obj);
}
