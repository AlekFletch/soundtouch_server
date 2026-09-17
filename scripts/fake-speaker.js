// Эмулятор колонки SoundTouch для разработки и тестов без настоящей колонки.
//
//   node scripts/fake-speaker.js [--api 8090] [--ws 18080] [--upnp 8091] [--name "Кухня"] [--type "SoundTouch 10"]
//
// Эмулирует:
//   - REST API (порт --api): /info, /now_playing, /presets, /volume, /key, /storePreset
//   - WebSocket (порт --ws, подпротокол gabbo): nowSelectionUpdated, presetsUpdated, nowPlayingUpdated
//   - UPnP AVTransport (порт --upnp): /description.xml, SetAVTransportURI, Play, Stop.
//     Как и настоящая колонка, отвергает https:// и реально скачивает поток.
//
// Команды в консоли: 1–6 — короткое нажатие кнопки, h1–h6 — удержание (сохранить текущее), s — состояние.
//
// Мост для работы с эмулятором запускать так:
//   SPEAKERS='[{"host":"127.0.0.1","apiPort":8090,"wsPort":18080,"upnpDescriptionUrl":"http://127.0.0.1:8091/description.xml"}]' npm start
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { escapeXml, tagText, tagAttr } from '../src/xml.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export async function createFakeSpeaker({
  host = '127.0.0.1',
  apiPort = 8090,
  wsPort = 18080,
  upnpPort = 8091,
  name = 'Fake SoundTouch',
  type = 'SoundTouch 20',
  deviceId: DEVICE_ID = 'F4E11E000001',
  rejectStorePreset = false,
  log = () => {},
} = {}) {
  const state = {
    volume: 30,
    presets: new Map(), // id → { source, location, name }
    nowPlaying: { source: 'STANDBY', location: '', name: '', playStatus: '' },
    avUri: '',
    avTitle: '',
    stream: null, // { req, bytes, url, contentType, error }
    events: [], // отправленные в WebSocket сообщения
  };
  const clients = new Set();

  // ---------- WebSocket ----------

  function broadcast(inner) {
    const xml = `<updates deviceID="${DEVICE_ID}">${inner}</updates>`;
    state.events.push(xml);
    const payload = Buffer.from(xml);
    const len = payload.length;
    const header = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : null;
    if (!header) throw new Error('Сообщение слишком длинное');
    for (const socket of clients) socket.write(Buffer.concat([header, payload]));
  }

  const wsServer = http.createServer((req, res) => res.writeHead(426).end());
  wsServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (protocols.includes('gabbo') ? 'Sec-WebSocket-Protocol: gabbo\r\n' : '') +
        '\r\n',
    );
    clients.add(socket);
    log('[ws] клиент подключён');
    socket.on('data', (buf) => {
      if ((buf[0] & 0x0f) === 0x8) socket.end(); // close-кадр
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  // ---------- Воспроизведение ----------

  function presetXml(id, p) {
    return (
      `<preset id="${id}" createdOn="0" updatedOn="0">` +
      `<ContentItem source="${escapeXml(p.source)}" location="${escapeXml(p.location)}" isPresetable="true">` +
      `<itemName>${escapeXml(p.name)}</itemName></ContentItem></preset>`
    );
  }
  const presetsXml = () => `<presets>${[...state.presets].sort(([a], [b]) => a - b).map(([id, p]) => presetXml(id, p)).join('')}</presets>`;

  function nowPlayingXml() {
    const np = state.nowPlaying;
    if (np.source === 'STANDBY') return `<nowPlaying deviceID="${DEVICE_ID}" source="STANDBY"><ContentItem source="STANDBY" isPresetable="false" /></nowPlaying>`;
    return (
      `<nowPlaying deviceID="${DEVICE_ID}" source="${np.source}">` +
      `<ContentItem source="${np.source}" location="${escapeXml(np.location)}" isPresetable="true"><itemName>${escapeXml(np.name)}</itemName></ContentItem>` +
      `<track>${escapeXml(np.name)}</track><stationName>${escapeXml(np.name)}</stationName>` +
      `<playStatus>${np.playStatus}</playStatus></nowPlaying>`
    );
  }

  function stopStream() {
    state.stream?.req.destroy();
    state.stream = null;
  }

  function startStream(url, title) {
    stopStream();
    const stream = { url, bytes: 0, contentType: '', error: '' };
    state.stream = stream;
    state.nowPlaying = { source: 'UPNP', location: url, name: title, playStatus: 'BUFFERING_STATE' };
    stream.req = http.get(url, (res) => {
      stream.contentType = res.headers['content-type'] || '';
      if (res.statusCode !== 200) {
        stream.error = `HTTP ${res.statusCode}`;
        state.nowPlaying.playStatus = 'STOP_STATE';
        res.resume();
        return;
      }
      state.nowPlaying.playStatus = 'PLAY_STATE';
      broadcast(`<nowPlayingUpdated>${nowPlayingXml()}</nowPlayingUpdated>`);
      res.on('data', (chunk) => (stream.bytes += chunk.length));
    });
    stream.req.on('error', (err) => {
      if (state.stream === stream) stream.error = err.message;
    });
    log(`[upnp] играю ${title}: ${url}`);
  }

  // Короткое нажатие кнопки: колонка сообщает выбор пресета.
  // Пресеты UPNP сама не воспроизводит (как после отключения облака Bose).
  function pressPreset(id) {
    const p = state.presets.get(id);
    const item = p ? presetXml(id, p) : `<preset id="${id}"><ContentItem source="INVALID_SOURCE" isPresetable="true" /></preset>`;
    broadcast(`<nowSelectionUpdated>${item}</nowSelectionUpdated>`);
    log(`[key] кнопка ${id}`);
  }

  // Удержание кнопки: текущий источник сохраняется в пресет
  function holdPreset(id) {
    const np = state.nowPlaying;
    if (np.source === 'STANDBY') return log('[key] нечего сохранять — колонка в режиме ожидания');
    state.presets.set(id, { source: np.source, location: np.location, name: np.name });
    broadcast(`<presetsUpdated>${presetsXml()}</presetsUpdated>`);
    log(`[key] удержание ${id}: сохранено «${np.name}»`);
  }

  // ---------- REST API ----------

  async function body(req) {
    let data = '';
    for await (const c of req) data += c;
    return data;
  }

  const api = http.createServer(async (req, res) => {
    const xml = (code, text) => res.writeHead(code, { 'Content-Type': 'text/xml' }).end(`<?xml version="1.0" encoding="UTF-8" ?>${text}`);
    const b = req.method === 'POST' ? await body(req) : '';
    switch (`${req.method} ${req.url}`) {
      case 'GET /info':
        return xml(200, `<info deviceID="${DEVICE_ID}"><name>${escapeXml(name)}</name><type>${escapeXml(type)}</type><margeAccountUUID /></info>`);
      case 'GET /now_playing':
        return xml(200, nowPlayingXml());
      case 'GET /presets':
        return xml(200, presetsXml());
      case 'GET /volume':
        return xml(200, `<volume deviceID="${DEVICE_ID}"><targetvolume>${state.volume}</targetvolume><actualvolume>${state.volume}</actualvolume><muteenabled>false</muteenabled></volume>`);
      case 'POST /volume':
        state.volume = Number(tagText(b, 'volume'));
        return xml(200, '<status>/volume</status>');
      case 'POST /key': {
        const key = tagText(b, 'key');
        const preset = key.match(/^PRESET_([1-6])$/);
        if (preset && tagAttr(b, 'key', 'state') === 'release') pressPreset(Number(preset[1]));
        if (key === 'POWER' && tagAttr(b, 'key', 'state') === 'release') {
          stopStream();
          state.nowPlaying = { source: 'STANDBY', location: '', name: '', playStatus: '' };
        }
        return xml(200, '<status>/key</status>');
      }
      case 'POST /storePreset': {
        if (rejectStorePreset) return xml(500, '<errors><error value="1005" name="UNKNOWN_ERROR">storePreset отключён</error></errors>');
        const id = Number(tagAttr(b, 'preset', 'id'));
        state.presets.set(id, { source: tagAttr(b, 'ContentItem', 'source'), location: tagAttr(b, 'ContentItem', 'location'), name: tagText(b, 'itemName') });
        broadcast(`<presetsUpdated>${presetsXml()}</presetsUpdated>`);
        log(`[api] storePreset ${id}: ${tagText(b, 'itemName')}`);
        return xml(200, presetsXml());
      }
      default:
        return xml(404, `<errors><error name="HTTP_STATUS_NOT_FOUND">${escapeXml(req.url)}</error></errors>`);
    }
  });

  // ---------- UPnP ----------

  const soapFault = (res, code, desc) =>
    res.writeHead(500, { 'Content-Type': 'text/xml' }).end(
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`,
    );

  const upnp = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/description.xml') {
      return res.writeHead(200, { 'Content-Type': 'text/xml' }).end(
        '<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>' +
          '<deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>${escapeXml(name)}</friendlyName>' +
          '<serviceList><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/RenderingControl/Control</controlURL></service>' +
          '<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>' +
          '<controlURL>/AVTransport/Control</controlURL><eventSubURL>/AVTransport/Event</eventSubURL><SCPDURL>/AVTransport/scpd.xml</SCPDURL></service>' +
          '</serviceList></device></root>',
      );
    }
    if (req.method === 'POST' && req.url === '/AVTransport/Control') {
      const action = String(req.headers.soapaction || '').replace(/"/g, '').split('#')[1];
      const b = await body(req);
      const ok = () => res.writeHead(200, { 'Content-Type': 'text/xml' }).end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>`);
      if (action === 'SetAVTransportURI') {
        const uri = tagText(b, 'CurrentURI');
        if (!uri.startsWith('http://')) return soapFault(res, 402, 'No URI supplied');
        state.avUri = uri;
        // tagText уже снимает экранирование, внутри — DIDL-Lite с <dc:title>
        state.avTitle = tagText(tagText(b, 'CurrentURIMetaData'), 'title');
        return ok();
      }
      if (action === 'Play') {
        if (!state.avUri) return soapFault(res, 701, 'Transition not available');
        startStream(state.avUri, state.avTitle);
        return ok();
      }
      if (action === 'Stop') {
        stopStream();
        state.nowPlaying.playStatus = 'STOP_STATE';
        return ok();
      }
      return soapFault(res, 401, 'Invalid Action');
    }
    res.writeHead(404).end();
  });

  // Порт 0 — выбрать свободный (для тестов)
  const listen = (server, port) =>
    new Promise((resolve, reject) => server.once('error', reject).listen(port, host, () => resolve(server.address().port)));
  const [realApi, realWs, realUpnp] = await Promise.all([listen(api, apiPort), listen(wsServer, wsPort), listen(upnp, upnpPort)]);

  return {
    state,
    pressPreset,
    holdPreset,
    ports: { api: realApi, ws: realWs, upnp: realUpnp },
    descriptionUrl: `http://${host}:${realUpnp}/description.xml`,
    async close() {
      stopStream();
      for (const s of clients) s.destroy();
      await Promise.all([api, wsServer, upnp].map((s) => new Promise((r) => s.close(r))));
    },
  };
}

// ---------- Запуск из консоли ----------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? Number(process.argv[i + 1]) : def;
  };
  const str = (n, def) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const opts = {
    apiPort: arg('api', 8090),
    wsPort: arg('ws', 18080),
    upnpPort: arg('upnp', 8091),
    name: str('name', 'Fake SoundTouch'),
    type: str('type', 'SoundTouch 20'),
    log: (...a) => console.log(...a),
  };
  const fake = await createFakeSpeaker(opts);
  console.log(`Эмулятор SoundTouch запущен: API :${opts.apiPort}, WebSocket :${opts.wsPort}, UPnP ${fake.descriptionUrl}`);
  console.log('Запуск моста для эмулятора:');
  const spec = JSON.stringify([{ host: '127.0.0.1', apiPort: opts.apiPort, wsPort: opts.wsPort, upnpDescriptionUrl: fake.descriptionUrl }]);
  console.log(`  SPEAKERS='${spec}' npm start`);
  console.log('Вторая колонка: node scripts/fake-speaker.js --api 8092 --ws 18082 --upnp 8093 --name "Fake ST10" --type "SoundTouch 10"');
  console.log('Команды: 1–6 — нажать кнопку, h1–h6 — удержать кнопку, s — состояние');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (line) => {
    const cmd = line.trim();
    if (/^[1-6]$/.test(cmd)) fake.pressPreset(Number(cmd));
    else if (/^h[1-6]$/.test(cmd)) fake.holdPreset(Number(cmd[1]));
    else if (cmd === 's') {
      const { stream, nowPlaying, presets, volume } = fake.state;
      console.log({ nowPlaying, volume, presets: Object.fromEntries(presets), stream: stream && { url: stream.url, bytes: stream.bytes, error: stream.error } });
    }
  });
}
