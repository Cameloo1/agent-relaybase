export function parseNpmPackJson(output) {
  const text = String(output ?? "").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // npm forwards lifecycle output before its final JSON payload. Walk backward
    // through line-start arrays so verbose native builds cannot hide the pack result.
  }
  const starts = [];
  if (text.startsWith("[")) starts.push(0);
  for (let index = text.indexOf("\n["); index >= 0; index = text.indexOf("\n[", index + 2)) {
    starts.push(index + 1);
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(text.slice(starts[index]));
    } catch {
      continue;
    }
  }
  return undefined;
}

export function npmPackArguments(options = {}) {
  const args = ["pack"];
  if (options.dryRun) args.push("--dry-run");
  if (options.destination) args.push("--pack-destination", options.destination);
  return [...args, "--json", "--ignore-scripts"];
}
