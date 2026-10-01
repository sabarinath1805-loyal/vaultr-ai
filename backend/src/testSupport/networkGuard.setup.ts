import { createRequire } from "node:module";

// Keep the guard in a plain CommonJS preload so it can also protect Node's
// native test runner and both Vitest projects without a second implementation.
const require = createRequire(__filename);
const guard = require("../../../scripts/test-network-guard.cjs") as {
  install: (targetGlobal: typeof globalThis) => void;
};
guard.install(globalThis);
