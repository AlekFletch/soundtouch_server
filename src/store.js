// Хранилище настроек: data/config.json
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.CONFIG_FILE || join(ROOT, 'data', 'config.json');

const DEFAULTS = {
  // IP колонки SoundTouch в домашней сети
  speakerHost: '',
  // Порт веб-формы и прокси потоков
  port: 8000,
  // Адрес этого устройства, который увидит колонка (пусто = определить автоматически)
  bridgeHost: '',
  // URL description.xml UPnP колонки (пусто = найти через SSDP)
  upnpDescriptionUrl: '',
  // Записывать ли пресет на колонку при сохранении кнопки (проверяется на шаге 1)
  storePresetOnSpeaker: true,
  slots: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null },
};

// Переменные окружения важнее сохранённых настроек
const ENV = Object.fromEntries(
  Object.entries({
    speakerHost: process.env.SPEAKER_HOST,
    port: process.env.PORT && Number(process.env.PORT),
    bridgeHost: process.env.BRIDGE_HOST,
    upnpDescriptionUrl: process.env.UPNP_DESCRIPTION_URL,
  }).filter(([, v]) => v),
);

let config = { ...load(), ...ENV };

function load() {
  try {
    const saved = JSON.parse(readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...saved, slots: { ...DEFAULTS.slots, ...saved.slots } };
  } catch {
    return structuredClone(DEFAULTS);
  }
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
  const allowed = ['speakerHost', 'bridgeHost', 'upnpDescriptionUrl', 'storePresetOnSpeaker'];
  for (const key of allowed) if (key in patch) config[key] = patch[key];
  save();
  return config;
}

export function getSlot(n) {
  return config.slots[n] || null;
}

export function setSlot(n, station) {
  config.slots[n] = station
    ? { name: String(station.name || 'Радио'), url: String(station.url), favicon: station.favicon || '' }
    : null;
  save();
  return config.slots[n];
}
