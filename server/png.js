// A picture written as a PNG file, with nothing but what Node has: for the last picture of the
// minimap that goes into a report of a problem (minimap.js, report.js).
import zlib from 'node:zlib';

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; }
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** @param pic { data (bytes, row by row), w, h, ch (3: R G B, 4: R G B A) }  @returns the PNG file, as a Buffer */
export function encodePng(pic) {
  const { data, w, h, ch } = pic;
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4);
  head[8] = 8; head[9] = ch === 4 ? 6 : 2; // eight bits a colour; colours, with or without how see-through
  // (each row with a zero before it: "as it is", no filtering)
  const rows = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(data.buffer, data.byteOffset + y * w * ch, w * ch).copy(rows, y * (w * ch + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
