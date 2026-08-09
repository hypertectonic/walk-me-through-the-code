import type { Server } from "node:http";
import type { Socket } from "node:net";

import {
  isPermittedViewerTransport,
  type ViewerTransport,
} from "./private-network.js";

type ViewerConnectionPolicy = Pick<
  ViewerTransport,
  "advertisedAddresses" | "share" | "tailscaleAddresses"
>;

interface SocketAddresses {
  readonly localAddress: string | undefined;
  readonly remoteAddress: string | undefined;
}

type SocketAddressResolver = (socket: Socket) => SocketAddresses;

function socketAddresses(socket: Socket): SocketAddresses {
  return {
    localAddress: socket.localAddress,
    remoteAddress: socket.remoteAddress,
  };
}

export function prependViewerConnectionGuard(
  server: Server,
  policy: ViewerConnectionPolicy,
  resolveAddresses: SocketAddressResolver = socketAddresses,
): void {
  server.prependListener("connection", (socket) => {
    if (!isPermittedViewerTransport({
      ...policy,
      ...resolveAddresses(socket),
    })) socket.destroy();
  });
}
