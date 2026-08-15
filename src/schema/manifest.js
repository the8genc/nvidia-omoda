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
    capabilities: z.array(CapabilitySpec).min(1),
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
  .strict();

export function parseManifest(obj) {
  return SkillManifest.parse(obj);
}

export function safeParseManifest(obj) {
  return SkillManifest.safeParse(obj);
}
