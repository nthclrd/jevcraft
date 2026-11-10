/** Server addresses as people paste them: `host`, `host:port`, `[ipv6]:port` or a bare IPv6 address. */
export interface Address {
  host: string
  port?: number
}

export function parseAddress(input: string): Address {
  const trimmed = input.trim()
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed)
  if (bracketed) return bracketed[2] ? { host: bracketed[1], port: Number(bracketed[2]) } : { host: bracketed[1] }
  const parts = trimmed.split(':')
  // A bare IPv6 address has several colons; only a single colon can be the port separator.
  if (parts.length === 2 && parts[0] && (/^\d+$/.test(parts[1]) || parts[1] === '')) {
    return parts[1] ? { host: parts[0], port: Number(parts[1]) } : { host: parts[0] }
  }
  return { host: trimmed }
}
