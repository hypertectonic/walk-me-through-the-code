import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname } from "node:path";

type TailscaleAddressQuery = (
  executable: string,
) => Promise<readonly string[] | undefined>;

export function tailscaleExecutableCandidates(
  platform: NodeJS.Platform,
): readonly string[] {
  switch (platform) {
    case "darwin":
      return [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
      ];
    case "linux":
      return [
        "/usr/bin/tailscale",
        "/usr/sbin/tailscale",
        "/usr/local/bin/tailscale",
        "/snap/bin/tailscale",
      ];
    case "win32":
      return [
        "C:\\Program Files\\Tailscale\\tailscale.exe",
        "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
      ];
    default:
      return [];
  }
}

async function queryTailscaleIpv4Addresses(
  executable: string,
): Promise<readonly string[] | undefined> {
  try {
    await access(executable, constants.X_OK);
  } catch {
    return undefined;
  }
  return new Promise((resolveAddresses) => {
    try {
      execFile(executable, ["ip", "-4"], {
        cwd: dirname(executable),
        encoding: "utf8",
        maxBuffer: 4_096,
        timeout: 1_000,
        windowsHide: true,
      }, (error, stdout) => {
        resolveAddresses(
          error === null ? stdout.split(/\s+/).filter(Boolean) : undefined,
        );
      });
    } catch {
      resolveAddresses(undefined);
    }
  });
}

export async function tailscaleIpv4Addresses(
  platform: NodeJS.Platform = process.platform,
  query: TailscaleAddressQuery = queryTailscaleIpv4Addresses,
): Promise<readonly string[]> {
  for (const executable of tailscaleExecutableCandidates(platform)) {
    const addresses = await query(executable);
    if (addresses !== undefined) return addresses;
  }
  return [];
}
