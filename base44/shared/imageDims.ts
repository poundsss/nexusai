// Minimal pure-JS image dimension reader for PNG and JPEG — no image library, no canvas.
//
// Reads pixel dimensions from the file HEADER bytes only, which is exactly what the documented
// project-logo 1024×1024 limit needs to enforce server-side without decoding the image. A forged
// declared size cannot get past this: the dimensions come from the actual image header, and the
// byte length is measured on the decoded buffer.

export function imageDimensions(bytes) {
  if (!bytes || bytes.length < 10) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR chunk at byte 8 — width@16, height@20 (big-endian).
  // Needs at least 24 header bytes.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes.length < 24) return null;
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }

  // JPEG: FFD8 SOI, then scan for a SOF marker (C0..CF except C4/C8/CC) and read height/width.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      // Fill bytes (FF FF) — skip one and keep scanning.
      if (marker === 0xff) { i++; continue; }
      // Standalone markers with no length segment (TEM, RSTn, SOI, EOI).
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
      }
      const segLen = v.getUint16(i + 2);
      if (segLen < 2) return null;
      i += 2 + segLen;
    }
    return null;
  }

  return null;
}