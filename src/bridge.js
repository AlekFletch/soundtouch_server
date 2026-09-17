// Мост: слушает WebSocket колонки и по нажатию кнопки 1–6 включает станцию через UPnP
import { EventEmitter } from 'node:events';
import { tagAttr, tagBlocks } from './xml.js';

const WS_PORT = Number(process.env.SOUNDTOUCH_WS_PORT) || 8080;
const WS_PROTOCOL = 'gabbo';
const RECONNECT_MIN = 2000;
const RECONNECT_MAX = 60000;
const DEBOUNCE_MS = 1000;

export class Bridge extends EventEmitter {
  #ws = null;
  #host = '';
  #retryDelay = RECONNECT_MIN;
  #retryTimer = null;
  #lastPress = { id: 0, at: 0 };
  connected = false;
  lastMessages = [];

  // onPreset(id) — нажата кнопка пресета; onPresetsUpdated(presets) — колонка изменила список пресетов
  constructor({ onPreset, onPresetsUpdated, log = console.log }) {
    super();
    this.onPreset = onPreset;
    this.onPresetsUpdated = onPresetsUpdated;
    this.log = log;
  }

  start(host) {
    this.stop();
    this.#host = host;
    if (host) this.#connect();
  }

  stop() {
    clearTimeout(this.#retryTimer);
    this.#host = '';
    if (this.#ws) {
      this.#ws.onclose = null;
      this.#ws.close();
      this.#ws = null;
    }
    this.#setConnected(false);
  }

  #setConnected(value) {
    if (this.connected !== value) {
      this.connected = value;
      this.emit('status', value);
    }
  }

  #connect() {
    const host = this.#host;
    let ws;
    try {
      ws = new WebSocket(`ws://${host}:${WS_PORT}`, WS_PROTOCOL);
    } catch (err) {
      this.log(`[bridge] не удалось открыть WebSocket: ${err.message}`);
      return this.#scheduleReconnect();
    }
    this.#ws = ws;

    ws.onopen = () => {
      this.log(`[bridge] подключено к ${host}`);
      this.#retryDelay = RECONNECT_MIN;
      this.#setConnected(true);
    };
    ws.onmessage = (event) => this.#handleMessage(String(event.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#setConnected(false);
      this.log(`[bridge] соединение с ${host} потеряно, повтор через ${this.#retryDelay / 1000} с`);
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect() {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => this.#host && this.#connect(), this.#retryDelay);
    this.#retryDelay = Math.min(this.#retryDelay * 2, RECONNECT_MAX);
  }

  #handleMessage(xml) {
    this.lastMessages.push({ at: new Date().toISOString(), xml });
    if (this.lastMessages.length > 50) this.lastMessages.shift();
    this.emit('message', xml);

    // <updates deviceID="..."><nowSelectionUpdated><preset id="3">...</preset></nowSelectionUpdated></updates>
    for (const block of tagBlocks(xml, 'nowSelectionUpdated')) {
      const id = Number(tagAttr(block, 'preset', 'id'));
      if (id >= 1 && id <= 6) this.#handlePreset(id);
    }

    // Долгое нажатие кнопки сохраняет текущую станцию → колонка присылает новый список пресетов
    for (const block of tagBlocks(xml, 'presetsUpdated')) {
      const presets = tagBlocks(block, 'preset').map((p) => ({
        id: Number(tagAttr(p, 'preset', 'id')),
        source: tagAttr(p, 'ContentItem', 'source'),
        location: tagAttr(p, 'ContentItem', 'location'),
      }));
      Promise.resolve(this.onPresetsUpdated?.(presets)).catch((err) => this.log(`[bridge] пресеты: ${err.message}`));
    }
  }

  #handlePreset(id) {
    const now = Date.now();
    if (this.#lastPress.id === id && now - this.#lastPress.at < DEBOUNCE_MS) return;
    this.#lastPress = { id, at: now };
    this.log(`[bridge] нажата кнопка ${id}`);
    Promise.resolve(this.onPreset(id)).catch((err) => this.log(`[bridge] кнопка ${id}: ${err.message}`));
  }
}
