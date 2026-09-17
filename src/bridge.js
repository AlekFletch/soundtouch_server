// Мост одной колонки: слушает её WebSocket и сообщает о нажатиях кнопок 1–6 и изменении пресетов
import { EventEmitter } from 'node:events';
import { tagAttr, tagBlocks } from './xml.js';

const WS_PORT = Number(process.env.SOUNDTOUCH_WS_PORT) || 8080;
const WS_PROTOCOL = 'gabbo';
const RECONNECT_MIN = 2000;
const RECONNECT_MAX = 60000;
const DEBOUNCE_MS = 1000;

export class Bridge extends EventEmitter {
  #ws = null;
  #target = null; // { host, wsPort, label }
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

  // target: { host, wsPort?, label? }
  start(target) {
    this.stop();
    this.#target = target?.host ? target : null;
    if (this.#target) this.#connect();
  }

  stop() {
    clearTimeout(this.#retryTimer);
    this.#target = null;
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
    const { host, wsPort = WS_PORT } = this.#target;
    const label = this.#label();
    let ws;
    try {
      ws = new WebSocket(`ws://${host}:${wsPort}`, WS_PROTOCOL);
    } catch (err) {
      this.log(`[${label}] не удалось открыть WebSocket: ${err.message}`);
      return this.#scheduleReconnect();
    }
    this.#ws = ws;

    ws.onopen = () => {
      this.log(`[${label}] подключено к ${host}`);
      this.#retryDelay = RECONNECT_MIN;
      this.#setConnected(true);
    };
    ws.onmessage = (event) => this.#handleMessage(String(event.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#setConnected(false);
      this.log(`[${label}] соединение с ${host} потеряно, повтор через ${this.#retryDelay / 1000} с`);
      this.#scheduleReconnect();
    };
  }

  #label() {
    return this.#target?.label || this.#target?.host || 'bridge';
  }

  #scheduleReconnect() {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => this.#target && this.#connect(), this.#retryDelay);
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
      Promise.resolve(this.onPresetsUpdated?.(presets)).catch((err) => this.log(`[${this.#label()}] пресеты: ${err.message}`));
    }
  }

  #handlePreset(id) {
    const now = Date.now();
    if (this.#lastPress.id === id && now - this.#lastPress.at < DEBOUNCE_MS) return;
    this.#lastPress = { id, at: now };
    this.log(`[${this.#label()}] нажата кнопка ${id}`);
    Promise.resolve(this.onPreset(id)).catch((err) => this.log(`[${this.#label()}] кнопка ${id}: ${err.message}`));
  }
}
