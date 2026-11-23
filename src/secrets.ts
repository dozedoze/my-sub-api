import { GatewayError } from "./lib.ts";

/** 用户 MCP 密钥的静态加密。AES-256-GCM，密文绑定到用户和密钥名，不能挪给别的用户或别的名字。 */

const ENVELOPE = "v1";

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array {
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeMasterKey(raw: string | undefined): Uint8Array | null {
  const value = raw?.trim();
  if (!value) return null;
  let bytes: Uint8Array;
  try {
    bytes = /^[0-9a-f]{64}$/i.test(value)
      ? Uint8Array.from(value.match(/../g) ?? [], (h) => Number.parseInt(h, 16))
      : b64urlDecode(value);
  } catch {
    return null;
  }
  return bytes.length === 32 ? bytes : null;
}

/** 是否配置了合法的主密钥。没配置时一切写入密钥的操作都应该拒绝。 */
export function secretsConfigured(env: { USER_SECRETS_KEY?: string }): boolean {
  return decodeMasterKey(env.USER_SECRETS_KEY) !== null;
}

async function importKey(env: { USER_SECRETS_KEY?: string }): Promise<CryptoKey> {
  const bytes = decodeMasterKey(env.USER_SECRETS_KEY);
  if (!bytes) {
    throw new GatewayError(503, "secrets_unconfigured", "Secret storage is not configured on this gateway");
  }
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function aad(userId: string, name: string): BufferSource {
  return new TextEncoder().encode(`mcp-secret:${ENVELOPE}:${userId}:${name}`) as BufferSource;
}

export async function encryptSecret(
  env: { USER_SECRETS_KEY?: string },
  userId: string,
  name: string,
  plaintext: string,
): Promise<string> {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(userId, name) },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  return `${ENVELOPE}.${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

export async function decryptSecret(
  env: { USER_SECRETS_KEY?: string },
  userId: string,
  name: string,
  envelope: string,
): Promise<string> {
  const key = await importKey(env);
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== ENVELOPE) {
    throw new GatewayError(500, "secrets_corrupt", `Secret '${name}' cannot be read`);
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(parts[1]) as BufferSource, additionalData: aad(userId, name) },
      key,
      b64urlDecode(parts[2]) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    // 主密钥换过，或密文被挪动。不暴露细节。
    throw new GatewayError(500, "secrets_corrupt", `Secret '${name}' cannot be read; set it again`);
  }
}
