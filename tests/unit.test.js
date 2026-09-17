import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeXml, unescapeXml, tagText, tagAttr, tagBlocks } from '../src/xml.js';
import { parsePlaylist } from '../src/proxy.js';

test('escapeXml / unescapeXml — обратимы', () => {
  const s = `Rock & Roll <"Радио"> 'x'`;
  assert.equal(unescapeXml(escapeXml(s)), s);
  assert.equal(escapeXml('a&b<c'), 'a&amp;b&lt;c');
});

test('tagText понимает префиксы пространств имён и атрибуты', () => {
  const xml = '<s:Body><u:X><errorCode attr="1">402</errorCode><dc:title>Маяк &amp; Ко</dc:title></u:X></s:Body>';
  assert.equal(tagText(xml, 'errorCode'), '402');
  assert.equal(tagText(xml, 'title'), 'Маяк & Ко');
  assert.equal(tagText(xml, 'missing'), '');
});

test('tagAttr и tagBlocks разбирают ответ /presets', () => {
  const xml =
    '<presets><preset id="1" createdOn="1"><ContentItem source="TUNEIN" location="/v1/playback/station/s1">' +
    '<itemName>Jazz</itemName></ContentItem></preset>' +
    '<preset id="2"><ContentItem source="UPNP" location="http://10.0.0.2:8000/stream/2?a=1&amp;b=2">' +
    '<itemName>Rock</itemName></ContentItem></preset></presets>';
  const blocks = tagBlocks(xml, 'preset');
  assert.equal(blocks.length, 2);
  assert.equal(tagAttr(blocks[0], 'preset', 'id'), '1');
  assert.equal(tagAttr(blocks[1], 'ContentItem', 'location'), 'http://10.0.0.2:8000/stream/2?a=1&b=2');
  assert.equal(tagText(blocks[1], 'itemName'), 'Rock');
});

test('tagBlocks не путает presets и preset', () => {
  const xml = '<presetsUpdated><presets><preset id="3"><ContentItem source="UPNP" /></preset></presets></presetsUpdated>';
  assert.equal(tagBlocks(xml, 'preset').length, 1);
  assert.equal(tagBlocks(xml, 'presets').length, 1);
});

test('parsePlaylist: PLS', () => {
  const pls = '[playlist]\nNumberOfEntries=2\nFile1=http://a.example/live\nTitle1=A\nFile2=http://b.example/live\n';
  assert.equal(parsePlaylist(pls, 'http://x/'), 'http://a.example/live');
});

test('parsePlaylist: M3U с комментариями и относительной ссылкой', () => {
  assert.equal(parsePlaylist('#EXTM3U\n#EXTINF:-1,Radio\nhttps://c.example/s.mp3\n', 'http://x/'), 'https://c.example/s.mp3');
  assert.equal(parsePlaylist('\r\n#EXTM3U\r\nstream.aac\r\n', 'http://host/dir/list.m3u'), 'http://host/dir/stream.aac');
});

test('parsePlaylist: HLS отвергается понятной ошибкой', () => {
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchunk.m3u8', 'http://x/'), /HLS/);
});

test('parsePlaylist: пустой плейлист', () => {
  assert.throws(() => parsePlaylist('[playlist]\nNumberOfEntries=0\n', 'http://x/'), /не найден/);
});

test('store: старый формат настроек (одна колонка) переносится в список колонок', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'stb-store-'));
  const file = join(dir, 'config.json');
  const station = { name: 'Old FM', url: 'http://old/stream', favicon: '' };
  writeFileSync(file, JSON.stringify({ speakerHost: '10.0.0.5', port: 8000, slots: { 2: station } }));
  const env = { ...process.env, CONFIG_FILE: file };
  for (const k of ['SPEAKER_HOST', 'SPEAKERS', 'UPNP_DESCRIPTION_URL', 'PORT']) delete env[k];
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "import('./src/store.js').then((s) => console.log(JSON.stringify(s.getConfig())))"], { env, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  const cfg = JSON.parse(out);
  assert.equal(cfg.speakerHost, undefined);
  assert.equal(cfg.speakers.length, 1);
  assert.equal(cfg.speakers[0].host, '10.0.0.5');
  assert.deepEqual(cfg.speakers[0].slots[2], station);
  assert.equal(cfg.speakers[0].slots[1], null);
});
