/**
 * Decides whether the API may open a connection to an address an admin typed in
 * (a data source's database server). Without this, "connect to a database"
 * would let anyone with an admin account make the server knock on doors inside
 * its own network: cloud metadata endpoints, other services, localhost.
 *
 * The host name is resolved once, every address is checked, and the caller then
 * connects to that exact checked address (so a DNS answer can't change between
 * the check and the connection).
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** Never reachable, whatever the settings: "this host", cloud metadata, multicast, reserved. */
const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');
ALWAYS_BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, incl. 169.254.169.254 metadata
ALWAYS_BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4');
ALWAYS_BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4');
ALWAYS_BLOCKED.addSubnet('::', 128, 'ipv6');
ALWAYS_BLOCKED.addSubnet('fe80::', 10, 'ipv6');
ALWAYS_BLOCKED.addSubnet('ff00::', 8, 'ipv6');
ALWAYS_BLOCKED.addAddress('fd00:ec2::254', 'ipv6'); // AWS metadata over IPv6

/** Private networks: allowed only when DATA_SOURCES_ALLOW_PRIVATE is on (on-premises installs). */
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.0.0.0', 24, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('198.18.0.0', 15, 'ipv4');
PRIVATE.addSubnet('::1', 128, 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

export class BlockedAddressError extends Error {}

/** IPv4-mapped IPv6 (::ffff:10.0.0.1) is judged as the IPv4 address it really is. */
function normalise(address: string): { address: string; family: 'ipv4' | 'ipv6' } {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return { address: mapped[1]!, family: 'ipv4' };
  return { address, family: isIP(address) === 6 ? 'ipv6' : 'ipv4' };
}

export function checkAddress(address: string, allowPrivate: boolean): void {
  const a = normalise(address);
  if (ALWAYS_BLOCKED.check(a.address, a.family)) {
    throw new BlockedAddressError(`Connections to ${address} are not allowed`);
  }
  if (!allowPrivate && PRIVATE.check(a.address, a.family)) {
    throw new BlockedAddressError(
      `${address} is a private or local address. An administrator can allow these for an on-premises install (DATA_SOURCES_ALLOW_PRIVATE).`,
    );
  }
}

const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/;

export function isValidHost(host: string): boolean {
  return isIP(host) !== 0 || HOSTNAME.test(host);
}

/** Resolves and checks a host. Returns the one address to connect to. */
export async function resolveTarget(host: string, allowPrivate: boolean): Promise<string> {
  if (!isValidHost(host)) throw new BlockedAddressError('That is not a valid host name or IP address');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (addresses.length === 0) throw new BlockedAddressError(`${host} did not resolve to any address`);
  // Every answer must pass, or a name could mix one public and one internal address.
  for (const a of addresses) checkAddress(a, allowPrivate);
  return addresses[0]!;
}
