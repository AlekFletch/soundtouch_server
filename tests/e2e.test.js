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
let radio, radioUrl, fakeA, fakeB, A, B, bridge, bridgeUrl, tmp;
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

const streamUrl = (sp, n) => `${bridgeUrl}/stream/${sp.id}/${n}`;

// ---------- запуск ----------

before(async () => {
  radio = await startRadio();
  radioUrl = `http://${HOST}:${radio.address().port}`;
  fakeA = await createFakeSpeaker({ host: HOST, apiPort: 0, wsPort: 0, upnpPort: 0, name: 'Гостиная', type: 'SoundTouch 20', deviceId: 'AAAAAAAAAAAA' });
  fakeB = await createFakeSpeaker({ host: HOST, apiPort: 0, wsPort: 0, upnpPort: 0, name: 'Кухня', type: 'SoundTouch 10', deviceId: 'BBBBBBBBBBBB' });
  tmp = mkdtempSync(join(tmpdir(), 'stb-'));
  const port = await freePort();
  bridgeUrl = `http://${HOST}:${port}`;
  const spec = (f) => ({ host: HOST, apiPort: f.ports.api, wsPort: f.ports.ws, upnpDescriptionUrl: f.descriptionUrl });
  bridge = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      CONFIG_FILE: join(tmp, 'config.json'),
      SPEAKERS: JSON.stringify([spec(fakeA), spec(fakeB)]),
      PRESET_SETTLE_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout.on('data', (d) => (bridgeLog += d));
  bridge.stderr.on('data', (d) => (bridgeLog += d));
  await waitFor(async () => {
    const { data } = await api('/api/status').catch(() => ({ data: [] }));
    return data.length === 2 && data.every((s) => s.bridgeConnected);
  }, { message: 'мост подключился к обеим колонкам' });
  const { speakers } = (await api('/api/config')).data;
  A = speakers.find((s) => s.apiPort === fakeA.ports.api);
  B = speakers.find((s) => s.apiPort === fakeB.ports.api);
});

after(async () => {
  bridge?.kill();
  await fakeA?.close();
  await fakeB?.close();
  radio?.closeAllConnections();
  await new Promise((r) => radio?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- тесты ----------

test('статус показывает обе колонки онлайн', async () => {
  const { data } = await api('/api/status');
  const byId = Object.fromEntries(data.map((s) => [s.id, s]));
  assert.equal(byId[A.id].online, true);
  assert.equal(byId[A.id].name, 'Гостиная');
  assert.equal(byId[A.id].type, 'SoundTouch 20');
  assert.equal(byId[B.id].type, 'SoundTouch 10');
  assert.equal(byId[A.id].volume, 30);
  assert.equal(byId[A.id].nowPlaying.source, 'STANDBY');
});

test('веб-форма отдаётся', async () => {
  const res = await fetch(bridgeUrl + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /SoundTouch Bridge/);
  assert.equal((await fetch(bridgeUrl + '/../package.json')).status, 404);
});

test('сохранение кнопки записывает пресет только на свою колонку', async () => {
  const { data } = await api('/api/slot', { speaker: A.id, slot: 1, name: 'Test FM', url: `${radioUrl}/list.pls` });
  assert.equal(data.storedOnSpeaker, true, data.warning);
  const preset = fakeA.state.presets.get(1);
  assert.equal(preset.source, 'UPNP');
  assert.equal(preset.name, 'Test FM');
  assert.equal(preset.location, streamUrl(A, 1));
  assert.equal(fakeB.state.presets.size, 0);
});

test('нажатие кнопки 1 на A → A играет поток через прокси (pls → redirect → mp3)', async () => {
  fakeA.pressPreset(1);
  const stream = await waitFor(() => fakeA.state.stream?.bytes > 20000 && fakeA.state.stream, { message: 'колонка A получает поток' });
  assert.match(stream.url, new RegExp(`/stream/${A.id}/1\\?t=\\d+$`));
  assert.equal(stream.contentType, 'audio/mpeg');
  assert.equal(fakeA.state.nowPlaying.name, 'Test FM');
  assert.equal(fakeA.state.nowPlaying.playStatus, 'PLAY_STATE');
  assert.equal(fakeB.state.stream, null);
});

test('у колонок свои наборы: кнопка 1 на B включает станцию B на колонке B', async () => {
  await api('/api/slot', { speaker: B.id, slot: 1, name: 'Kitchen FM', url: `${radioUrl}/live.mp3` });
  fakeB.pressPreset(1);
  const stream = await waitFor(() => fakeB.state.stream?.bytes > 8000 && fakeB.state.stream, { message: 'колонка B получает поток' });
  assert.match(stream.url, new RegExp(`/stream/${B.id}/1\\?`));
  assert.equal(fakeB.state.nowPlaying.name, 'Kitchen FM');
  assert.equal(fakeA.state.nowPlaying.name, 'Test FM');
});

test('повторное нажатие не дублирует запуск, если колонка уже играет эту кнопку', async () => {
  const before = fakeA.state.stream;
  await new Promise((r) => setTimeout(r, 1100)); // дольше защиты от дребезга
  fakeA.pressPreset(1);
  await waitFor(() => bridgeLog.includes('кнопка 1: колонка уже играет'), { message: 'мост понял, что колонка уже играет' });
  assert.equal(fakeA.state.stream, before);
});

test('HLS-станция: прокси возвращает 502 с понятной ошибкой', async () => {
  await api('/api/slot', { speaker: A.id, slot: 2, name: 'HLS', url: `${radioUrl}/hls.m3u8` });
  const res = await fetch(streamUrl(A, 2));
  assert.equal(res.status, 502);
  assert.match(await res.text(), /HLS/);
});

test('недоступная станция: 502', async () => {
  await api('/api/slot', { speaker: A.id, slot: 3, name: 'Gone', url: `${radioUrl}/gone` });
  const res = await fetch(streamUrl(A, 3));
  assert.equal(res.status, 502);
  assert.match(await res.text(), /404/);
});

test('ненастроенная кнопка: мост не падает', async () => {
  fakeB.pressPreset(6);
  await waitFor(() => bridgeLog.includes('кнопка 6 не настроена'), { message: 'сообщение о ненастроенной кнопке' });
  assert.equal((await api('/api/status')).data.every((s) => s.online), true);
});

test('«Прослушать» + удержание кнопки 4 сохраняет станцию на кнопку 4 этой колонки', async () => {
  const { data } = await api('/api/play', { speaker: B.id, name: 'Preview FM', url: `${radioUrl}/redirect` });
  assert.equal(data.ok, true);
  await waitFor(() => fakeB.state.stream?.url.includes(`/stream/${B.id}/0`) && fakeB.state.stream.bytes > 4096, { message: 'B играет предпрослушивание' });

  fakeB.holdPreset(4);
  const speakerB = await waitFor(async () => {
    const sp = (await api('/api/config')).data.speakers.find((s) => s.id === B.id);
    return sp.slots[4]?.name === 'Preview FM' && sp;
  }, { message: 'слот 4 колонки B сохранён' });
  assert.equal(speakerB.slots[4].url, `${radioUrl}/redirect`);
  await waitFor(() => fakeB.state.presets.get(4)?.location === streamUrl(B, 4), { message: 'пресет 4 переписан на поток B/4' });
  const speakerA = (await api('/api/config')).data.speakers.find((s) => s.id === A.id);
  assert.equal(speakerA.slots[4], null);
});

test('копирование станций с A на B', async () => {
  const { data } = await api('/api/slots/copy', { from: A.id, to: B.id });
  assert.equal(data.ok, true);
  assert.equal(data.speaker.slots[1].name, 'Test FM');
  assert.equal(data.speaker.slots[4], null);
  assert.equal(fakeB.state.presets.get(1).location, streamUrl(B, 1));
  assert.equal((await api('/api/slots/copy', { from: A.id, to: A.id })).status, 400);
});

test('громкость и клавиши управляют нужной колонкой', async () => {
  assert.equal((await api('/api/volume', { speaker: B.id, volume: 55 })).data.volume, 55);
  assert.equal(fakeB.state.volume, 55);
  assert.equal(fakeA.state.volume, 30);
  assert.equal((await api('/api/key', { speaker: A.id, key: 'RM -rf' })).status, 400);
  assert.equal((await api('/api/key', { speaker: A.id, key: 'POWER' })).data.ok, true);
  assert.equal(fakeA.state.nowPlaying.source, 'STANDBY');
  assert.notEqual(fakeB.state.nowPlaying.source, 'STANDBY');
});

test('валидация: неизвестная колонка, неверная кнопка и ссылка', async () => {
  assert.equal((await api('/api/slot', { speaker: 'nope', slot: 1, url: 'http://x' })).status, 400);
  assert.equal((await api('/api/slot', { speaker: A.id, slot: 7, url: 'http://x' })).status, 400);
  assert.equal((await api('/api/slot', { speaker: A.id, slot: 1, url: 'ftp://x' })).status, 400);
  assert.equal((await api('/api/play', { speaker: A.id, url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await api('/api/speakers', { host: 'bad host; rm' })).status, 400);
  assert.equal((await fetch(`${bridgeUrl}/stream/ffffff/1`)).status, 404);
});

test('очистка кнопки', async () => {
  await api('/api/slot', { speaker: A.id, slot: 3, url: '' });
  const sp = (await api('/api/config')).data.speakers.find((s) => s.id === A.id);
  assert.equal(sp.slots[3], null);
  assert.equal((await fetch(streamUrl(A, 3))).status, 404);
});

test('добавление, переименование и удаление колонки', async () => {
  const { data: added } = await api('/api/speakers', { host: '127.0.0.2' });
  assert.match(added.id, /^[0-9a-f]+$/);
  assert.equal((await api('/api/speakers', { host: '127.0.0.2' })).data.id, added.id, 'повторное добавление не дублирует');
  await api('/api/speakers/update', { id: added.id, name: 'Спальня' });
  let speakers = (await api('/api/config')).data.speakers;
  assert.equal(speakers.find((s) => s.id === added.id).name, 'Спальня');
  await api('/api/speakers/remove', { id: added.id });
  speakers = (await api('/api/config')).data.speakers;
  assert.equal(speakers.length, 2);
});

test('https отвергается колонкой напрямую (как настоящая SoundTouch)', async () => {
  const res = await fetch(fakeA.descriptionUrl.replace('description.xml', 'AVTransport/Control'), {
    method: 'POST',
    headers: { SOAPACTION: '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"' },
    body: '<CurrentURI>https://secure.example/live</CurrentURI>',
  });
  assert.equal(res.status, 500);
  assert.match(await res.text(), /402/);
});
