import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect, ensurePersona } from "./lib/connect.ts";

// Seeds the world as the `world` persona and attaches the hash of each
// rendered document. Reading the documents is the agent's job: see worker.ts.
// The AP lead and controller personas are left unbound for the browser tabs.

const world = await connect("world");
await ensurePersona(world, "world");
if (Number(world.db.load.count()) === 0) { await world.reducers.seedWorld({}); console.log("seeded world"); }

// Attach the hash of each rendered file when it exists; otherwise a labeled
// placeholder hash so the extraction/evidence chain still has a value to match.
let attached = 0, placeholders = 0;
for (const d of world.db.document.iter()) {
  if (d.contentHash !== "") continue;
  const file = `world/out/${d.id}.pdf`;
  const real = existsSync(file);
  const hash = real ? createHash("sha256").update(readFileSync(file)).digest("hex") : `placeholder-${d.id}`;
  await world.reducers.attachDocumentFile({ documentId: d.id, contentHash: hash, path: real ? `docs/${d.id}.pdf` : "" });
  real ? attached++ : placeholders++;
}
console.log(`attached ${attached} document hashes${placeholders ? ` (${placeholders} placeholders; run npx tsx world/render-docs.ts first)` : ""}`);
world.disconnect();
