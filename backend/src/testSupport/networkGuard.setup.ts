import { createRequire } from "node:module";

// Keep the guard in a plain CommonJS preload so it can also protect Node's
// native test runner and both Vitest projects without a second implementation.
const requireFromBackend = createRequire(__filename);
const guard = requireFromBackend("../../../scripts/test-network-guard.cjs") as {
  install: (targetGlobal: typeof globalThis) => void;
};
guard.install(globalThis);
