import { test } from "node:test";
import assert from "node:assert/strict";
import { prohibitedReason, portAllowed, PORT_BLOCK } from "../src/domain/prohibited.js";

test("our port block is exactly 3100 to 3199", () => {
  assert.equal(PORT_BLOCK.min, 3100);
  assert.equal(PORT_BLOCK.max, 3199);
  assert.equal(portAllowed(3100), true);
  assert.equal(portAllowed(3199), true);
  assert.equal(portAllowed(3099), false);
  assert.equal(portAllowed(3200), false, "3200 is tiruye's block");
});

test("shared services are named, not merely out of range", () => {
  assert.equal(prohibitedReason({ port: 8000 }), "shared-service-port", "the shared vLLM");
  assert.equal(prohibitedReason({ port: 3300 }), "port-outside-block", "fredrik's block");
  assert.equal(prohibitedReason({ port: 3150 }), null);
});

test("the shared model cache and other homes are refused", () => {
  assert.equal(
    prohibitedReason({ path: "/home/acer01/.cache/huggingface/models" }),
    "model-cache",
  );
  assert.equal(prohibitedReason({ path: "/home/acer01/hackathon" }), "shared-path");
  assert.equal(prohibitedReason({ path: "/home/arif/omoda/src" }), null);
});

test("the host container runtime is refused", () => {
  assert.equal(prohibitedReason({ args: { path: "/var/run/docker.sock" } }), "shared-path");
});

test("self-protection: a delta that weakens OpenShell is refused", () => {
  assert.equal(
    prohibitedReason({ policyDelta: { exclude: ["managed_inference"] } }),
    "policy-weakening",
  );
  assert.equal(
    prohibitedReason({ policyDelta: { preset: "personal-open-internet" } }),
    "policy-weakening",
  );
  assert.equal(
    prohibitedReason({ policyDelta: { host: "integrate.api.nvidia.com" } }),
    "inference-host-direct",
    "adding the inference host directly bypasses credential brokering",
  );
});

test("destructive git on refs we do not own is refused", () => {
  assert.equal(
    prohibitedReason({ tool: "git.push", args: { ref: "main", force: true } }),
    "force-push-shared-ref",
  );
  assert.equal(
    prohibitedReason({ tool: "git.branch", args: { ref: "leftovers/cv", delete: true } }),
    "delete-foreign-branch",
  );
  assert.equal(
    prohibitedReason({ tool: "git.push", args: { ref: "omoda/feature", force: true } }),
    null,
    "our own branches are ours to force-push",
  );
});
