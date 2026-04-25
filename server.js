#!/usr/bin/env node
// VidToJpeg — local download proxy using yt-dlp
// Run: node server.js  (then open index.html in the browser)

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const TMP_DIR = path.join(os.tmpdir(), 'vidtojpeg');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) reject(new Error('payload too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function sanitizeName(s) {
  return s.replace(/[^\w.\-]+/g, '_').slice(0, 120);
}

function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleInfo(req, res) {
  const { url } = await readJson(req);
  if (!url || !/^https?:\/\//.test(url)) return sendJson(res, 400, { error: 'Invalid URL' });
  const p = spawn('yt-dlp', ['--no-playlist', '--no-warnings', '-J', url]);
  let out = '', err = '';
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', d => err += d);
  p.on('close', code => {
    if (code !== 0) return sendJson(res, 500, { error: 'yt-dlp failed', detail: err.slice(-500) });
    try {
      const info = JSON.parse(out);
      sendJson(res, 200, { title: info.title, duration: info.duration, thumbnail: info.thumbnail, ext: info.ext });
    } catch (e) {
      sendJson(res, 500, { error: 'parse error' });
    }
  });
}

async function handleDownload(req, res) {
  const { url } = await readJson(req);
  if (!url || !/^https?:\/\//.test(url)) return sendJson(res, 400, { error: 'Invalid URL' });

  const id = crypto.randomBytes(6).toString('hex');
  const tmpl = path.join(TMP_DIR, id + '.%(ext)s');
  // Prefer mp4 for browser compatibility; fall back to any single file.
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    // Prefer H.264 + AAC in mp4 (universal browser support),
    // then any mp4, then fall back to best single file.
    '-f', 'bv*[vcodec~="^avc1"][ext=mp4]+ba[ext=m4a]/b[vcodec~="^avc1"][ext=mp4]/b[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--recode-video', 'mp4',
    // Force moov atom at the start → browser gets correct duration immediately
    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
    '-o', tmpl,
    url,
  ];

  console.log('[download]', url);
  const p = spawn('yt-dlp', args);
  let err = '';
  p.stderr.on('data', d => { err += d; process.stderr.write(d); });
  p.stdout.on('data', d => process.stdout.write(d));

  p.on('close', code => {
    if (code !== 0) {
      return sendJson(res, 500, { error: 'yt-dlp failed', detail: err.slice(-800) });
    }
    // Find produced file (any extension)
    const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(id + '.'));
    if (!files.length) return sendJson(res, 500, { error: 'no file produced' });
    const filePath = path.join(TMP_DIR, files[0]);
    const stat = fs.statSync(filePath);
    const ext = path.extname(files[0]).slice(1) || 'mp4';
    const contentType = ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : 'application/octet-stream';

    cors(res);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${sanitizeName(files[0])}"`,
      'X-Filename': sanitizeName(files[0]),
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => { fs.unlink(filePath, () => {}); });
  });
}

async function handleDownloadSave(req, res) {
  const { url, quality } = await readJson(req);
  if (!url || !/^https?:\/\//.test(url)) return sendJson(res, 400, { error: 'Invalid URL' });

  const id = crypto.randomBytes(6).toString('hex');
  const tmpl = path.join(TMP_DIR, id + '.%(ext)s');

  let args;
  if (quality === 'audio') {
    args = [
      '--no-playlist', '--no-warnings', '--no-progress',
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '-o', tmpl, url,
    ];
  } else {
    let formatStr;
    if (quality === '720') {
      formatStr = 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]/best';
    } else if (quality === '480') {
      formatStr = 'bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480][ext=mp4]/b[height<=480]/best';
    } else {
      formatStr = 'bv*[vcodec~="^avc1"][ext=mp4]+ba[ext=m4a]/b[vcodec~="^avc1"][ext=mp4]/b[ext=mp4]/best';
    }
    args = [
      '--no-playlist', '--no-warnings', '--no-progress',
      '-f', formatStr,
      '--merge-output-format', 'mp4',
      '--recode-video', 'mp4',
      '--postprocessor-args', 'ffmpeg:-movflags +faststart',
      '-o', tmpl, url,
    ];
  }

  console.log('[download-save]', url, 'quality:', quality);
  const p = spawn('yt-dlp', args);
  let err = '';
  p.stderr.on('data', d => { err += d; process.stderr.write(d); });
  p.stdout.on('data', d => process.stdout.write(d));

  p.on('close', code => {
    if (code !== 0) {
      return sendJson(res, 500, { error: 'yt-dlp failed', detail: err.slice(-800) });
    }
    const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(id + '.'));
    if (!files.length) return sendJson(res, 500, { error: 'no file produced' });
    const filePath = path.join(TMP_DIR, files[0]);
    const stat = fs.statSync(filePath);
    const ext = path.extname(files[0]).slice(1) || 'mp4';
    const contentType = ext === 'mp3' ? 'audio/mpeg' : ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : 'application/octet-stream';

    cors(res);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${sanitizeName(files[0])}"`,
      'X-Filename': sanitizeName(files[0]),
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => { fs.unlink(filePath, () => {}); });
  });
}

// ===== CUT VIDEO INTO SEGMENTS =====
async function handleCut(req, res) {
  // Receive multipart form data: video file + segments JSON
  const boundary = (req.headers['content-type'] || '').match(/boundary=(.+)/);
  if (!boundary) return sendJson(res, 400, { error: 'Missing multipart boundary' });

  const chunks = [];
  req.on('data', c => chunks.push(c));
  await new Promise(r => req.on('end', r));
  const buf = Buffer.concat(chunks);

  // Parse multipart manually
  const sep = '--' + boundary[1];
  const parts = [];
  let pos = 0;
  while (true) {
    const start = buf.indexOf(sep, pos);
    if (start === -1) break;
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const nextSep = buf.indexOf(sep, headerEnd + 4);
    if (nextSep === -1) break;
    const headerStr = buf.slice(start + sep.length + 2, headerEnd).toString();
    const body = buf.slice(headerEnd + 4, nextSep - 2); // strip trailing \r\n
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const fileMatch = headerStr.match(/filename="([^"]+)"/);
    parts.push({ name: nameMatch?.[1], filename: fileMatch?.[1], headers: headerStr, data: body });
    pos = nextSep;
  }

  const filePart = parts.find(p => p.name === 'video');
  const segPart = parts.find(p => p.name === 'segments');
  if (!filePart || !segPart) return sendJson(res, 400, { error: 'Missing video or segments' });

  let segs;
  try { segs = JSON.parse(segPart.data.toString()); } catch { return sendJson(res, 400, { error: 'Invalid segments JSON' }); }
  if (!Array.isArray(segs) || !segs.length) return sendJson(res, 400, { error: 'No segments' });

  // Parse optional crop data (normalized 0-1 values: x, y, w, h)
  const cropPart = parts.find(p => p.name === 'crop');
  let cropInfo = null;
  if (cropPart) {
    try { cropInfo = JSON.parse(cropPart.data.toString()); } catch { /* ignore invalid crop */ }
  }

  const id = crypto.randomBytes(6).toString('hex');
  const inputPath = path.join(TMP_DIR, id + '_input.mp4');
  fs.writeFileSync(inputPath, filePart.data);

  const baseName = (filePart.filename || 'video').replace(/\.[^.]+$/, '');
  const outputFiles = [];

  // If crop is requested, probe video dimensions to compute pixel values
  let cropFilter = null;
  if (cropInfo && cropInfo.w > 0.01 && cropInfo.h > 0.01) {
    try {
      const dims = await new Promise((resolve, reject) => {
        const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height', '-of', 'json', inputPath]);
        let out = '';
        p.stdout.on('data', d => out += d);
        p.on('close', code => {
          if (code !== 0) return reject(new Error('ffprobe failed'));
          try {
            const info = JSON.parse(out);
            const s = info.streams[0];
            resolve({ w: s.width, h: s.height });
          } catch (e) { reject(e); }
        });
      });
      const cw = Math.round(cropInfo.w * dims.w);
      const ch = Math.round(cropInfo.h * dims.h);
      const cx = Math.round(cropInfo.x * dims.w);
      const cy = Math.round(cropInfo.y * dims.h);
      // Ensure even dimensions for H.264
      const ew = cw % 2 === 0 ? cw : cw - 1;
      const eh = ch % 2 === 0 ? ch : ch - 1;
      cropFilter = `crop=${ew}:${eh}:${cx}:${cy}`;
      console.log('[cut] crop filter:', cropFilter);
    } catch (e) {
      console.warn('[cut] Could not probe video for crop, skipping crop:', e.message);
    }
  }

  try {
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const outPath = path.join(TMP_DIR, `${id}_seg${i + 1}.mp4`);
      const duration = seg.end - seg.start;

      await new Promise((resolve, reject) => {
        // -ss after -i = frame-accurate seek (re-encodes from keyframe to cut point)
        const args = [
          '-y',
          '-i', inputPath,
          '-ss', String(seg.start),
          '-to', String(seg.end),
        ];
        if (cropFilter) args.push('-vf', cropFilter);
        args.push(
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
          '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart',
          '-avoid_negative_ts', 'make_zero',
          outPath,
        );
        console.log('[cut]', `segment ${i + 1}/${segs.length}`, `${seg.start.toFixed(2)}s → ${seg.end.toFixed(2)}s`);
        const p = spawn('ffmpeg', args);
        let err = '';
        p.stderr.on('data', d => err += d);
        p.on('close', code => {
          if (code !== 0) reject(new Error(`ffmpeg failed: ${err.slice(-500)}`));
          else resolve();
        });
      });

      outputFiles.push({ path: outPath, name: `${baseName}_segment${i + 1}.mp4` });
    }

    // If single segment, send the file directly
    if (outputFiles.length === 1) {
      const f = outputFiles[0];
      const stat = fs.statSync(f.path);
      cors(res);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${sanitizeName(f.name)}"`,
        'X-Filename': sanitizeName(f.name),
        'X-Segment-Count': '1',
      });
      const stream = fs.createReadStream(f.path);
      stream.pipe(res);
      stream.on('close', () => { cleanup(); });
      return;
    }

    // Multiple segments → create a zip using a simple tar-like approach
    // Actually, let's just send them sequentially as a zip-like JSON response with base64
    // Better: use a simple concatenation with a manifest
    // Simplest reliable approach: stream a zip manually or just send files individually

    // We'll create a simple zip using Node.js without external deps
    // For simplicity, send as multipart response with file boundaries
    const files = outputFiles.map(f => ({
      name: f.name,
      data: fs.readFileSync(f.path),
    }));

    // Build a minimal ZIP file
    const zipBuf = buildZip(files);
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zipBuf.length,
      'Content-Disposition': `attachment; filename="${sanitizeName(baseName)}_segments.zip"`,
      'X-Segment-Count': String(segs.length),
    });
    res.end(zipBuf);
    cleanup();
  } catch (e) {
    cleanup();
    return sendJson(res, 500, { error: String(e.message || e) });
  }

  function cleanup() {
    fs.unlink(inputPath, () => {});
    outputFiles.forEach(f => fs.unlink(f.path, () => {}));
  }
}

// Minimal ZIP builder (no compression, store only — videos are already compressed)
function buildZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    // Local file header (30 + name length)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(0, 8); // compression: store
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(0, 12); // mod date
    // CRC32
    const crc = crc32(f.data);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18); // compressed size
    lh.writeUInt32LE(f.data.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26); // name length
    lh.writeUInt16LE(0, 28); // extra length

    localHeaders.push({ header: Buffer.concat([lh, nameBuf]), data: f.data, offset });

    // Central directory header (46 + name length)
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // signature
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(0, 10); // compression
    ch.writeUInt16LE(0, 12); // mod time
    ch.writeUInt16LE(0, 14); // mod date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra length
    ch.writeUInt16LE(0, 32); // comment length
    ch.writeUInt16LE(0, 34); // disk start
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42); // local header offset

    centralHeaders.push(Buffer.concat([ch, nameBuf]));

    offset += lh.length + nameBuf.length + f.data.length;
  }

  const centralDir = Buffer.concat(centralHeaders.map(c => c));
  const centralOffset = offset;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk start
  eocd.writeUInt16LE(files.length, 8); // entries on disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central dir size
  eocd.writeUInt32LE(centralOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  const parts = [];
  for (const lh of localHeaders) {
    parts.push(lh.header, lh.data);
  }
  parts.push(centralDir, eocd);
  return Buffer.concat(parts);
}

// CRC32 for ZIP
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/info') return handleInfo(req, res);
    if (req.method === 'POST' && req.url === '/download') return handleDownload(req, res);
    if (req.method === 'POST' && req.url === '/download-save') return handleDownloadSave(req, res);
    if (req.method === 'POST' && req.url === '/cut') return handleCut(req, res);

    // Serve index.html and static files from the script directory
    if (req.method === 'GET') {
      const reqPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
      const filePath = path.join(__dirname, reqPath);
      if (filePath.startsWith(__dirname) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).slice(1);
        const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`VidToJpeg server ready → http://localhost:${PORT}/`);
  console.log(`Ouvre cette URL dans le navigateur.`);
});
