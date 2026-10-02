/**
 * GitHub downloads App private keys as PKCS#1, and `@octokit/auth-app` takes only PKCS#8.
 * This wraps the one envelope in the other with plain DER arithmetic.
 */

const PKCS1_LABEL = "RSA PRIVATE KEY";
const PKCS8_LABEL = "PRIVATE KEY";
const PEM_LINE_LENGTH = 64;

/** DER `AlgorithmIdentifier` for rsaEncryption (OID 1.2.840.113549.1.1.1) with NULL parameters. */
const RSA_ALGORITHM = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

/** DER `INTEGER 0`, the PKCS#8 version. */
const PKCS8_VERSION = [0x02, 0x01, 0x00];

/** Decode a PEM body into DER bytes. Header and footer lines are ignored. */
function pemToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

/** Encode DER bytes as PEM with the given label, wrapped at 64 columns. */
function derToPem(der: Uint8Array, label: string): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(new RegExp(`.{1,${PEM_LINE_LENGTH}}`, "g")) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

/** DER tag plus a two-byte long-form length. RSA keys are always between 256 and 65535 bytes. */
function derHeader(tag: number, length: number): number[] {
  return [tag, 0x82, length >> 8, length & 0xff];
}

/** Wrap a PKCS#1 `RSAPrivateKey` DER in the PKCS#8 `PrivateKeyInfo` envelope. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const octetString = [...derHeader(0x04, pkcs1.length), ...pkcs1];
  const body = [...PKCS8_VERSION, ...RSA_ALGORITHM, ...octetString];
  return new Uint8Array([...derHeader(0x30, body.length), ...body]);
}

/** A PKCS#8 PEM for a private key given in either form. PKCS#8 input is returned untouched. */
export function normalizePrivateKeyPem(pem: string): string {
  if (!pem.includes(`BEGIN ${PKCS1_LABEL}`)) return pem;
  return derToPem(pkcs1ToPkcs8(pemToDer(pem)), PKCS8_LABEL);
}
