// Load and compile every enabled skill from disk.
//
// A skill is enabled by existing at skills/<name>/omoda.skill.yaml. Turning one
// on provisions exactly its envelope; removing the file removes the capability.
// The compiler is the only writer of policy, so this is the only ingestion path.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { compile } from "../policy/compile.js";

export function loadSkillFiles(dir = "skills") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name, "omoda.skill.yaml"))
    .filter((p) => existsSync(p) && statSync(p).isFile())
    .sort();
}

/**
 * @returns {{skills:Array, errors:Array}} compiled skills plus any that failed.
 * A malformed manifest is reported, never silently skipped: a skill that does
 * not compile must not appear to be enabled.
 */
export function loadSkills(dir = "skills") {
  const skills = [];
  const errors = [];
  for (const path of loadSkillFiles(dir)) {
    try {
      const manifest = parse(readFileSync(path, "utf8"));
      const compiled = compile(manifest);
      skills.push({
        path,
        skill: manifest.skill,
        agent: manifest.agent,
        description: manifest.description ?? null,
        manifest,
        ...compiled,
      });
    } catch (err) {
      errors.push({ path, error: err.message });
    }
  }
  return { skills, errors };
}

/** Flatten every compiled capability into one lookup the Broker can consult. */
export function buildCapabilityIndex(skills) {
  const byTool = new Map();
  for (const s of skills) {
    for (const row of s.registry) {
      byTool.set(row.tool, { ...row, skill: s.skill });
    }
  }
  return {
    /** Undeclared is denied: absence here is the whole answer. */
    lookup(tool) { return byTool.get(tool) ?? null; },
    isDeclared(tool) { return byTool.has(tool); },
    all() { return [...byTool.values()]; },
    get size() { return byTool.size; },
  };
}

/** Merge every skill's network policy into one envelope-shaped fragment. */
export function mergeFragments(skills) {
  const merged = { preset: { name: "omoda-merged", description: "All enabled OMODA skills" }, network_policies: {} };
  const fsRead = new Set();
  const fsWrite = new Set();
  for (const s of skills) {
    for (const [key, group] of Object.entries(s.fragment.network_policies ?? {})) {
      if (!merged.network_policies[key]) {
        merged.network_policies[key] = JSON.parse(JSON.stringify(group));
        continue;
      }
      // Same host declared by two skills: union the rules, keep them distinct.
      const target = merged.network_policies[key].endpoints[0];
      for (const ep of group.endpoints) {
        for (const rule of ep.rules) {
          const dup = target.rules.some(
            (r) => r.allow.method === rule.allow.method && r.allow.path === rule.allow.path,
          );
          if (!dup) target.rules.push(rule);
        }
      }
    }
    for (const p of s.fragment.filesystem_policy?.read_only ?? []) fsRead.add(p);
    for (const p of s.fragment.filesystem_policy?.read_write ?? []) fsWrite.add(p);
  }
  if (fsRead.size || fsWrite.size) {
    merged.filesystem_policy = {
      include_workdir: true,
      ...(fsRead.size ? { read_only: [...fsRead].sort() } : {}),
      ...(fsWrite.size ? { read_write: [...fsWrite].sort() } : {}),
    };
  }
  return merged;
}
