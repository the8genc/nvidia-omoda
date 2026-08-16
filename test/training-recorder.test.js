import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus } from "../src/bus.js";
import { createTriggerStore } from "../src/transport/triggers.js";
import { createTrainingRecorder } from "../src/training/recorder.js";

const mkTriggers = () => createTriggerStore({ path: join(mkdtempSync(join(tmpdir(), "omoda-tt-")), "t.json") });

test("the recorder labels and appends only while active, and start/stop are idempotent", () => {
  const bus = createBus();
  const dir = mkdtempSync(join(tmpdir(), "omoda-train-"));
  const rec = createTrainingRecorder({ bus, triggers: mkTriggers(), dir });

  // not recording yet: bus traffic is ignored
  bus.publish("observation", { description: "quiet street", verdict: "nominal" });
  assert.equal(rec.status().active, false);

  const started = rec.start();
  assert.equal(started.ok, true);
  assert.equal(rec.start().already, true, "start is idempotent");

  bus.publish("observation", { description: "A car is on fire at the intersection.", verdict: "incident", incidentType: "fire" });
  bus.publish("observation", { description: "A truck is overturned, blocking lanes.", verdict: "nominal" }); // trigger hit -> action
  bus.publish("observation", { description: "Empty intersection at dawn. No pedestrians.", verdict: "nominal" }); // normal

  const stopped = rec.stop();
  assert.equal(stopped.tally.total, 3);
  assert.equal(stopped.tally.action, 2, "the fire and the overturned truck are actions");
  assert.equal(stopped.tally.normal, 1);

  // after stop, further traffic is not recorded
  bus.publish("observation", { description: "another fire", verdict: "incident" });
  assert.equal(rec.status().tally.total, 3);

  const file = readdirSync(dir).find((f) => f.startsWith("training-live-"));
  const rows = readFileSync(join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].label, "action");
  assert.equal(rows[0].incidentType, "fire");
  assert.equal(rows[1].triggerPhrase, "overturned", "the new overturned trigger fired");
});
