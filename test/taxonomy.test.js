import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERB, IMPACT, TIER,
  isWrite, requiresInverse, requiresConsent, consentKind, classify, methodsFor,
} from "../src/domain/taxonomy.js";

test("reads are safe, everything else is a write", () => {
  assert.equal(isWrite(VERB.READ), false);
  for (const v of [VERB.CREATE, VERB.UPDATE, VERB.DELETE]) assert.equal(isWrite(v), true);
});

test("update and delete need an inverse; create and read do not", () => {
  assert.equal(requiresInverse(VERB.UPDATE), true);
  assert.equal(requiresInverse(VERB.DELETE), true);
  assert.equal(requiresInverse(VERB.CREATE), false);
  assert.equal(requiresInverse(VERB.READ), false);
});

test("consent is required only for writes carrying impact", () => {
  assert.equal(requiresConsent(VERB.READ, [IMPACT.FINANCIAL]), false, "reads never need consent");
  assert.equal(requiresConsent(VERB.CREATE, []), false, "contained writes need no consent");
  assert.equal(requiresConsent(VERB.CREATE, [IMPACT.FINANCIAL]), true);
});

test("consent kind escalates with severity and destructiveness", () => {
  assert.equal(consentKind(VERB.CREATE, [IMPACT.REPUTATIONAL]), "review");
  assert.equal(consentKind(VERB.CREATE, [IMPACT.FINANCIAL]), "approval");
  assert.equal(consentKind(VERB.DELETE, [IMPACT.LEGAL]), "two-person");
  assert.equal(consentKind(VERB.READ, [IMPACT.FINANCIAL]), null);
});

test("classification order: prohibited beats undeclared beats everything", () => {
  assert.equal(classify({ verb: VERB.READ, declared: true, prohibited: true }), TIER.PROHIBITED);
  assert.equal(classify({ verb: VERB.READ, declared: false }), TIER.UNDECLARED);
  assert.equal(classify({ verb: VERB.READ, declared: true }), TIER.SAFE);
  assert.equal(classify({ verb: VERB.UPDATE, declared: true, impact: [] }), TIER.CONTAINED);
  assert.equal(
    classify({ verb: VERB.UPDATE, declared: true, impact: [IMPACT.FINANCIAL] }),
    TIER.CONSEQUENTIAL,
  );
});

test("an unknown verb is treated as undeclared, not as a read", () => {
  assert.equal(classify({ verb: "exfiltrate", declared: true }), TIER.UNDECLARED);
});

test("a consequential write compiles to read-only, so the method is absent", () => {
  assert.deepEqual(methodsFor(VERB.CREATE, [IMPACT.FINANCIAL]), ["GET"]);
  assert.deepEqual(methodsFor(VERB.DELETE, [IMPACT.LEGAL]), ["GET"]);
  assert.deepEqual(methodsFor(VERB.CREATE, []), ["POST"]);
  assert.deepEqual(methodsFor(VERB.READ, []), ["GET"]);
});
