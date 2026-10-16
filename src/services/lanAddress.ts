import os from 'node:os';

/**
 * This PC's address on the local network — what a phone on the same Wi-Fi
 * types in to reach it. `localhost` on a phone means the phone itself.
 *
 * Mirrors `getLanAddress` in electron/main.cjs: virtual adapters (VirtualBox,
 * Hyper-V, WSL, VPNs) are unreachable from a phone, so real Wi-Fi/Ethernet on
 * a private range wins.
 */
export const lanAddress = (): string | null => {
  const candidates: { address: string; score: number }[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const virtual = /virtual|vbox|vmware|hyper-v|vethernet|wsl|docker|loopback|tailscale|zerotier/i.test(name);
      const privateRange = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      candidates.push({ address: a.address, score: (virtual ? 0 : 2) + (privateRange ? 1 : 0) });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  return candidates[0]?.address ?? null;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/**
 * Swaps a `localhost` address for this PC's LAN address, keeping the port.
 *
 * Invite and reset links are opened on somebody else's phone. A link to
 * `localhost` opens nothing there, so on a gym's own PC — where APP_URL is
 * usually left at localhost — the link is rewritten to the address the phone
 * can actually reach. A real domain is left exactly as configured.
 */
export const reachableUrl = (url: string): string => {
  const trimmed = url.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) return trimmed;
  const lan = lanAddress();
  if (!lan) return trimmed;
  parsed.hostname = lan;
  return parsed.toString().replace(/\/+$/, '');
};
