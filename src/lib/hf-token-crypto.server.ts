// Server-only helpers for encrypting the user's Hugging Face token
// at rest with AES-256-GCM. Key is derived from HF_TOKEN_ENC_KEY via
// SHA-256 so any secret length works safely.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key(): Buffer {
  const raw = process.env.HF_TOKEN_ENC_KEY;
  if (!raw) throw new Error("HF_TOKEN_ENC_KEY is not set");
  return createHash("sha256").update(raw).digest();
}

export function encryptHfToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptHfToken(stored: string): string {
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
