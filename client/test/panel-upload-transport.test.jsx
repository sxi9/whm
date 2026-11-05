import { describe, it, expect, vi } from 'vitest';

// A fake of the §57 upload routes behind api.*: raw chunks by index, the
// received list, and a switch that drops the next N requests on the floor the
// way a lost connection does.
const server = vi.hoisted(() => ({ uploads: new Map(), calls: [], failNext: 0, chunkBytes: 4 }));
const netError = () => Object.assign(new TypeError('Failed to fetch'), {});

vi.mock('../src/api/client.js', () => ({
  api: {
    async request(method, path, body) {
      server.calls.push([method, path]);
      if (server.failNext > 0) { server.failNext -= 1; throw netError(); }
      if (method === 'POST' && path === '/panel/files/uploads') {
        const id = `u${server.uploads.size + 1}`;
        const u = { id, size: body.size, chunkBytes: server.chunkBytes, chunkCount: Math.ceil(body.size / server.chunkBytes), got: new Map(), aborted: false };
        server.uploads.set(id, u);
        return { data: shape(u) };
      }
      const m = path.match(/^\/panel\/files\/uploads\/([^/]+)(?:\/(finish|abort))?$/);
      if (m) {
        const u = server.uploads.get(m[1]);
        if (!u) throw Object.assign(new Error('not found'), { status: 404, code: 'not_found' });
        if (m[2] === 'finish') { if (u.got.size !== u.chunkCount) throw Object.assign(new Error('incomplete'), { status: 422, code: 'validation_failed' }); return { data: { id: u.id, bytes: u.size } }; }
        if (m[2] === 'abort') { u.aborted = true; return { data: { aborted: true } }; }
        return { data: shape(u) };
      }
      if (method === 'PUT' && path === '/panel/files/write') return { data: { path: body.path } };
      throw new Error(`unexpected ${method} ${path}`);
    },
    get: (path) => mod.api.request('GET', path),
    post: (path, body = {}) => mod.api.request('POST', path, body),
    put: (path, body = {}) => mod.api.request('PUT', path, body),
    async putRaw(path, body, contentType) {
      server.calls.push(['PUTRAW', path, body.byteLength, contentType]);
      if (server.failNext > 0) { server.failNext -= 1; throw netError(); }
      const m = path.match(/^\/panel\/files\/uploads\/([^/]+)\/chunks\/(\d+)$/);
      const u = server.uploads.get(m[1]);
      const index = Number(m[2]);
      const want = Math.min(u.chunkBytes, u.size - index * u.chunkBytes);
      if (body.byteLength !== want) throw Object.assign(new Error('bad length'), { status: 422, code: 'validation_failed' });
      u.got.set(index, Buffer.from(body));
      return { data: shape(u) };
    },
  },
  queryString: () => '',
}));
const mod = await import('../src/api/client.js');
function shape(u) {
  const received = [...u.got.keys()].reduce((n, i) => n + Math.min(u.chunkBytes, u.size - i * u.chunkBytes), 0);
  return { id: u.id, size: u.size, received, chunks: u.got.size, chunkBytes: u.chunkBytes, chunkCount: u.chunkCount, receivedChunks: [...u.got.keys()].sort((a, b) => a - b) };
}
const content = (u) => Buffer.concat([...u.got.keys()].sort((a, b) => a - b).map((i) => u.got.get(i)));

const { uploadFile, missingChunks, isTransient, filesOfDrop } = await import('../src/pages/panel/files/parts/UploadModal.jsx');

const fileOf = (text) => ({ name: 'probe.bin', size: text.length, slice: (a, b) => ({ arrayBuffer: async () => new TextEncoder().encode(text.slice(a, b)).buffer }) });
const reset = () => { server.uploads.clear(); server.calls.length = 0; server.failNext = 0; };

describe('upload transport helpers', () => {
  it('lists the chunks still missing from the received list in index order', () => {
    expect(missingChunks(4, [])).toEqual([0, 1, 2, 3]);
    expect(missingChunks(4, [2, 0])).toEqual([1, 3]);
    expect(missingChunks(4, [0, 1, 2, 3])).toEqual([]);
    expect(missingChunks(0)).toEqual([]);
  });

  it('treats a failed fetch and gateway answers as transient, every other error as final', () => {
    expect(isTransient(new TypeError('Failed to fetch'))).toBe(true);
    for (const status of [408, 429, 502, 503, 504]) expect(isTransient({ status })).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 413, 415, 422, 500]) expect(isTransient({ status })).toBe(false);
    expect(isTransient(null)).toBe(false);
  });

  it('keeps the files of a drop and counts the folders', () => {
    const file = { name: 'a.txt', type: 'text/plain', size: 3 };
    const items = [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => file },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => ({ name: 'dir', type: '', size: 4096 }) },
      { kind: 'string', webkitGetAsEntry: () => null },
    ];
    expect(filesOfDrop({ items, files: [file] })).toEqual({ files: [file], folders: 1 });
    expect(filesOfDrop({ files: [file, { name: 'dir', type: '', size: 4096 }] })).toEqual({ files: [file], folders: 1 });
    expect(filesOfDrop(null)).toEqual({ files: [], folders: 0 });
  });
});

describe('uploadFile over raw chunks', () => {
  it('sends every chunk raw by index with the pinned size, then finishes', async () => {
    reset();
    const progress = [];
    const res = await uploadFile(fileOf('0123456789'), 'public_html', { onProgress: (n) => progress.push(n), delays: [] });
    expect(res).toEqual({ id: 'u1', bytes: 10 });
    expect(server.calls.filter((c) => c[0] === 'PUTRAW')).toEqual([
      ['PUTRAW', '/panel/files/uploads/u1/chunks/0', 4, 'application/octet-stream'],
      ['PUTRAW', '/panel/files/uploads/u1/chunks/1', 4, 'application/octet-stream'],
      ['PUTRAW', '/panel/files/uploads/u1/chunks/2', 2, 'application/octet-stream'],
    ]);
    expect(progress).toEqual([4, 8, 10]);
    expect(content(server.uploads.get('u1')).toString()).toBe('0123456789');
    expect(server.calls.at(-1)).toEqual(['POST', '/panel/files/uploads/u1/finish']);
  });

  it('resumes after a connection loss from the server\'s received list instead of aborting', async () => {
    reset();
    const statuses = [];
    const u = fileOf('0123456789');
    // The first chunk goes through; its retry answer is lost twice, then the
    // status call fails once more before the list says what is still missing.
    const orig = mod.api.putRaw;
    let sent = 0;
    mod.api.putRaw = async (...args) => { sent += 1; if (sent === 2 || sent === 3) { server.failNext = sent === 3 ? 1 : 0; throw new TypeError('Failed to fetch'); } return orig(...args); };
    try {
      const res = await uploadFile(u, '', { onStatus: (s) => statuses.push(s), delays: [0, 0, 0, 0] });
      expect(res).toEqual({ id: 'u1', bytes: 10 });
    } finally { mod.api.putRaw = orig; }
    expect(statuses).toEqual(['running', 'reconnecting', 'reconnecting', 'running', 'running']);
    expect(server.calls.some((c) => c[1] === '/panel/files/uploads/u1' && c[0] === 'GET')).toBe(true);
    expect(server.calls.some((c) => c[1].endsWith('/abort'))).toBe(false);
    expect(content(server.uploads.get('u1')).toString()).toBe('0123456789');
  });

  it('skips chunks the server already holds when the status says so', async () => {
    reset();
    const orig = mod.api.putRaw;
    let first = true;
    mod.api.putRaw = async (...args) => {
      if (first) { first = false; const u = server.uploads.get('u1'); u.got.set(1, Buffer.from('4567')); u.got.set(2, Buffer.from('89')); throw new TypeError('Failed to fetch'); }
      return orig(...args);
    };
    try { await uploadFile(fileOf('0123456789'), '', { delays: [0] }); } finally { mod.api.putRaw = orig; }
    // The lost first attempt never reached the fake; after the status answer only chunk 0 is sent.
    expect(server.calls.filter((c) => c[0] === 'PUTRAW').map((c) => c[1])).toEqual(['/panel/files/uploads/u1/chunks/0']);
    expect(content(server.uploads.get('u1')).toString()).toBe('0123456789');
  });

  it('gives up after the retry budget, aborts the upload and reports the transport error', async () => {
    reset();
    const orig = mod.api.putRaw;
    mod.api.putRaw = async () => { throw new TypeError('Failed to fetch'); };
    try {
      await expect(uploadFile(fileOf('0123456789'), '', { delays: [0, 0] })).rejects.toThrow('Failed to fetch');
    } finally { mod.api.putRaw = orig; }
    expect(server.uploads.get('u1').aborted).toBe(true);
    expect(server.calls.filter((c) => c[0] === 'GET').length).toBe(2);
  });

  it('aborts at once on a final error (422) and on cancellation', async () => {
    reset();
    const orig = mod.api.putRaw;
    mod.api.putRaw = async () => { throw Object.assign(new Error('nope'), { status: 422, code: 'validation_failed' }); };
    try { await expect(uploadFile(fileOf('abc'), '', { delays: [0] })).rejects.toMatchObject({ status: 422 }); } finally { mod.api.putRaw = orig; }
    expect(server.uploads.get('u1').aborted).toBe(true);
    reset();
    await expect(uploadFile(fileOf('abc'), '', { isCancelled: () => true })).rejects.toMatchObject({ code: 'cancelled' });
    expect(server.uploads.get('u1').aborted).toBe(true);
  });
});
