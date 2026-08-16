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
    .map((name) => {
      // One Markdown file per skill is the v4 shape (PRD section 23.4): YAML
      // front matter for the machine, prose body for the agent. The YAML sidecar
      // keeps working during migration. If both exist, the md wins, loudly.
      const md = join(dir, name, "omoda.skill.md");
      const yaml = join(dir, name, "omoda.skill.yaml");
      if (existsSync(md) && statSync(md).isFile()) return md;
      if (existsSync(yaml) && statSync(yaml).isFile()) return yaml;
      return null;
    })
    .filter(Boolean)
    .sort();
}

/** Split an omoda.skill.md into { manifest front matter, instructions body }. */
export function parseSkillMarkdown(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("omoda.skill.md must start with a YAML front matter block");
  return { manifest: parse(m[1]), instructions: m[2].trim() || null };
}

/**
 * What an agent at this level is HANDED. The level does not describe behaviour,
 * it determines injection: an L2 has no inference client to be talked into
 * calling, and an L3 is never given the task context it could leak.
 */
export function grantsFor(level) {
  return Object.freeze({
    level,
    inference: level <= 1,
    retrieval: level === 1,
    // "consent-none": only capabilities the taxonomy marks unattended.
    // "all-declared": every declared tool, each still gated by the Broker.
    tools: level <= 1 ? "none" : level === 2 ? "consent-none" : "all-declared",
    taskContext: level <= 2,
  });
}

/**
 * @returns {{skills:Array, errors:Array}} compiled skills plus any that failed.
 * A malformed manifest is reported, never silently skipped: a skill that does
 * not compile must not appear to be enabled. An over-leveled manifest fails
 * here too, for the same reason (schema superRefine).
 */
export function loadSkills(dir = "skills") {
  const skills = [];
  const errors = [];
  for (const path of loadSkillFiles(dir)) {
    try {
      const raw = readFileSync(path, "utf8");
      const { manifest, instructions } = path.endsWith(".md")
        ? parseSkillMarkdown(raw)
        : { manifest: parse(raw), instructions: null };
      const compiled = compile(manifest);
      const level = compiled.manifest?.level ?? manifest.level ?? 2;
      skills.push({
        path,
        skill: manifest.skill,
        agent: manifest.agent,
        description: manifest.description ?? null,
        level,
        grants: grantsFor(level),
        instructions,
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
