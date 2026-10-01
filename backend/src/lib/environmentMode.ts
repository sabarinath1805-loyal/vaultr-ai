type Environment = NodeJS.ProcessEnv;

const PRODUCTION_MODES = new Set([
  "production",
  "prod",
  "staging",
  "stage",
  "preproduction",
  "pre-production",
  "preprod",
  "preview",
]);

const LOCAL_MODES = new Set([
  "development",
  "dev",
  "test",
  "local",
  "ci",
]);

function modeValues(env: Environment): string[] {
  return [env.NODE_ENV, env.VAULTR_ENV]
    .map((value) => value?.trim().toLowerCase() ?? "")
    .filter(Boolean);
}

/** Treat common deployment aliases consistently across security-sensitive code. */
export function isProductionEnvironment(env: Environment = process.env): boolean {
  return modeValues(env).some((value) => PRODUCTION_MODES.has(value));
}

/** Whether an operator explicitly selected a local, test, or CI runtime. */
export function isExplicitLocalEnvironment(
  env: Environment = process.env,
): boolean {
  const modes = modeValues(env);
  return (
    !modes.some((value) => PRODUCTION_MODES.has(value)) &&
    modes.some((value) => LOCAL_MODES.has(value))
  );
}
