function bytesToHex(bytes: Uint8Array) {
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, "0"));
  return hex.join("");
}

function uuidV4FromBytes(bytes: Uint8Array) {
  // RFC 4122 variant + version.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Best-effort UUID-ish id for UI thread keys.
 *
 * `crypto.randomUUID()` is not available in non-secure contexts (e.g. http://100.x.y.z),
 * so we fall back to getRandomValues() and then to Math.random().
 */
export function randomId() {
  const cryptoObj = typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;
  const randomUUID = cryptoObj && "randomUUID" in cryptoObj ? (cryptoObj.randomUUID as unknown) : undefined;
  if (typeof randomUUID === "function") {
    try {
      return (randomUUID as () => string)();
    } catch {
      // Fall through
    }
  }

  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    try {
      const bytes = new Uint8Array(16);
      cryptoObj.getRandomValues(bytes);
      return uuidV4FromBytes(bytes);
    } catch {
      // Fall through
    }
  }

  // Insecure context fallback: URL-safe base36 chunks.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  const rand2 = Math.random().toString(36).slice(2, 10);
  return `${ts}-${rand}-${rand2}`;
}

