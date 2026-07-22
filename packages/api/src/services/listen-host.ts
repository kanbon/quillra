import { isIP } from "node:net";

/** Resolve the interface the API binds to without accepting URLs or paths. */
export function resolveListenHost(rawHost = process.env.HOST): string {
  const host = rawHost?.trim() || "0.0.0.0";
  if (host === "localhost" || isIP(host) !== 0) return host;
  throw new Error("HOST must be localhost or a valid IPv4/IPv6 address");
}
