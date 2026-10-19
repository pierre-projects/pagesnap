// Minimal ZIP writer (store only, no compression) for "Download all". PNG and JPEG are already
// compressed, so deflating them again would cost time and save nothing. No dependencies.
// Format: PKWARE APPNOTE 6.3 — local file headers, file data, central directory, end record.

import fs from 'node:fs/promises';
import path from 'node:path';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Write `files` (absolute paths) to the writable `out` as one ZIP. Each file is read whole;
// captures are at most a few MB each. Returns when the archive is complete.
export async function writeZip(out, files) {
  const write = (buf) => new Promise((resolve, reject) => {
    if (out.write(buf)) resolve();
    else { out.once('drain', resolve); out.once('error', reject); }
  });
  const central = [];
  let offset = 0;

  for (const file of files) {
    const data = await fs.readFile(file);
    const st = await fs.stat(file);
    const name = Buffer.from(path.basename(file), 'utf8');
    const crc = crc32(data);
    const { time, date } = dosTime(st.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // flags: names are UTF-8
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // central directory header signature
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42); // offset of the local header; other fields stay 0
    central.push(entry, name);

    await write(local);
    await write(name);
    await write(data);
    offset += local.length + name.length + data.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(files.length, 8); // entries on this disk
  end.writeUInt16LE(files.length, 10); // entries in total
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(dir);
  await write(end);
}
