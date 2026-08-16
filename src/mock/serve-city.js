#!/usr/bin/env node
// Run the mock city-services layer. Binds inside our 3100-3199 block.
//
//   node src/mock/serve-city.js          # 127.0.0.1:3120
//   OMODA_CITY_HOST=100.71.143.26 ...    # tailnet, for the dashboard/agents
//
// The catalog's OpenShell-protection labels come from the live skills manifest,
// so what the mock says is dangerous is what the platform actually gates.

import { createCityServices } from "./city-services.js";
import { loadSkills, buildCapabilityIndex } from "../skills/load.js";

const PORT = Number(process.env.OMODA_CITY_PORT ?? 3120);
const HOST = process.env.OMODA_CITY_HOST ?? "127.0.0.1";

const registry = buildCapabilityIndex(loadSkills().skills);
const { server } = createCityServices({ registry });
server.listen(PORT, HOST, () => {
  console.log(`city-services mock on http://${HOST}:${PORT}`);
  console.log(`  catalog: http://${HOST}:${PORT}/api/catalog`);
});
