// Разведка колонки (шаг 1 плана).
// Запуск:  node scripts/probe.js 192.168.1.50
// Без IP — только поиск устройств в сети.
// Скрипт выводит /info, /presets, /now_playing, данные UPnP и затем пишет все
// сообщения WebSocket. Нажимайте кнопки 1–6 на колонке и смотрите, что приходит.
// Выход — Ctrl+C. Полный лог сохраняется в data/probe-<время>.log
import { mkdirSync, appendFileSync } from 'node:fs';
import * as speaker from '../src/speaker.js';
import * as upnp from '../src/upnp.js';

const host = process.argv[2];
mkdirSync('data', { recursive: true });
const logFile = `data/probe-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
const out = (...args) => {
  const line = args.join(' ');
  console.log(line);
  appendFileSync(logFile, line + '\n');
};
const section = (title) => out(`\n===== ${title} =====`);

section('SSDP: устройства в сети');
const devices = await upnp.ssdpSearch({ st: 'ssdp:all', timeoutMs: 5000 });
for (const d of devices) out(`${d.address}  ${d.location}  ${d.server}`);

if (!host) {
  out('\nУкажите IP колонки: node scripts/probe.js <IP>');
  process.exit(0);
}

async function step(title, fn) {
  section(title);
  try {
    out(await fn());
  } catch (err) {
    out('ОШИБКА:', err.message);
  }
}

await step('/info', async () => (await speaker.getInfo(host)).raw);
await step('/now_playing', async () => (await speaker.getNowPlaying(host)).raw);
await step('/presets', async () => JSON.stringify(await speaker.getPresets(host), null, 2));
await step('Адрес этого компьютера со стороны колонки', () => speaker.localAddressTowards(host));
await step('UPnP AVTransport controlURL', async () => {
  const mine = devices.filter((d) => d.address === host);
  return mine.map((d) => d.location).join('\n') + '\n→ ' + (await upnp.getAvTransportUrl(host));
});

section(`WebSocket ws://${host}:8080 (gabbo) — нажимайте кнопки 1–6, Ctrl+C для выхода`);
const ws = new WebSocket(`ws://${host}:8080`, 'gabbo');
ws.onopen = () => out('[подключено]');
ws.onmessage = (e) => out(`\n[${new Date().toLocaleTimeString()}]\n${e.data}`);
ws.onerror = (e) => out('[ошибка]', e.message || '');
ws.onclose = () => {
  out('[соединение закрыто]');
  process.exit(0);
};
process.on('SIGINT', () => {
  out(`\nЛог сохранён: ${logFile}`);
  process.exit(0);
});
