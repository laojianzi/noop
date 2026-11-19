import { appendFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.NOOP_EXECUTOR_FIXTURE!;
const drop = join(dir, "drop-settings-ack"), hold = join(dir, "hold-old-status");
const delivery = join(dir, "settings-delivery-order");
const fetchNetwork = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  if (typeof input === "string" && input.endsWith("/api/host/state") &&
    init?.method === "PUT" && typeof init.body === "string") {
    const { settings, status } = JSON.parse(init.body);
    if (settings && !status && existsSync(drop)) {
      renameSync(drop, drop + "-observed");
      throw new Error("fixture dropped the settings acknowledgement");
    }
    if (settings && status && existsSync(hold)) {
      renameSync(hold, hold + "-observed");
      while (!existsSync(hold + "-release") && !init.signal?.aborted) await Bun.sleep(50);
      const response = await fetchNetwork(input, init);
      if (response.ok) appendFileSync(delivery, "status\n");
      return response;
    }
    if (settings && !status && existsSync(hold + "-observed")) {
      const response = await fetchNetwork(input, init);
      if (response.ok) appendFileSync(delivery, "ack\n");
      return response;
    }
  }
  return fetchNetwork(input, init);
}) as typeof fetch;
