// Hash-chained, append-only action ledger.
//
// Written and FSYNCED BEFORE the action executes. That ordering is the whole
// point: a crash between "decided to act" and "acted" must leave evidence, and
// an action with no attributable origin must be impossible rather than unlikely.
//
// A ledger write failure is a refusal, never a warning (S13).

import { createHash } from "node:crypto";
import { openSync, writeSync, fsyncSync, closeSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const GENESIS = "0".repeat(64);

/** Stable stringify so the chain hash does not depend on key order. */
function canonical(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(",")}]`;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function hashEntry(prevHash, entry) {
  return createHash("sha256").update(prevHash).update(canonical(entry)).digest("hex");
}

export function hashArgs(args) {
  return createHash("sha256").update(canonical(args ?? {})).digest("hex").slice(0, 32);
}

export class LedgerWriteError extends Error {
  constructor(cause) {
    super(`ledger write failed: ${cause}`);
    this.name = "LedgerWriteError";
  }
}

export function createLedger({ path = "var/ledger/actions.jsonl", broken = false, onAppend = null } = {}) {
  let seq = 0;
  let prevHash = GENESIS;
  const memory = [];

  if (!broken) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) {
        const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          const rec = JSON.parse(line);
          memory.push(rec);
          seq = rec.seq;
          prevHash = rec.hash;
        }
      }
    } catch {
      broken = true;
    }
  }

  return {
    get length() { return memory.length; },
    all() { return memory.slice(); },

    /** Durable append. Throws LedgerWriteError so the Broker fails closed. */
    append(entry) {
      if (broken) throw new LedgerWriteError("ledger unavailable");
      const body = { ...entry, seq: seq + 1, prevHash, at: entry.at ?? new Date().toISOString() };
      const rec = { ...body, hash: hashEntry(prevHash, body) };
      try {
        const fd = openSync(path, "a");
        try {
          writeSync(fd, JSON.stringify(rec) + "\n");
          fsyncSync(fd); // durable before we return, so before the caller executes
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        throw new LedgerWriteError(err.message);
      }
      seq = rec.seq;
      prevHash = rec.hash;
      memory.push(rec);
      try { onAppend?.(rec); } catch { /* observers never block the record */ }
      return rec;
    },

    /** Detects a mutated or removed record anywhere in the chain. */
    verify() {
      let prev = GENESIS;
      for (const rec of memory) {
        const { hash, ...body } = rec;
        if (body.prevHash !== prev) return { ok: false, brokenAt: rec.seq, reason: "chain" };
        if (hashEntry(prev, body) !== hash) return { ok: false, brokenAt: rec.seq, reason: "content" };
        prev = hash;
      }
      return { ok: true, length: memory.length };
    },

    query({ since, tier, agent, verb, impact, intentId, outcome, kind, limit = 100 } = {}) {
      return memory
        .filter((r) => (since ? r.at >= since : true))
        .filter((r) => (tier ? r.tier === tier : true))
        .filter((r) => (agent ? r.agent === agent : true))
        .filter((r) => (verb ? r.verb === verb : true))
        .filter((r) => (impact ? (r.impact ?? []).includes(impact) : true))
        .filter((r) => (intentId ? r.intentId === intentId : true))
        .filter((r) => (outcome ? r.outcome === outcome : true))
        .filter((r) => (kind ? r.kind === kind : true))
        .slice(-limit);
    },
  };
}
