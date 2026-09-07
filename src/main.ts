import { createRuntimeFromEnvironment } from "./runtime.js";
import { startStdio } from "./stdio.js";

let runtime: ReturnType<typeof createRuntimeFromEnvironment> | undefined;
try {
  runtime = createRuntimeFromEnvironment();
  await startStdio(runtime.service);
  await new Promise<void>((resolve) => process.stdin.once("close", resolve));
} catch (error) {
  const message = error instanceof Error ? error.message : "The mail gateway could not start safely.";
  process.stderr.write(`hermes-mail-gateway: ${message}\n`);
  process.exitCode = 1;
} finally {
  runtime?.close();
}
