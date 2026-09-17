// HTTP-сервер: веб-форма, JSON API, прокси потоков /stream/:speaker/:n и мосты для каждой колонки
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import * as speaker from './speaker.js';
import * as upnp from './upnp.js';
import { pipeStream } from './proxy.js';
import { searchStations } from './radiobrowser.js';
import { Bridge } from './bridge.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const STREAM_PATH = /\/stream\/([0-9a-f]+)\/([0-6])(?:\?|$)/;
const PRESET_SETTLE_MS = Number(process.env.PRESET_SETTLE_MS ?? 1500);

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const label = (sp) => sp.name || sp.host;
const isHttpUrl = (u) => /^https?:\/\//i.test(u || '');

// Временная станция для кнопки «Прослушать» (слот 0), своя у каждой колонки
const previews = new Map();
const stationFor = (sp, n) => (n === 0 ? previews.get(sp.id) || null : sp.slots[n] || null);

// ---------- воспроизведение ----------

async function bridgeBaseUrl(sp) {
  const { bridgeHost, port } = store.getConfig();
  const host = bridgeHost || (await speaker.localAddressTowards(sp));
  return `http://${host}:${port}`;
}

async function playSlot(sp, n) {
  const station = stationFor(sp, n);
  if (!station) throw new Error(`Кнопка ${n} не настроена`);
  const url = `${await bridgeBaseUrl(sp)}/stream/${sp.id}/${n}?t=${Date.now()}`;
  log(`[${label(sp)}] играю ${n}: ${station.name} → ${url}`);
  await upnp.playUrl(sp.host, { url, title: station.name, art: station.favicon, descriptionUrl: sp.upnpDescriptionUrl });
}

// Записать на колонку пресет n, указывающий на поток моста
async function storeSlotOnSpeaker(sp, n) {
  const station = sp.slots[n];
  await speaker.storePreset(sp, n, {
    name: station.name,
    location: `${await bridgeBaseUrl(sp)}/stream/${sp.id}/${n}`,
    art: station.favicon,
  });
}

// ---------- мосты ----------

const bridges = new Map(); // id колонки → Bridge

function startBridge(sp) {
  stopBridge(sp.id);
  const id = sp.id;
  const current = () => store.listSpeakers().find((s) => s.id === id);
  const bridge = new Bridge({
    log,
    onPreset: (n) => onPresetPressed(current(), n),
    onPresetsUpdated: (presets) => onPresetsUpdated(current(), presets),
  });
  bridge.start({ host: sp.host, wsPort: sp.wsPort, label: label(sp) });
  bridges.set(id, bridge);
}

function stopBridge(id) {
  bridges.get(id)?.stop();
  bridges.delete(id);
}

async function onPresetPressed(sp, n) {
  if (!sp) return;
  if (!sp.slots[n]) return log(`[${label(sp)}] кнопка ${n} не настроена`);
  // Если пресет на колонке уже указывает на наш поток, колонка может запустить его сама —
  // даём ей время и не дублируем команду
  if (PRESET_SETTLE_MS > 0) {
    await new Promise((r) => setTimeout(r, PRESET_SETTLE_MS));
    try {
      const np = await speaker.getNowPlaying(sp);
      const m = np.location.match(STREAM_PATH);
      if (m && m[1] === sp.id && Number(m[2]) === n && /PLAY|BUFFER/.test(np.playStatus)) {
        return log(`[${label(sp)}] кнопка ${n}: колонка уже играет станцию сама`);
      }
    } catch {}
  }
  await playSlot(sp, n);
}

// Долгое нажатие: колонка сохранила текущий поток моста в пресет N → копируем станцию в слот N
async function onPresetsUpdated(sp, presets) {
  if (!sp) return;
  for (const p of presets) {
    const m = p.location.match(STREAM_PATH);
    if (!m || !(p.id >= 1 && p.id <= 6)) continue;
    const source = store.listSpeakers().find((s) => s.id === m[1]);
    const from = Number(m[2]);
    if (!source || (source.id === sp.id && from === p.id)) continue;
    const station = stationFor(source, from);
    if (!station) continue;
    store.setSlot(sp.id, p.id, station);
    log(`[${label(sp)}] кнопка ${p.id} сохранена удержанием: ${station.name}`);
    await storeSlotOnSpeaker(sp, p.id).catch((err) => log(`[${label(sp)}] storePreset ${p.id}: ${err.message}`));
  }
}

// Сохранить станцию на кнопку (и попытаться записать пресет на колонку)
async function saveSlot(sp, n, station) {
  const saved = store.setSlot(sp.id, n, station);
  const result = { ok: true, speaker: sp.id, slot: n, station: saved };
  if (saved && store.getConfig().storePresetOnSpeaker) {
    try {
      await storeSlotOnSpeaker(sp, n);
      result.storedOnSpeaker = true;
    } catch (err) {
      result.storedOnSpeaker = false;
      result.warning = `Станция сохранена в мосте, но не записана на колонку «${label(sp)}»: ${err.message}`;
    }
  }
  return result;
}

// ---------- API ----------

function slotNumber(value) {
  const n = Number(value);
  if (!(Number.isInteger(n) && n >= 1 && n <= 6)) throw new Error('Номер кнопки должен быть от 1 до 6');
  return n;
}

function checkStation(body) {
  if (!isHttpUrl(body.url)) throw new Error('Нужна ссылка http:// или https://');
  return { name: body.name || 'Радио', url: body.url, favicon: isHttpUrl(body.favicon) ? body.favicon : '' };
}

async function speakerStatus(sp) {
  const status = { id: sp.id, host: sp.host, name: sp.name, bridgeConnected: !!bridges.get(sp.id)?.connected };
  try {
    const [info, nowPlaying, volume] = await Promise.all([speaker.getInfo(sp), speaker.getNowPlaying(sp), speaker.getVolume(sp)]);
    Object.assign(status, { online: true, name: info.name, type: info.type, volume, nowPlaying: { ...nowPlaying, raw: undefined } });
    // Запоминаем имя колонки, если пользователь не задал своё
    if (!sp.name && info.name) store.updateSpeaker(sp.id, { name: info.name });
  } catch (err) {
    Object.assign(status, { online: false, error: err.message });
  }
  return status;
}

const routes = {
  'GET /api/config': () => store.getConfig(),

  'POST /api/config': (body) => store.updateConfig(body),

  'GET /api/status': () => Promise.all(store.listSpeakers().map(speakerStatus)),

  'POST /api/speakers': async (body) => {
    const sp = store.addSpeaker(body);
    if (!sp.name) {
      try {
        store.updateSpeaker(sp.id, { name: (await speaker.getInfo(sp)).name });
      } catch {}
    }
    startBridge(sp);
    return sp;
  },

  'POST /api/speakers/update': (body) => {
    const sp = store.updateSpeaker(body.id, body);
    upnp.clearUpnpCache();
    startBridge(sp);
    return sp;
  },

  'POST /api/speakers/remove': (body) => {
    store.removeSpeaker(body.id);
    stopBridge(body.id);
    previews.delete(body.id);
    return { ok: true };
  },

  'GET /api/discover': async () => {
    const devices = await upnp.ssdpSearch({ st: 'ssdp:all' });
    const hosts = [...new Set(devices.map((d) => d.address))];
    const found = [];
    await Promise.all(
      hosts.map(async (host) => {
        try {
          const info = await speaker.getInfo(host);
          found.push({ host, name: info.name, type: info.type, added: !!store.findSpeakerByHost(host) });
        } catch {}
      }),
    );
    return { speakers: found };
  },

  'GET /api/search': async (_, query) => {
    const q = (query.get('q') || '').trim();
    if (q.length < 2) return [];
    return searchStations(q, { countrycode: query.get('country') || '' });
  },

  'POST /api/play': async (body) => {
    const sp = store.getSpeaker(body.speaker);
    previews.set(sp.id, checkStation(body));
    await playSlot(sp, 0);
    return { ok: true };
  },

  'POST /api/slot': async (body) => {
    const sp = store.getSpeaker(body.speaker);
    const n = slotNumber(body.slot);
    return saveSlot(sp, n, body.url ? checkStation(body) : null);
  },

  'POST /api/slot/play': async (body) => {
    await playSlot(store.getSpeaker(body.speaker), slotNumber(body.slot));
    return { ok: true };
  },

  // Скопировать все 6 кнопок с одной колонки на другую
  'POST /api/slots/copy': async (body) => {
    const from = store.getSpeaker(body.from);
    const to = store.getSpeaker(body.to);
    if (from.id === to.id) throw new Error('Выберите другую колонку');
    const warnings = [];
    for (let n = 1; n <= 6; n++) {
      const r = await saveSlot(to, n, from.slots[n]);
      if (r.warning) warnings.push(r.warning);
    }
    return { ok: true, speaker: store.getSpeaker(to.id), warning: warnings[0] };
  },

  'POST /api/volume': async (body) => ({ volume: await speaker.setVolume(store.getSpeaker(body.speaker), body.volume) }),

  'POST /api/key': async (body) => {
    const allowed = /^(POWER|PLAY|PAUSE|PLAY_PAUSE|STOP|MUTE|VOLUME_UP|VOLUME_DOWN|PRESET_[1-6])$/;
    if (!allowed.test(body.key)) throw new Error('Недопустимая клавиша');
    await speaker.pressKey(store.getSpeaker(body.speaker), body.key);
    return { ok: true };
  },

  'GET /api/presets': (_, query) => speaker.getPresets(store.getSpeaker(query.get('speaker'))),

  // Последние сообщения WebSocket колонки — для отладки
  'GET /api/debug/messages': (_, query) => bridges.get(query.get('speaker'))?.lastMessages || [],
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

  const stream = url.pathname.match(STREAM_PATH);
  if (stream) {
    const sp = store.listSpeakers().find((s) => s.id === stream[1]);
    const station = sp && stationFor(sp, Number(stream[2]));
    if (!station) return sendJson(res, 404, { error: 'Станция не настроена' });
    log(`[stream] ${req.method} ${label(sp)}/${stream[2]} от ${req.socket.remoteAddress}`);
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

const { port } = store.getConfig();
server.listen(port, '0.0.0.0', () => {
  log(`SoundTouch Bridge: http://localhost:${port}`);
  const speakers = store.listSpeakers();
  if (!speakers.length) log('Колонки не добавлены — добавьте их в веб-форме');
  speakers.forEach(startBridge);
});
