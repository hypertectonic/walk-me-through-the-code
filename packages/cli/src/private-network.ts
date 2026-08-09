import { createSocket } from "node:dgram";

interface NetworkInterfaceAddress {
  readonly address: string;
  readonly family: string | number;
}

type NetworkInterfaces = Readonly<Record<string, readonly NetworkInterfaceAddress[] | undefined>>;

function parseCanonicalIpv4(address: string): readonly number[] | undefined {
  const octets = address.split(".");
  if (octets.length !== 4) return undefined;
  const values = octets.map((octet) => Number(octet));
  if (values.some((value, index) =>
    !Number.isInteger(value) || value < 0 || value > 255 || String(value) !== octets[index]
  )) return undefined;
  return values;
}

function socketIpv4Address(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  const mappedAddress = address.match(/^::ffff:(.+)$/i)?.[1] ?? address;
  const octets = parseCanonicalIpv4(mappedAddress);
  return octets === undefined ? undefined : octets.join(".");
}

function isLoopbackAddress(octets: readonly number[]): boolean {
  return octets[0] === 127;
}

function isRfc1918Address(octets: readonly number[]): boolean {
  const [first, second] = octets;
  return first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function isCgnatAddress(octets: readonly number[]): boolean {
  return octets[0] === 100 && octets[1] !== undefined && octets[1] >= 64 && octets[1] <= 127;
}

function isRfc1918OrLoopbackAddress(address: string): boolean {
  const octets = parseCanonicalIpv4(address);
  return octets !== undefined && (isLoopbackAddress(octets) || isRfc1918Address(octets));
}

function compareIpv4(left: string, right: string): number {
  const leftOctets = parseCanonicalIpv4(left) ?? [];
  const rightOctets = parseCanonicalIpv4(right) ?? [];
  for (let index = 0; index < 4; index += 1) {
    const difference = (leftOctets[index] ?? 0) - (rightOctets[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function routedPrivateIpv4Address(): Promise<string | undefined> {
  const socket = createSocket("udp4");
  return await new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => finish(), 1_000);
    timeout.unref();

    const finish = (address?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // A route lookup can fail before the socket is bound.
      }
      const octets = address === undefined ? undefined : parseCanonicalIpv4(address);
      resolve(octets !== undefined && isRfc1918Address(octets) ? address : undefined);
    };

    socket.once("error", () => finish());
    socket.connect(9, "192.0.2.1", () => {
      const address = socket.address();
      finish(typeof address === "string" ? undefined : address.address);
    });
  });
}

export function privateNetworkAddresses(
  interfaces: NetworkInterfaces,
  tailscaleAddresses: readonly string[] = [],
  routedLanAddress?: string,
): readonly string[] {
  const attributedTailscaleAddresses = new Set(tailscaleAddresses.filter((address) => {
    const octets = parseCanonicalIpv4(address);
    return octets !== undefined && isCgnatAddress(octets);
  }));
  const privateAddresses = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      const octets = parseCanonicalIpv4(entry.address);
      if (octets !== undefined && isRfc1918Address(octets)) privateAddresses.add(entry.address);
    }
  }
  const selectedPrivateAddresses = routedLanAddress !== undefined &&
      privateAddresses.has(routedLanAddress)
    ? [routedLanAddress]
    : [...privateAddresses];
  const addresses = new Set([
    "127.0.0.1",
    ...attributedTailscaleAddresses,
    ...selectedPrivateAddresses,
  ]);
  return ["127.0.0.1", ...[...addresses]
    .filter((address) => address !== "127.0.0.1")
    .sort(compareIpv4)];
}

export interface ViewerTransport {
  readonly advertisedAddresses: readonly string[];
  readonly localAddress: string | undefined;
  readonly remoteAddress: string | undefined;
  readonly share: "loopback" | "private";
  readonly tailscaleAddresses?: readonly string[];
}

export function isPermittedViewerTransport({
  advertisedAddresses,
  localAddress,
  remoteAddress,
  share,
  tailscaleAddresses = [],
}: ViewerTransport): boolean {
  const localIpv4 = socketIpv4Address(localAddress);
  const remoteIpv4 = socketIpv4Address(remoteAddress);
  if (localIpv4 === undefined || remoteIpv4 === undefined) return false;
  if (share === "loopback") return localIpv4 === "127.0.0.1" && remoteIpv4 === "127.0.0.1";
  if (!advertisedAddresses.includes(localIpv4)) return false;
  if (isRfc1918OrLoopbackAddress(remoteIpv4)) return true;
  const localOctets = parseCanonicalIpv4(localIpv4);
  const remoteOctets = parseCanonicalIpv4(remoteIpv4);
  return localOctets !== undefined &&
    isCgnatAddress(localOctets) &&
    remoteOctets !== undefined &&
    isCgnatAddress(remoteOctets) &&
    tailscaleAddresses.includes(localIpv4);
}

export interface ViewerRequest extends ViewerTransport {
  readonly allowedHosts: ReadonlySet<string>;
  readonly host: string | undefined;
  readonly origin: string | undefined;
}

export function viewerRequestFailure(request: ViewerRequest): "host" | "origin" | "transport" | undefined {
  if (!isPermittedViewerTransport(request)) return "transport";
  if (request.host === undefined || !request.allowedHosts.has(request.host)) return "host";
  return request.origin === undefined || request.origin === `http://${request.host}`
    ? undefined
    : "origin";
}
