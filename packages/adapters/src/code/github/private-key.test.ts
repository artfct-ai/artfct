import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { normalizePrivateKeyPem, pkcs1ToPkcs8 } from "./private-key";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS8_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PKCS1_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function derOf(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

describe("pkcs1ToPkcs8", () => {
  const pkcs1 = derOf(PKCS1_PEM);
  const pkcs8 = pkcs1ToPkcs8(pkcs1);

  it("opens a DER sequence with a two byte length", () => {
    expect(Array.from(pkcs8.slice(0, 2))).toEqual([0x30, 0x82]);
  });

  it("adds the PrivateKeyInfo header with the rsaEncryption identifier", () => {
    expect(pkcs8.length).toBe(pkcs1.length + 26);
  });

  it("gives the bytes node exports for the same key", () => {
    expect(Buffer.from(pkcs8).equals(derOf(PKCS8_PEM))).toBe(true);
  });
});

describe("normalizePrivateKeyPem", () => {
  describe("a PKCS#8 key", () => {
    it("returns it untouched", () => {
      expect(normalizePrivateKeyPem(PKCS8_PEM)).toBe(PKCS8_PEM);
    });
  });

  describe("the PKCS#1 key GitHub downloads", () => {
    const normalized = normalizePrivateKeyPem(PKCS1_PEM);

    it("starts from a PEM node labels as an RSA private key", () => {
      expect(PKCS1_PEM).toContain("BEGIN RSA PRIVATE KEY");
    });

    it("rewrites the PEM envelope", () => {
      const lines = normalized.split("\n");
      expect(lines[0]).toBe("-----BEGIN PRIVATE KEY-----");
      expect(lines.at(-1)).toBe("-----END PRIVATE KEY-----");
    });

    it("holds the same key node parses back to PKCS#8", () => {
      const reparsed = createPrivateKey(normalized).export({ type: "pkcs8", format: "pem" });
      expect(reparsed.toString()).toBe(PKCS8_PEM);
    });

    it("produces a key WebCrypto imports as pkcs8", async () => {
      const key = await crypto.subtle.importKey(
        "pkcs8",
        derOf(normalized),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      expect(key.type).toBe("private");
    });
  });
});
