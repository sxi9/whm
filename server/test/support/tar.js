import zlib from 'node:zlib';

// Tiny ustar writer for tests. Entries: { name, data?, type?, linkname?, mode?, longName? }
// type: 'file' (default) | 'dir' | 'symlink' | 'hardlink' | 'char' | 'fifo' | raw typeflag char.
const TYPES = { file: '0', dir: '5', symlink: '2', hardlink: '1', char: '3', block: '4', fifo: '6', pax: 'x' };

function header({ name, size, type, linkname = '', mode = 0o644, prefix = '' }) {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(mode.toString(8).padStart(7, '0'), 100, 8, 'ascii');
  h.write('0000000', 108, 8, 'ascii');
  h.write('0000000', 116, 8, 'ascii');
  h.write(size.toString(8).padStart(11, '0'), 124, 12, 'ascii');
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

function record(name, data, type, extra = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || '', 'utf8');
  const padded = Buffer.alloc(Math.ceil(buf.length / 512) * 512, 0);
  buf.copy(padded);
  return Buffer.concat([header({ name, size: buf.length, type, ...extra }), padded]);
}

export function createTar(entries) {
  const parts = [];
  for (const e of entries) {
    const type = TYPES[e.type || 'file'] || e.type;
    const data = type === '0' || type === 'x' ? (e.data ?? '') : '';
    if (e.longName) parts.push(record('././@LongLink', e.name + '\0', 'L'));
    parts.push(record(e.longName ? 'placeholder' : e.name, data, type, { linkname: e.linkname, mode: e.mode ?? (type === '5' ? 0o755 : 0o644), prefix: e.prefix }));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

export function createTarGz(entries) {
  return zlib.gzipSync(createTar(entries));
}

// Flat { 'path/in/package': 'content' } → gzip'ed tar with an optional wrapper directory.
export function packageFromFiles(files, { wrapper } = {}) {
  const entries = [];
  const prefix = wrapper ? `${wrapper}/` : '';
  if (wrapper) entries.push({ name: `${wrapper}/`, type: 'dir' });
  const dirs = new Set();
  for (const name of Object.keys(files)) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = `${prefix}${parts.slice(0, i).join('/')}/`;
      if (!dirs.has(d)) { dirs.add(d); entries.push({ name: d, type: 'dir' }); }
    }
    entries.push({ name: `${prefix}${name}`, data: files[name] });
  }
  return createTarGz(entries);
}
