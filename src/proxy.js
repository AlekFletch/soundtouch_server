// Прокси радиопотоков: колонка умеет только http://, поэтому мост сам открывает
// исходный поток (https, редиректы, плейлисты .pls/.m3u) и отдаёт его по HTTP.
import http from 'node:http';
import https from 'node:https';

const MAX_REDIRECTS = 5;
const MAX_PLAYLIST_DEPTH = 3;
const PLAYLIST_TYPES = /mpegurl|scpls|x-scpls|pls\+xml|audio\/x-mpequrl/i;
const PLAYLIST_EXT = /\.(m3u8?|pls)(\?|$)/i;
const USER_AGENT = 'SoundTouchBridge/0.1';

function get(url, signal) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, signal, timeout: 10000 }, resolve);
    req.on('timeout', () => req.destroy(new Error(`Таймаут подключения к ${url}`)));
    req.on('error', reject);
  });
}

async function getFollowing(url, signal) {
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await get(url, signal);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url).href;
      continue;
    }
    if (res.statusCode >= 400) {
      res.resume();
      throw new Error(`Поток ${url} ответил HTTP ${res.statusCode}`);
    }
    return { res, url };
  }
  throw new Error(`Слишком много редиректов: ${url}`);
}

function readBody(res, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    res.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        res.destroy();
        reject(new Error('Плейлист слишком большой'));
      } else chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

export function parsePlaylist(text, baseUrl) {
  if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(text)) {
    throw new Error('Это HLS-поток (.m3u8) — колонка его не поддерживает');
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    const pls = line.match(/^File\d+=(.+)$/i);
    const candidate = pls ? pls[1] : line && !line.startsWith('#') && !line.startsWith('[') ? line : '';
    if (/^https?:\/\//i.test(candidate) || (candidate && !candidate.includes('='))) {
      try {
        return new URL(candidate, baseUrl).href;
      } catch {}
    }
  }
  throw new Error('В плейлисте не найден адрес потока');
}

// Открыть поток: возвращает { res, url, contentType }
export async function openStream(url, signal, depth = 0) {
  const { res, url: finalUrl } = await getFollowing(url, signal);
  const type = String(res.headers['content-type'] || '');
  if (PLAYLIST_TYPES.test(type) || (PLAYLIST_EXT.test(finalUrl) && !type.startsWith('audio/mpeg'))) {
    if (depth >= MAX_PLAYLIST_DEPTH) throw new Error('Слишком глубокая вложенность плейлистов');
    const next = parsePlaylist(await readBody(res), finalUrl);
    return openStream(next, signal, depth + 1);
  }
  return { res, url: finalUrl, contentType: type.split(';')[0] || 'audio/mpeg' };
}

// Отдать поток клиенту (колонке) до разрыва соединения
export async function pipeStream(sourceUrl, clientReq, clientRes) {
  const abort = new AbortController();
  clientRes.on('close', () => abort.abort());
  let upstream;
  try {
    upstream = await openStream(sourceUrl, abort.signal);
  } catch (err) {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    clientRes.end(String(err.message));
    return;
  }
  clientRes.writeHead(200, {
    'Content-Type': upstream.contentType,
    'Cache-Control': 'no-cache',
    Connection: 'close',
    'transferMode.dlna.org': 'Streaming',
  });
  if (clientReq.method === 'HEAD') {
    upstream.res.destroy();
    clientRes.end();
    return;
  }
  upstream.res.pipe(clientRes);
  upstream.res.on('error', () => clientRes.destroy());
}
