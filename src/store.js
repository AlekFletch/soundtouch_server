// Хранилище настроек: data/config.json
// {
//   port, bridgeHost, storePresetOnSpeaker,
//   speakers: [{ id, host, name, apiPort?, wsPort?, upnpDescriptionUrl?, slots: { 1..6: station|null } }]
// }
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.CONFIG_FILE || join(ROOT, 'data', 'config.json');

const emptySlots = () => ({ 1: null, 2: null, 3: null, 4: null, 5: null, 6: null });

const DEFAULTS = {
  // Порт веб-формы и прокси потоков
  port: 8000,
  // Адрес этого устройства, который увидят колонки (пусто = определить автоматически)
  bridgeHost: '',
  // Записывать ли пресет на колонку при сохранении кнопки (проверяется на шаге 1)
  storePresetOnSpeaker: true,
  speakers: [],
};

const SPEAKER_FIELDS = ['host', 'name', 'apiPort', 'wsPort', 'upnpDescriptionUrl'];

let config = load();
applyEnv();

function newId() {
  return randomBytes(3).toString('hex');
}

function normalizeSpeaker(s) {
  return {
    id: s.id || newId(),
    host: String(s.host || '').trim(),
    name: s.name || '',
    ...(s.apiPort ? { apiPort: Number(s.apiPort) } : {}),
    ...(s.wsPort ? { wsPort: Number(s.wsPort) } : {}),
    ...(s.upnpDescriptionUrl ? { upnpDescriptionUrl: s.upnpDescriptionUrl } : {}),
    slots: { ...emptySlots(), ...s.slots },
  };
}

function load() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {}
  const cfg = { ...structuredClone(DEFAULTS), ...saved };
  // Миграция со старого формата (одна колонка)
  if (!saved.speakers && saved.speakerHost) {
    cfg.speakers = [{ host: saved.speakerHost, upnpDescriptionUrl: saved.upnpDescriptionUrl, slots: saved.slots }];
  }
  delete cfg.speakerHost;
  delete cfg.upnpDescriptionUrl;
  delete cfg.slots;
  cfg.speakers = (cfg.speakers || []).map(normalizeSpeaker);
  return cfg;
}

// Переменные окружения:
//   PORT, BRIDGE_HOST
//   SPEAKER_HOST=192.168.1.50,192.168.1.51  — добавить колонки (если их ещё нет)
//   UPNP_DESCRIPTION_URL                   — для единственной колонки из SPEAKER_HOST
//   SPEAKERS='[{"host":"127.0.0.1","apiPort":8090,...}]' — полное описание (для эмулятора и тестов)
function applyEnv() {
  if (process.env.PORT) config.port = Number(process.env.PORT);
  if (process.env.BRIDGE_HOST) config.bridgeHost = process.env.BRIDGE_HOST;

  let list = [];
  if (process.env.SPEAKERS) list = JSON.parse(process.env.SPEAKERS);
  else if (process.env.SPEAKER_HOST) {
    const hosts = process.env.SPEAKER_HOST.split(',').map((h) => h.trim()).filter(Boolean);
    list = hosts.map((host) => ({ host, upnpDescriptionUrl: hosts.length === 1 ? process.env.UPNP_DESCRIPTION_URL : undefined }));
  }
  for (const s of list) {
    const existing = config.speakers.find((x) => x.host === s.host && (x.apiPort || 0) === (s.apiPort || 0));
    if (existing) Object.assign(existing, pick(s, SPEAKER_FIELDS));
    else config.speakers.push(normalizeSpeaker(s));
  }
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, FILE);
}

export function getConfig() {
  return config;
}

export function updateConfig(patch) {
  for (const key of ['bridgeHost', 'storePresetOnSpeaker']) if (key in patch) config[key] = patch[key];
  save();
  return config;
}

// ---------- колонки ----------

export function listSpeakers() {
  return config.speakers;
}

export function getSpeaker(id) {
  const sp = config.speakers.find((s) => s.id === id);
  if (!sp) throw new Error('Колонка не найдена');
  return sp;
}

export function findSpeakerByHost(host) {
  return config.speakers.find((s) => s.host === host);
}

export function addSpeaker(data) {
  const host = String(data.host || '').trim();
  if (!/^[\w.:-]+$/.test(host)) throw new Error('Некорректный IP колонки');
  const existing = findSpeakerByHost(host);
  if (existing) return existing;
  const sp = normalizeSpeaker({ ...pick(data, SPEAKER_FIELDS), host });
  config.speakers.push(sp);
  save();
  return sp;
}

export function updateSpeaker(id, patch) {
  const sp = getSpeaker(id);
  if ('host' in patch && !/^[\w.:-]+$/.test(String(patch.host).trim())) throw new Error('Некорректный IP колонки');
  Object.assign(sp, pick(patch, SPEAKER_FIELDS));
  if ('host' in patch) sp.host = String(patch.host).trim();
  save();
  return sp;
}

export function removeSpeaker(id) {
  getSpeaker(id);
  config.speakers = config.speakers.filter((s) => s.id !== id);
  save();
}

// ---------- кнопки ----------

export function getSlot(speakerId, n) {
  return getSpeaker(speakerId).slots[n] || null;
}

export function setSlot(speakerId, n, station) {
  const sp = getSpeaker(speakerId);
  sp.slots[n] = station
    ? { name: String(station.name || 'Радио'), url: String(station.url), favicon: station.favicon || '' }
    : null;
  save();
  return sp.slots[n];
}
