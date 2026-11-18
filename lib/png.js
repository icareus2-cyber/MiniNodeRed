// PNG files on the PC: encoding (simulated camera pictures) and a header check
// (pictures fetched from a board). Plain zlib, no extra packages.
const zlib = require("node:zlib");

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf, crc = 0xffffffff) {
  for (const b of buf) crc = TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(
    (crc32(Buffer.concat([head.subarray(4), data])) ^ 0xffffffff) >>> 0,
    0,
  );
  return Buffer.concat([head, data, crc]);
}
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// pixels: width × height × channels bytes (1 = grey, 3 = RGB), row by row.
function encode(width, height, channels, pixels) {
  const row = width * channels;
  const raw = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++)
    pixels.copy(raw, y * (row + 1) + 1, y * row, y * row + row); // filter 0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
// { width, height, channels } of a PNG, or null if it is not one.
function info(buf) {
  if (
    !Buffer.isBuffer(buf) ||
    buf.length < 33 ||
    !buf.subarray(0, 8).equals(SIGNATURE)
  )
    return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    channels: buf[25] === 0 ? 1 : buf[25] === 2 ? 3 : null,
  };
}
// Pixels of a PNG with filter 0 rows (as Microflow and the boards write them).
function decode(buf) {
  const head = info(buf);
  if (!head) throw Error("not a PNG");
  let pos = 8;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const crc = buf.readUInt32BE(pos + 8 + len);
    if (
      (crc32(buf.subarray(pos + 4, pos + 8 + len)) ^ 0xffffffff) >>> 0 !==
      crc
    )
      throw Error(`bad CRC in ${type}`);
    if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const row = head.width * head.channels;
  const pixels = Buffer.alloc(row * head.height);
  for (let y = 0; y < head.height; y++) {
    if (raw[y * (row + 1)] !== 0) throw Error("row filter other than 0");
    raw.copy(pixels, y * row, y * (row + 1) + 1, (y + 1) * (row + 1));
  }
  return { ...head, pixels };
}
module.exports = { encode, info, decode, crc32 };
