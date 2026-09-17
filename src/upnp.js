// UPnP: поиск рендерера колонки (SSDP) и управление AVTransport
import dgram from 'node:dgram';
import { escapeXml, tagText, tagBlocks } from './xml.js';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';

// Все UPnP-устройства в сети: [{ address, location, server, st }]
export function ssdpSearch({ timeoutMs = 4000, st = 'urn:schemas-upnp-org:device:MediaRenderer:1' } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const header = (h) => (text.match(new RegExp(`^${h}:\\s*(.+)$`, 'im')) || [])[1]?.trim() || '';
      const location = header('location');
      if (location && !found.has(location)) {
        found.set(location, { address: rinfo.address, location, server: header('server'), st: header('st') });
      }
    });
    socket.on('error', () => {});
    socket.bind(0, () => {
      const msg =
        'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        `ST: ${st}\r\n\r\n`;
      socket.send(msg, SSDP_PORT, SSDP_ADDR);
      setTimeout(() => socket.send(msg, SSDP_PORT, SSDP_ADDR), 500);
    });
    setTimeout(() => {
      socket.close();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

const controlCache = new Map();

// URL управления AVTransport колонки
export async function getAvTransportUrl(host, descriptionUrl) {
  const cacheKey = `${host}|${descriptionUrl || ''}`;
  if (controlCache.has(cacheKey)) return controlCache.get(cacheKey);

  let location = descriptionUrl;
  if (!location) {
    const devices = await ssdpSearch();
    location = devices.find((d) => d.address === host)?.location;
    if (!location) throw new Error(`UPnP-рендерер колонки ${host} не найден через SSDP`);
  }

  const res = await fetch(location, { signal: AbortSignal.timeout(5000) });
  const xml = await res.text();
  const service = tagBlocks(xml, 'service').find((s) => tagText(s, 'serviceType') === AVT);
  if (!service) throw new Error(`В ${location} нет сервиса AVTransport`);

  const base = tagText(xml, 'URLBase') || location;
  const url = new URL(tagText(service, 'controlURL'), base).href;
  controlCache.set(cacheKey, url);
  return url;
}

export function clearUpnpCache() {
  controlCache.clear();
}

async function soap(controlUrl, action, args) {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${AVT}">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
      .join('') +
    `</u:${action}></s:Body></s:Envelope>`;

  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${AVT}#${action}"` },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = tagText(text, 'errorCode');
    const desc = tagText(text, 'errorDescription');
    throw new Error(`UPnP ${action}: HTTP ${res.status} ${code} ${desc}`.trim());
  }
  return text;
}

function didl({ title, url, art, mime = 'audio/mpeg' }) {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="1" parentID="0" restricted="1">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>' +
    (art ? `<upnp:albumArtURI>${escapeXml(art)}</upnp:albumArtURI>` : '') +
    `<res protocolInfo="http-get:*:${mime}:*">${escapeXml(url)}</res>` +
    '</item></DIDL-Lite>'
  );
}

// Воспроизвести HTTP-поток на колонке. url должен быть http:// (не https!)
export async function playUrl(host, { url, title, art, descriptionUrl }) {
  const controlUrl = await getAvTransportUrl(host, descriptionUrl);
  await soap(controlUrl, 'SetAVTransportURI', {
    InstanceID: 0,
    CurrentURI: url,
    CurrentURIMetaData: didl({ title, url, art }),
  });
  await soap(controlUrl, 'Play', { InstanceID: 0, Speed: 1 });
}

export async function stop(host, descriptionUrl) {
  const controlUrl = await getAvTransportUrl(host, descriptionUrl);
  await soap(controlUrl, 'Stop', { InstanceID: 0 });
}
