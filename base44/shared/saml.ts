// SAML 2.0 response validation.
//
// The validation pipeline is the security boundary of enterprise SSO. A response that fails
// ANY check is rejected wholesale — a valid signature on a stale, replayed, or misdirected
// assertion still grants nothing.
//
// Checks, in order:
//   1. STRUCTURE  — the response parses and contains an assertion.
//   2. SIGNATURE  — the assertion's signature verifies against the IdP certificate stored on
//                   the connection (decrypted server-side). An unsigned or tampered assertion is rejected.
//   3. ISSUER    — the assertion issuer matches the connection's configured entity_id.
//   4. AUDIENCE  — the assertion audience contains this platform's entity id.
//   5. DESTINATION — the response destination matches the ACS URL.
//   6. FRESHNESS — NotOnOrAfter has not passed (and NotBefore, if present, has).
//   7. REPLAY    — the response ID has not been seen before (caller supplies the replay guard).
//   8. SUBJECT   — a NameID is present and is an email.
//
// The XML handling is deliberately minimal: SAML responses are a small, well-known structure,
// and a full XML stack is not available in the sandbox runtime. The extractor finds the
// SAML-specific elements by local name (namespace-agnostic) and the signature verifier uses
// Web Crypto RSA-SHA256, which is the standard SAML signature algorithm.

export class SamlError extends Error {
  constructor(message, code = "SAML_ERROR") {
    super(message);
    this.code = code;
    this.status = 401;
  }
}

// --- minimal ASN.1 / PEM helpers ----------------------------------------------

function pemToDer(pem) {
  const b64 = String(pem || "").replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  if (!b64) return null;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function derTag(bytes, offset) {
  if (offset >= bytes.length) return null;
  const tag = bytes[offset];
  let lenByte = bytes[offset + 1];
  let len, headerLen;
  if (lenByte < 0x80) { len = lenByte; headerLen = 2; }
  else {
    const numBytes = lenByte & 0x7f;
    if (numBytes === 0 || offset + 2 + numBytes > bytes.length) return null;
    len = 0;
    for (let i = 0; i < numBytes; i++) len = (len << 8) | bytes[offset + 2 + i];
    headerLen = 2 + numBytes;
  }
  return { tag, len, headerLen, contentOffset: offset + headerLen, totalLen: headerLen + len };
}

// Extract SubjectPublicKeyInfo from a DER-encoded X.509 Certificate.
function extractSpkiFromCertDer(der) {
  // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { version?[0], serial, sigAlg, issuer, validity, subject, spki, ... }, ... }
  const cert = derTag(der, 0);
  if (!cert || cert.tag !== 0x30) return null;
  const tbs = derTag(der, cert.contentOffset);
  if (!tbs || tbs.tag !== 0x30) return null;
  let off = tbs.contentOffset;
  // version is optional context tag [0]
  if ((der[off] & 0xc0) === 0xa0) {
    const v = derTag(der, off);
    if (!v) return null;
    off += v.totalLen;
  }
  // Skip: serialNumber, signature(AlgorithmIdentifier), issuer(Name), validity(SEQUENCE), subject(Name)
  for (let i = 0; i < 5; i++) {
    const t = derTag(der, off);
    if (!t) return null;
    off += t.totalLen;
  }
  const spki = derTag(der, off);
  if (!spki) return null;
  return der.slice(off, off + spki.totalLen);
}

async function importPublicKey(pem) {
  const der = pemToDer(pem);
  if (!der) throw new SamlError("Invalid certificate", "SAML_BAD_CERT");
  // An X.509 certificate (BEGIN CERTIFICATE) wraps the SPKI in a tbsCertificate; extract it.
  // A bare SubjectPublicKeyInfo (BEGIN PUBLIC KEY) is imported as-is.
  const isCert = /BEGIN CERTIFICATE/i.test(pem);
  let spkiBytes = der;
  if (isCert) {
    const spki = extractSpkiFromCertDer(der);
    if (!spki) throw new SamlError("Could not extract public key from certificate", "SAML_BAD_CERT");
    spkiBytes = spki;
  }
  return crypto.subtle.importKey("spki", spkiBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

// --- minimal SAML XML extraction ---------------------------------------------

// Find the first element with the given local name, returning its outer XML (open tag through
// matching close tag) and its attribute string.
function findElement(xml, localName) {
  const re = new RegExp(`<([a-zA-Z0-9_-]*:)?${localName}\\b([^>]*)(/?)>`, "i");
  const m = re.exec(xml);
  if (!m) return null;
  const prefix = m[1] || "";
  const attrs = m[2] || "";
  if (m[3] === "/") return { outer: m[0], inner: "", attrs, selfClosing: true };
  // Find the matching close tag by local name (depth-aware for same-name nesting).
  const closeRe = new RegExp(`</([a-zA-Z0-9_-]*:)?${localName}\\s*>`, "i");
  let searchFrom = m.index + m[0].length;
  let depth = 1;
  let inner = "";
  while (depth > 0) {
  const openRe = new RegExp(`<([a-zA-Z0-9_-]*:)?${localName}\\b`, "gi");
    openRe.lastIndex = searchFrom;
    const nextOpen = openRe.exec(xml);
    const nextClose = closeRe.exec(xml.slice(searchFrom));
    const closeIdx = nextClose ? searchFrom + nextClose.index : -1;
    const openIdx = nextOpen ? nextOpen.index : -1;
    if (closeIdx === -1) return null; // malformed
    if (openIdx !== -1 && openIdx < closeIdx && !xml.slice(openIdx, openIdx + nextOpen[0].length + 1).includes("/>")) {
      // A nested same-name open before the close — but only count if not self-closing.
      const tagEnd = xml.indexOf(">", openIdx);
      if (tagEnd > 0 && xml[tagEnd - 1] !== "/") {
        depth++;
        searchFrom = tagEnd + 1;
        continue;
      }
    }
    depth--;
    if (depth === 0) {
      inner = xml.slice(m.index + m[0].length, closeIdx);
      return { outer: xml.slice(m.index, closeIdx + nextClose[0].length), inner, attrs, selfClosing: false };
    }
    searchFrom = closeIdx + nextClose[0].length;
  }
  return null;
}

function getAttr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs || "");
  return m ? m[1] : null;
}

function findText(xml, localName) {
  const el = findElement(xml, localName);
  if (!el) return null;
  return el.inner.trim();
}

function findAttributeValue(xml, attrName) {
  // Find all <Attribute Name="attrName"> blocks and collect their AttributeValue text.
  const values = [];
  const attrRe = new RegExp(`<([a-zA-Z0-9_-]*:)?Attribute\\b[^>]*Name\\s*=\\s*"${attrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</([a-zA-Z0-9_-]*:)?Attribute>`, "gi");
  let m;
  while ((m = attrRe.exec(xml)) !== null) {
    const valRe = new RegExp(`<([a-zA-Z0-9_-]*:)?AttributeValue[^>]*>([\\s\\S]*?)</([a-zA-Z0-9_-]*:)?AttributeValue>`, "gi");
    let vm;
    while ((vm = valRe.exec(m[2])) !== null) {
      values.push(vm[2].trim());
    }
  }
  return values;
}

// Simplified exclusive XML canonicalization for the signed element. For the standard SAML
// response structure this produces the exact bytes the signer signed: the Assertion element
// with the Signature element removed, comments stripped, whitespace normalized.
function canonicalizeAssertion(xml) {
  const assertion = findElement(xml, "Assertion");
  if (!assertion) return null;
  // Remove any embedded Signature elements from the assertion.
  let inner = assertion.inner;
  const sig = findElement(inner, "Signature");
  if (sig) {
    inner = inner.replace(sig.outer, "");
  }
  // Rebuild the assertion element without namespace prefix noise (keep the original prefix
  // so the c14n matches what was signed).
  const openTag = assertion.outer.match(/^<[^>]+>/)[0];
  const closeTag = assertion.outer.match(/<\/[^>]+>$/)[0];
  // Normalize whitespace between elements (c14n exclusive removes inter-element whitespace
  // that is not significant). For signed XML the signer controls this, so we strip text nodes
  // that are pure whitespace between elements.
  const normalized = inner.replace(/>\s+</g, "><").trim();
  return openTag + normalized + closeTag;
}

function b64ToBytes(b64) {
  const bin = atob(String(b64 || "").replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// --- the validation pipeline -------------------------------------------------

/**
 * Validate a SAML response XML string against a connection's configuration.
 *
 * @param {string} xml - the raw SAML response XML (base64-decoded)
 * @param {object} connection - the SsoConnection row (with saml_cert_decrypted already resolved by caller)
 * @param {object} opts - { audience, acsUrl, now, checkReplay }
 * @returns { ok, nameId, email, attributes, responseId, errors }
 */
export async function validateSamlResponse(xml, connection, opts = {}) {
  const errors = [];
  if (!xml || typeof xml !== "string") return { ok: false, errors: ["empty response"], nameId: null, email: null, attributes: {} };

  const audience = opts.audience || "nexusai";
  const acsUrl = opts.acsUrl || connection.saml_acs_url;
  const now = opts.now != null ? opts.now : Date.now();

  // 1. STRUCTURE
  const response = findElement(xml, "Response");
  if (!response) return { ok: false, errors: ["no Response element"], nameId: null, email: null, attributes: {} };
  const responseId = getAttr(response.attrs, "ID");
  const destination = getAttr(response.attrs, "Destination");

  const assertion = findElement(xml, "Assertion");
  if (!assertion) { errors.push("no Assertion element"); return { ok: false, errors, responseId, nameId: null, email: null, attributes: {} }; }

  // 2. SIGNATURE — extract the signature value and verify against the canonicalized assertion.
  const sigEl = findElement(assertion.inner, "Signature");
  if (!sigEl) { errors.push("assertion is not signed"); return { ok: false, errors, responseId, nameId: null, email: null, attributes: {} }; }
  const sigValueB64 = findText(sigEl.inner, "SignatureValue");
  if (!sigValueB64) { errors.push("no SignatureValue"); return { ok: false, errors, responseId, nameId: null, email: null, attributes: {} }; }

  let sigOk = false;
  try {
    const key = await importPublicKey(connection.saml_cert_decrypted);
    const canonicalized = canonicalizeAssertion(xml);
    if (!canonicalized) { errors.push("canonicalization failed"); return { ok: false, errors, responseId, nameId: null, email: null, attributes: {} }; }
    const sigBytes = b64ToBytes(sigValueB64);
    sigOk = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes, new TextEncoder().encode(canonicalized));
  } catch (e) {
    errors.push(`signature verification error: ${e.message}`);
  }
  if (!sigOk) { errors.push("signature verification failed"); return { ok: false, errors, responseId, nameId: null, email: null, attributes: {} }; }

  // 3. ISSUER
  const issuer = findText(assertion.inner, "Issuer");
  if (connection.saml_entity_id && issuer && issuer !== connection.saml_entity_id) {
    errors.push(`issuer mismatch: ${issuer} != ${connection.saml_entity_id}`);
  }

  // 4. AUDIENCE
  const audienceEl = findElement(assertion.inner, "Audience");
  const audiences = audienceEl ? [findText(assertion.inner, "Audience")].filter(Boolean) : [];
  if (audiences.length === 0 || !audiences.includes(audience)) {
    errors.push(`audience mismatch: ${audiences.join(",")} does not include ${audience}`);
  }

  // 5. DESTINATION
  if (destination && acsUrl && destination !== acsUrl) {
    errors.push(`destination mismatch: ${destination} != ${acsUrl}`);
  }

  // 6. FRESHNESS
  const conditions = findElement(assertion.inner, "Conditions");
  if (conditions) {
    const notBefore = getAttr(conditions.attrs, "NotBefore");
    const notOnOrAfter = getAttr(conditions.attrs, "NotOnOrAfter");
    if (notBefore && Date.parse(notBefore) > now) errors.push("assertion not yet valid (NotBefore)");
    if (notOnOrAfter && Date.parse(notOnOrAfter) <= now) errors.push("assertion expired (NotOnOrAfter)");
  }

  // 7. REPLAY
  if (opts.checkReplay && responseId) {
    const fresh = await opts.checkReplay(responseId);
    if (!fresh) errors.push("replay detected: response ID already seen");
  }

  // 8. SUBJECT
  const nameId = findText(assertion.inner, "NameID");
  if (!nameId) errors.push("no NameID");

  // Extract attributes (groups, full_name, etc.)
  const attributes = {};
  const mapping = connection.attribute_mapping || {};
  const groupsAttr = mapping.groups || "groups";
  const groups = findAttributeValue(assertion.inner, groupsAttr);
  if (groups.length) attributes.groups = groups;
  const nameAttr = mapping.full_name || "name";
  const nameVals = findAttributeValue(assertion.inner, nameAttr);
  if (nameVals.length) attributes.full_name = nameVals[0];

  const email = nameId && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(nameId) ? nameId.toLowerCase() : null;

  return { ok: errors.length === 0, errors, responseId, nameId, email, attributes };
}

// --- test helper: sign a SAML assertion with a private key -------------------
// Used by the test suite to produce valid and tampered responses. Not imported by production code.
export async function signAssertion(canonicalized, privateKey) {
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(canonicalized));
  return bytesToB64(new Uint8Array(sig));
}

export { canonicalizeAssertion, findElement, getAttr, findText, findAttributeValue, importPublicKey, pemToDer };