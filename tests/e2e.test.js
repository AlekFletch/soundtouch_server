// Сквозной тест: мост (src/server.js) ↔ эмулятор колонки ↔ эмулятор радиостанции.
// Сеть интернет не нужна.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeSpeaker } from '../scripts/fake-speaker.js';

const HOST = '127.0.0.1';
let radio, radioUrl, fake, bridge, bridgeUrl, tmp;
let bridgeLog = '';

// ---------- эмулятор радиостанции ----------

function startRadio() {
  const server = http.createServer((req, res) => {
    const base = `http://${HOST}:${server.address().port}`;
    switch (req.url) {
      case '/live.mp3': {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-name': 'Test FM' });
        const chunk = Buffer.alloc(4096, 0xff);
        const timer = setInterval(() => res.write(chunk), 20);
        res.on('close', () => clearInterval(timer));
        return;
      }
      case '/list.pls':
        return res.writeHead(200, { 'Content-Type': 'audio/x-scpls' }).end(`[playlist]\nFile1=${base}/redirect\n`);
      case '/redirect':
        return res.writeHead(302, { Location: '/live.mp3' }).end();
      case '/hls.m3u8':
        return res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n#EXT-X-TARGETDURATION:10\nseg1.ts\n');
      case '/gone':
        return res.writeHead(404).end();
      default:
        return res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, HOST, () => r(server)));
}

// ---------- утилиты ----------

const freePort = () =>
  new Promise((r) => {
    const s = http.createServer().listen(0, HOST, () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });

async function waitFor(check, { timeout = 8000, step = 100, message = 'условие' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Не дождались: ${message}\n--- лог моста ---\n${bridgeLog}`);
    await new Promise((r) => setTimeout(r, step));
  }
}

async function api(path, body) {
  const res = await fetch(bridgeUrl + path, body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

// ---------- запуск ----------

before(async () => {
  radio = await startRadio();
  radioUrl = `http://${HOST}:${radio.address().port}`;
  fake = await createFakeSpeaker({ host: HOST, apiPort: 0, wsPort: 0, upnpPort: 0 });
  tmp = mkdtempSync(join(tmpdir(), 'stb-'));
  const port = await freePort();
  bridgeUrl = `http://${HOST}:${port}`;
  bridge = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      CONFIG_FILE: join(tmp, 'config.json'),
      SPEAKER_HOST: HOST,
      SOUNDTOUCH_API_PORT: String(fake.ports.api),
      SOUNDTOUCH_WS_PORT: String(fake.ports.ws),
      UPNP_DESCRIPTION_URL: fake.descriptionUrl,
      PRESET_SETTLE_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout.on('data', (d) => (bridgeLog += d));
  bridge.stderr.on('data', (d) => (bridgeLog += d));
  await waitFor(async () => (await api('/api/status').catch(() => ({ data: {} }))).data.bridgeConnected, { message: 'мост подключился к WebSocket' });
});

after(async () => {
  bridge?.kill();
  await fake?.close();
  radio?.closeAllConnections();
  await new Promise((r) => radio?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- тесты ----------

test('статус показывает колонку онлайн', async () => {
  const { data } = await api('/api/status');
  assert.equal(data.online, true);
  assert.equal(data.name, 'Fake SoundTouch');
  assert.equal(data.volume, 30);
  assert.equal(data.nowPlaying.source, 'STANDBY');
});

test('веб-форма отдаётся', async () => {
  const res = await fetch(bridgeUrl + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /SoundTouch Bridge/);
  assert.equal((await fetch(bridgeUrl + '/../package.json')).status, 404);
});

test('сохранение кнопки записывает пресет на колонку', async () => {
  const { data } = await api('/api/slot', { slot: 1, name: 'Test FM', url: `${radioUrl}/list.pls` });
  assert.equal(data.storedOnSpeaker, true, data.warning);
  const preset = fake.state.presets.get(1);
  assert.equal(preset.source, 'UPNP');
  assert.equal(preset.name, 'Test FM');
  assert.equal(preset.location, `${bridgeUrl}/stream/1`);
});

test('нажатие кнопки 1 → колонка играет поток через прокси (pls → redirect → mp3)', async () => {
  fake.pressPreset(1);
  const stream = await waitFor(() => fake.state.stream?.bytes > 20000 && fake.state.stream, { message: 'колонка получает поток' });
  assert.match(stream.url, /\/stream\/1\?t=\d+$/);
  assert.equal(stream.contentType, 'audio/mpeg');
  assert.equal(fake.state.nowPlaying.name, 'Test FM');
  assert.equal(fake.state.nowPlaying.playStatus, 'PLAY_STATE');
});

test('повторное нажатие не дублирует запуск, если колонка уже играет эту кнопку', async () => {
  const before = fake.state.stream;
  await new Promise((r) => setTimeout(r, 1100)); // дольше защиты от дребезга
  fake.pressPreset(1);
  await waitFor(() => bridgeLog.includes('уже играет'), { message: 'мост понял, что колонка уже играет' });
  assert.equal(fake.state.stream, before);
  assert.match(bridgeLog, /уже играет/);
});

test('HLS-станция: прокси возвращает 502 с понятной ошибкой', async () => {
  await api('/api/slot', { slot: 2, name: 'HLS', url: `${radioUrl}/hls.m3u8` });
  const res = await fetch(`${bridgeUrl}/stream/2`);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /HLS/);
});

test('недоступная станция: 502', async () => {
  await api('/api/slot', { slot: 3, name: 'Gone', url: `${radioUrl}/gone` });
  const res = await fetch(`${bridgeUrl}/stream/3`);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /404/);
});

test('ненастроенная кнопка: мост не падает', async () => {
  fake.pressPreset(6);
  await waitFor(() => bridgeLog.includes('кнопка 6 не настроена'), { message: 'сообщение о ненастроенной кнопке' });
  assert.equal((await api('/api/status')).data.online, true);
});

test('«Прослушать» + удержание кнопки 4 сохраняет станцию на кнопку 4', async () => {
  const { data } = await api('/api/play', { name: 'Preview FM', url: `${radioUrl}/redirect` });
  assert.equal(data.ok, true);
  await waitFor(() => fake.state.stream?.url.includes('/stream/0') && fake.state.stream.bytes > 4096, { message: 'колонка играет предпрослушивание' });

  fake.holdPreset(4);
  const cfg = await waitFor(async () => {
    const c = (await api('/api/config')).data;
    return c.slots[4]?.name === 'Preview FM' && c;
  }, { message: 'слот 4 сохранён' });
  assert.equal(cfg.slots[4].url, `${radioUrl}/redirect`);
  await waitFor(() => fake.state.presets.get(4)?.location === `${bridgeUrl}/stream/4`, { message: 'пресет 4 переписан на /stream/4' });
});

test('громкость и клавиши', async () => {
  assert.equal((await api('/api/volume', { volume: 55 })).data.volume, 55);
  assert.equal(fake.state.volume, 55);
  assert.equal((await api('/api/key', { key: 'RM -rf' })).status, 400);
  assert.equal((await api('/api/key', { key: 'POWER' })).data.ok, true);
  assert.equal(fake.state.nowPlaying.source, 'STANDBY');
});

test('валидация: неверная кнопка и ссылка', async () => {
  assert.equal((await api('/api/slot', { slot: 7, url: 'http://x' })).status, 400);
  assert.equal((await api('/api/slot', { slot: 1, url: 'ftp://x' })).status, 400);
  assert.equal((await api('/api/play', { url: 'javascript:alert(1)' })).status, 400);
});

test('очистка кнопки', async () => {
  await api('/api/slot', { slot: 3, url: '' });
  assert.equal((await api('/api/config')).data.slots[3], null);
  assert.equal((await fetch(`${bridgeUrl}/stream/3`)).status, 404);
});

test('https отвергается колонкой напрямую (как настоящая SoundTouch)', async () => {
  const res = await fetch(fake.descriptionUrl.replace('description.xml', 'AVTransport/Control'), {
    method: 'POST',
    headers: { SOAPACTION: '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"' },
    body: '<CurrentURI>https://secure.example/live</CurrentURI>',
  });
  assert.equal(res.status, 500);
  assert.match(await res.text(), /402/);
});
