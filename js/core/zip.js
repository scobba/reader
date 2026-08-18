/* Minimal read-only ZIP reader.
 *
 * EPUB and DOCX are both just ZIP archives of XML, so ~120 lines here buys
 * both formats with no third-party dependency at all. Decompression uses the
 * platform's DecompressionStream('deflate-raw'), available in Safari 16.4+,
 * Chrome 103+ and Firefox 113+ — i.e. everywhere this app can run anyway.
 *
 * Only the two storage methods that actually occur in the wild are handled:
 * 0 (stored) and 8 (deflate).
 */

const EOCD_SIG   = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64L_SIG= 0x07064b50;
const CEN_SIG    = 0x02014b50;

export class ZipReader {
  #view; #buf; #entries = null;

  constructor(arrayBuffer) {
    this.#buf = arrayBuffer;
    this.#view = new DataView(arrayBuffer);
  }

  static async from(blobOrBuffer) {
    const buf = blobOrBuffer instanceof ArrayBuffer
      ? blobOrBuffer
      : await blobOrBuffer.arrayBuffer();
    const z = new ZipReader(buf);
    z.#readCentralDirectory();
    return z;
  }

  /** Map of path -> entry metadata. */
  get entries() { return this.#entries; }

  has(path) { return this.#entries.has(path); }

  list(re) {
    const out = [];
    for (const k of this.#entries.keys()) if (!re || re.test(k)) out.push(k);
    return out;
  }

  #readCentralDirectory() {
    const v = this.#view;
    const len = v.byteLength;

    // The EOCD record sits at the end, after an optional comment of up to 64 KB.
    let eocd = -1;
    const scanFrom = Math.max(0, len - 22 - 0xffff);
    for (let i = len - 22; i >= scanFrom; i--) {
      if (v.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive');

    let count  = v.getUint16(eocd + 10, true);
    let cenOff = v.getUint32(eocd + 16, true);

    // ZIP64 escape values mean the real numbers live in the ZIP64 EOCD.
    if (cenOff === 0xffffffff || count === 0xffff) {
      for (let i = eocd - 20; i >= 0; i--) {
        if (v.getUint32(i, true) === EOCD64L_SIG) {
          const z64 = Number(v.getBigUint64(i + 8, true));
          if (v.getUint32(z64, true) === EOCD64_SIG) {
            count  = Number(v.getBigUint64(z64 + 32, true));
            cenOff = Number(v.getBigUint64(z64 + 48, true));
          }
          break;
        }
      }
    }

    const dec = new TextDecoder('utf-8');
    const entries = new Map();
    let p = cenOff;

    for (let i = 0; i < count; i++) {
      if (p + 46 > len || v.getUint32(p, true) !== CEN_SIG) break;

      const flags   = v.getUint16(p + 8, true);
      const method  = v.getUint16(p + 10, true);
      const compSz  = v.getUint32(p + 20, true);
      const rawSz   = v.getUint32(p + 24, true);
      const nameLen = v.getUint16(p + 28, true);
      const extraLen= v.getUint16(p + 30, true);
      const cmtLen  = v.getUint16(p + 32, true);
      let   localOff= v.getUint32(p + 42, true);

      // The spec mandates forward slashes, but archives written by some
      // Windows tooling (including .NET's ZipFile.CreateFromDirectory) use
      // backslashes. Normalising here means a DOCX from such a tool still
      // resolves "word/document.xml".
      const name = dec.decode(new Uint8Array(this.#buf, p + 46, nameLen))
        .replace(/\\/g, '/');

      // ZIP64 extra field (0x0001) overrides any 0xffffffff placeholders.
      let compressedSize = compSz, size = rawSz;
      if (compSz === 0xffffffff || rawSz === 0xffffffff || localOff === 0xffffffff) {
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = v.getUint16(e, true), sz = v.getUint16(e + 2, true);
          if (id === 0x0001) {
            let q = e + 4;
            if (rawSz === 0xffffffff)    { size = Number(v.getBigUint64(q, true)); q += 8; }
            if (compSz === 0xffffffff)   { compressedSize = Number(v.getBigUint64(q, true)); q += 8; }
            if (localOff === 0xffffffff) { localOff = Number(v.getBigUint64(q, true)); }
            break;
          }
          e += 4 + sz;
        }
      }

      if (!name.endsWith('/')) {
        entries.set(name, { name, method, compressedSize, size, localOff, utf8: !!(flags & 0x800) });
      }
      p += 46 + nameLen + extraLen + cmtLen;
    }

    this.#entries = entries;
  }

  /** Raw bytes for one entry. */
  async bytes(path) {
    const e = this.#entries.get(path);
    if (!e) throw new Error(`Not in archive: ${path}`);

    const v = this.#view;
    // The local header repeats the name/extra lengths, and they can differ
    // from the central directory's, so we must re-read them here.
    if (v.getUint32(e.localOff, true) !== 0x04034b50) throw new Error('Bad local header');
    const nameLen  = v.getUint16(e.localOff + 26, true);
    const extraLen = v.getUint16(e.localOff + 28, true);
    const start = e.localOff + 30 + nameLen + extraLen;

    const raw = new Uint8Array(this.#buf, start, e.compressedSize);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error(`Unsupported ZIP compression method ${e.method}`);

    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot decompress ZIP archives (no DecompressionStream)');
    }
    const ds = new DecompressionStream('deflate-raw');
    // `raw` is a view onto the whole archive buffer; slice so we hand over
    // exactly this entry's bytes.
    const stream = new Blob([raw.slice()]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async text(path) {
    return new TextDecoder('utf-8').decode(await this.bytes(path));
  }

  async xml(path, mime = 'application/xml') {
    const doc = new DOMParser().parseFromString(await this.text(path), mime);
    if (doc.querySelector('parsererror')) {
      // Some EPUBs ship XHTML that is not well-formed. HTML parsing is lenient
      // and gets us usable text where strict XML parsing would give up.
      return new DOMParser().parseFromString(await this.text(path), 'text/html');
    }
    return doc;
  }
}
