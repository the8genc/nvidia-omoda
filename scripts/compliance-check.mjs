#!/usr/bin/env node
// G11. Fails the build on any dependency whose PINNED version was published
// after the cutoff, or whose license is not OSI-approved.
//
// The hackathon rule is that only open-source code older than two weeks may be
// used. The project being old is not enough; the version we ship is what counts.
// This caught ws@8.21.3 (published 2026-08-07) on the way in.

import { readFileSync } from "node:fs";

const CUTOFF = process.env.OMODA_OSS_CUTOFF ?? "2026-08-01";
const OSI_OK = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "MPL-2.0"]);

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const direct = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {});

let failed = 0;
const rows = [];

for (const name of direct) {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry) { console.error(`MISSING  ${name} not in lockfile`); failed++; continue; }
  const version = entry.version;

  let published = "unknown", license = entry.license ?? "unknown";
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}`);
    const meta = await res.json();
    published = (meta.time?.[version] ?? "unknown").slice(0, 10);
    license = meta.license ?? license;
  } catch {
    console.error(`OFFLINE  ${name}: could not reach the registry; refusing to pass blind`);
    failed++;
    continue;
  }

  const dateOk = published !== "unknown" && published <= CUTOFF;
  const licOk = OSI_OK.has(license);
  if (!dateOk || !licOk) failed++;
  rows.push({ name, version, published, license, dateOk, licOk });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\ncompliance cutoff: ${CUTOFF}\n`);
console.log(`${pad("package", 10)} ${pad("version", 10)} ${pad("published", 12)} ${pad("license", 12)} verdict`);
for (const r of rows) {
  const verdict = r.dateOk && r.licOk ? "OK" : `FAIL${r.dateOk ? "" : " date"}${r.licOk ? "" : " license"}`;
  console.log(`${pad(r.name, 10)} ${pad(r.version, 10)} ${pad(r.published, 12)} ${pad(r.license, 12)} ${verdict}`);
}

if (failed) {
  console.error(`\n${failed} dependency check(s) failed. Pin an older version or drop the dependency.`);
  process.exit(1);
}
console.log("\nall direct dependencies inside the rule.");
