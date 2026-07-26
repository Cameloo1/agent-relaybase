import { spawnSync } from "node:child_process";

export function openTrustedExternalUrl(url: string, env: NodeJS.ProcessEnv): boolean {
  if (!isTrustedExternalUrl(url)) {
    return false;
  }
  const child =
    process.platform === "win32"
      ? spawnSync("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
          windowsHide: true,
          shell: false,
          env,
          timeout: 5_000
        })
      : spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [url], {
          shell: false,
          env,
          timeout: 5_000
        });
  return !child.error && child.status === 0;
}

function isTrustedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === "https://openrouter.ai" && url.pathname === "/auth";
  } catch {
    return false;
  }
}
