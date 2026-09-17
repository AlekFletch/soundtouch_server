// HTTP-сервер: веб-форма, JSON API, прокси потоков /stream/:n и запуск моста
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, getSlot, setSlot } from './store.js';
import * as speaker from './speaker.js';
import * as upnp from './upnp.js';
import { pipeStream } from './proxy.js';
import { searchStations } from './radiobrowser.js';
import { Bridge } from './bridge.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

// Слот 0 — временная станция для кнопки «Прослушать»
let previewStation = null;
const stationFor = (n) => (n === 0 ? previewStation : getSlot(n));

async function bridgeBaseUrl() {
  const { bridgeHost, speakerHost, port } = getConfig();
  const host = bridgeHost || (await speaker.localAddressTowards(speakerHost));
  return `http://${host}:${port}`;
}

async function playSlot(n) {
  const { speakerHost, upnpDescriptionUrl } = getConfig();
  const station = stationFor(n);
  if (!speakerHost) throw new Error('Не указан IP колонки');
  if (!station) throw new Error(`Кнопка ${n} не настроена`);
  const url = `${await bridgeBaseUrl()}/stream/${n}?t=${Date.now()}`;
  log(`[play] ${n}: ${station.name} → ${url}`);
  await upnp.playUrl(speakerHost, { url, title: station.name, art: station.favicon, descriptionUrl: upnpDescriptionUrl });
}

const STREAM_PATH = /\/stream\/([0-6])(?:\?|$)/;
const PRESET_SETTLE_MS = Number(process.env.PRESET_SETTLE_MS ?? 1500);

// Записать на колонку пресет n, указывающий на поток моста
async function storeSlotOnSpeaker(n) {
  const { speakerHost } = getConfig();
  const station = getSlot(n);
  await speaker.storePreset(speakerHost, n, {
    name: station.name,
    location: `${await bridgeBaseUrl()}/stream/${n}`,
    art: station.favicon,
  });
}

async function onPresetPressed(id) {
  if (!getSlot(id)) return log(`[bridge] кнопка ${id} не настроена`);
  // Если пресет на колонке уже указывает на наш поток, колонка может запустить его сама —
  // даём ей время и не дублируем команду
  if (PRESET_SETTLE_MS > 0) {
    await new Promise((r) => setTimeout(r, PRESET_SETTLE_MS));
    try {
      const np = await speaker.getNowPlaying(getConfig().speakerHost);
      const playingSlot = np.location.match(STREAM_PATH)?.[1];
      if (Number(playingSlot) === id && /PLAY|BUFFER/.test(np.playStatus)) {
        return log(`[bridge] кнопка ${id}: колонка уже играет станцию сама`);
      }
    } catch {}
  }
  await playSlot(id);
}

// Долгое нажатие: колонка сохранила текущий поток моста (/stream/K) в пресет N → копируем станцию K в слот N
async function onPresetsUpdated(presets) {
  for (const p of presets) {
    const from = p.location.match(STREAM_PATH)?.[1];
    if (from === undefined || Number(from) === p.id || !(p.id >= 1 && p.id <= 6)) continue;
    const station = stationFor(Number(from));
    if (!station) continue;
    setSlot(p.id, station);
    log(`[bridge] кнопка ${p.id} сохранена удержанием: ${station.name}`);
    await storeSlotOnSpeaker(p.id).catch((err) => log(`[bridge] storePreset ${p.id}: ${err.message}`));
  }
}

const bridge = new Bridge({ log, onPreset: onPresetPressed, onPresetsUpdated });

// ---------- API ----------

const routes = {
  'GET /api/config': () => getConfig(),

  'POST /api/config': async (body) => {
    const prevHost = getConfig().speakerHost;
    const cfg = updateConfig(body);
    upnp.clearUpnpCache();
    if (cfg.speakerHost !== prevHost) bridge.start(cfg.speakerHost);
    return cfg;
  },

  'GET /api/status': async () => {
    const { speakerHost } = getConfig();
    const status = { speakerHost, bridgeConnected: bridge.connected };
    if (!speakerHost) return status;
    try {
      const [info, nowPlaying, volume] = await Promise.all([
        speaker.getInfo(speakerHost),
        speaker.getNowPlaying(speakerHost),
        speaker.getVolume(speakerHost),
      ]);
      Object.assign(status, { online: true, name: info.name, type: info.type, volume, nowPlaying: { ...nowPlaying, raw: undefined } });
    } catch (err) {
      Object.assign(status, { online: false, error: err.message });
    }
    return status;
  },

  'GET /api/discover': async () => {
    const devices = await upnp.ssdpSearch({ st: 'ssdp:all' });
    const hosts = [...new Set(devices.map((d) => d.address))];
    const speakers = [];
    await Promise.all(
      hosts.map(async (host) => {
        try {
          const info = await speaker.getInfo(host);
          speakers.push({ host, name: info.name, type: info.type });
        } catch {}
      }),
    );
    return { speakers, devices };
  },

  'GET /api/search': async (_, query) => {
    const q = (query.get('q') || '').trim();
    if (q.length < 2) return [];
    return searchStations(q, { countrycode: query.get('country') || '' });
  },

  'POST /api/play': async (body) => {
    if (!/^https?:\/\//i.test(body.url || '')) throw new Error('Нужна ссылка http:// или https://');
    previewStation = { name: body.name || 'Радио', url: body.url, favicon: body.favicon || '' };
    await playSlot(0);
    return { ok: true };
  },

  'POST /api/slot': async (body) => {
    const n = Number(body.slot);
    if (!(n >= 1 && n <= 6)) throw new Error('Номер кнопки должен быть от 1 до 6');
    if (!body.url) {
      setSlot(n, null);
      return { ok: true, slot: n, station: null };
    }
    if (!/^https?:\/\//i.test(body.url)) throw new Error('Нужна ссылка http:// или https://');
    const station = setSlot(n, body);
    const result = { ok: true, slot: n, station };

    const { speakerHost, storePresetOnSpeaker } = getConfig();
    if (speakerHost && storePresetOnSpeaker) {
      try {
        await storeSlotOnSpeaker(n);
        result.storedOnSpeaker = true;
      } catch (err) {
        result.storedOnSpeaker = false;
        result.warning = `Станция сохранена в мосте, но не записана на колонку: ${err.message}`;
      }
    }
    return result;
  },

  'POST /api/slot/play': async (body) => {
    await playSlot(Number(body.slot));
    return { ok: true };
  },

  'POST /api/volume': async (body) => ({ volume: await speaker.setVolume(getConfig().speakerHost, body.volume) }),

  'POST /api/key': async (body) => {
    const allowed = /^(POWER|PLAY|PAUSE|PLAY_PAUSE|STOP|MUTE|VOLUME_UP|VOLUME_DOWN|PRESET_[1-6])$/;
    if (!allowed.test(body.key)) throw new Error('Недопустимая клавиша');
    await speaker.pressKey(getConfig().speakerHost, body.key);
    return { ok: true };
  },

  'GET /api/presets': () => speaker.getPresets(getConfig().speakerHost),

  // Последние сообщения WebSocket колонки — для отладки
  'GET /api/debug/messages': () => bridge.lastMessages,
};

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64 * 1024) throw new Error('Слишком большой запрос');
  }
  return data ? JSON.parse(data) : {};
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? 'index.html' : pathname.slice(1));
  if (rel.startsWith('..')) return false;
  try {
    const data = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  const stream = url.pathname.match(/^\/stream\/([0-6])$/);
  if (stream) {
    const station = stationFor(Number(stream[1]));
    if (!station) return sendJson(res, 404, { error: 'Станция не настроена' });
    log(`[stream] ${req.method} ${stream[1]} от ${req.socket.remoteAddress}`);
    return pipeStream(station.url, req, res);
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      return sendJson(res, 200, await handler(body, url.searchParams));
    } catch (err) {
      log(`[api] ${req.method} ${url.pathname}: ${err.message}`);
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && (await serveStatic(res, url.pathname))) return;
  sendJson(res, 404, { error: 'Не найдено' });
});

const { port, speakerHost } = getConfig();
server.listen(port, '0.0.0.0', () => {
  log(`SoundTouch Bridge: http://localhost:${port}`);
  if (speakerHost) bridge.start(speakerHost);
  else log('IP колонки не задан — укажите его в веб-форме');
});
