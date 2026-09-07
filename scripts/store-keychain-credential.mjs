import { setPassword } from "cross-keychain";

const GENERIC_ERROR = "Unable to store credential.";
const MAX_ARGUMENT_LENGTH = 256;

function validMetadataArgument(value) {
  return value.length > 0 &&
    value.length <= MAX_ARGUMENT_LENGTH &&
    !/[\u0000-\u001f\u007f\s]/u.test(value);
}

function readPassword() {
  return new Promise((resolve, reject) => {
    let password = "";
    let settled = false;
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish(reject, new Error("cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(resolve, password);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          password = password.slice(0, -1);
          continue;
        }
        password += character;
      }
    };
    const onEnd = () => finish(reject, new Error("input ended"));
    const onError = (error) => finish(reject, error);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}

async function main() {
  const argumentsFromCommandLine = process.argv.slice(2);
  if (argumentsFromCommandLine.length !== 2 || !argumentsFromCommandLine.every(validMetadataArgument)) {
    throw new Error("invalid arguments");
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("a terminal is required");
  }

  const [service, account] = argumentsFromCommandLine;
  let rawModeEnabled = false;
  let password;
  try {
    process.stderr.write("Password: ");
    process.stdin.setRawMode(true);
    rawModeEnabled = true;
    process.stdin.resume();
    password = await readPassword();
    await setPassword(service, account, password);
  } finally {
    password = undefined;
    if (rawModeEnabled) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stderr.write("\n");
  }
}

try {
  await main();
} catch {
  process.stderr.write(`${GENERIC_ERROR}\n`);
  process.exitCode = 1;
}
