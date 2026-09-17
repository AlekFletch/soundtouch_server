// Клиент локального REST API колонки SoundTouch (порт 8090)
import net from 'node:net';
import { escapeXml, tagText, tagAttr, tagBlocks } from './xml.js';

// Порты можно переопределить для тестов с эмулятором (scripts/fake-speaker.js)
export const API_PORT = Number(process.env.SOUNDTOUCH_API_PORT) || 8090;
const TIMEOUT = 5000;

async function request(host, path, body) {
  const res = await fetch(`http://${host}:${API_PORT}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/xml' } : undefined,
    body,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  if (!res.ok || text.includes('<errors')) {
    throw new Error(`SoundTouch ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return text;
}

export async function getInfo(host) {
  const xml = await request(host, '/info');
  return {
    deviceId: tagAttr(xml, 'info', 'deviceID'),
    name: tagText(xml, 'name'),
    type: tagText(xml, 'type'),
    raw: xml,
  };
}

export async function getNowPlaying(host) {
  const xml = await request(host, '/now_playing');
  return {
    source: tagAttr(xml, 'nowPlaying', 'source'),
    location: tagAttr(xml, 'ContentItem', 'location'),
    station: tagText(xml, 'stationName') || tagText(xml, 'itemName') || tagText(xml, 'track'),
    artist: tagText(xml, 'artist'),
    track: tagText(xml, 'track'),
    art: tagText(xml, 'art'),
    playStatus: tagText(xml, 'playStatus'),
    raw: xml,
  };
}

export async function getPresets(host) {
  const xml = await request(host, '/presets');
  return tagBlocks(xml, 'preset').map((block) => ({
    id: Number(tagAttr(block, 'preset', 'id')),
    source: tagAttr(block, 'ContentItem', 'source'),
    location: tagAttr(block, 'ContentItem', 'location'),
    name: tagText(block, 'itemName'),
  }));
}

export async function getVolume(host) {
  const xml = await request(host, '/volume');
  return Number(tagText(xml, 'actualvolume') || tagText(xml, 'targetvolume'));
}

export async function setVolume(host, value) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value))));
  await request(host, '/volume', `<volume>${v}</volume>`);
  return v;
}

// Эмуляция нажатия кнопки: PRESET_1..6, POWER, PLAY, PAUSE, VOLUME_UP и т. д.
export async function pressKey(host, key) {
  const k = escapeXml(key);
  await request(host, '/key', `<key state="press" sender="Gabbo">${k}</key>`);
  await request(host, '/key', `<key state="release" sender="Gabbo">${k}</key>`);
}

// Записать пресет на колонку, чтобы на дисплее было название, а нажатие кнопки
// порождало событие nowSelectionUpdated.
// TODO(шаг 1): проверить на реальной колонке, какой ContentItem принимается
// после отключения облака. Первый кандидат — UPNP с адресом потока моста.
export async function storePreset(host, id, { name, location, art }) {
  const body =
    `<preset id="${Number(id)}">` +
    `<ContentItem source="UPNP" type="" location="${escapeXml(location)}" isPresetable="true">` +
    `<itemName>${escapeXml(name)}</itemName>` +
    (art ? `<containerArt>${escapeXml(art)}</containerArt>` : '') +
    `</ContentItem></preset>`;
  return request(host, '/storePreset', body);
}

// IP этого устройства, с которого видна колонка (его колонка будет использовать для потока)
export function localAddressTowards(host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: API_PORT, timeout: TIMEOUT });
    socket.once('connect', () => {
      const addr = socket.localAddress?.replace(/^::ffff:/, '');
      socket.destroy();
      resolve(addr);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Колонка ${host} не отвечает`));
    });
    socket.once('error', reject);
  });
}
