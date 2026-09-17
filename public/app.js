// Веб-форма SoundTouch Bridge
const $ = (sel) => document.querySelector(sel);

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(text, isError = false) {
  const el = $('#toast');
  el.textContent = text;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

async function run(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Колонка ----------

let config = null;

async function loadConfig() {
  config = await api('/api/config');
  $('#speaker-host').value = config.speakerHost || '';
  renderSlots();
}

async function refreshStatus() {
  try {
    const s = await api('/api/status');
    const el = $('#status');
    if (!s.speakerHost) {
      el.textContent = 'Укажите IP колонки';
      el.className = 'status warn';
    } else if (!s.online) {
      el.textContent = `Колонка ${s.speakerHost} недоступна`;
      el.className = 'status bad';
    } else {
      el.textContent = `${s.name} · ${s.bridgeConnected ? 'кнопки активны' : 'нет связи с кнопками'}`;
      el.className = 'status ' + (s.bridgeConnected ? 'ok' : 'warn');
    }
    const np = s.nowPlaying;
    $('#now-playing').textContent = np
      ? np.source === 'STANDBY' ? 'Колонка в режиме ожидания' : `Сейчас: ${[np.station, np.artist, np.track].filter(Boolean).join(' — ') || np.source} (${np.playStatus || np.source})`
      : '';
    if (typeof s.volume === 'number' && document.activeElement !== $('#volume')) {
      $('#volume').value = s.volume;
      $('#volume-value').textContent = s.volume;
    }
  } catch {
    $('#status').textContent = 'Мост недоступен';
    $('#status').className = 'status bad';
  }
}

$('#save-host').onclick = (e) => run(e.target, async () => {
  config = await api('/api/config', { speakerHost: $('#speaker-host').value.trim() });
  toast('IP колонки сохранён');
  refreshStatus();
});

$('#discover').onclick = (e) => run(e.target, async () => {
  $('#discover-result').textContent = 'Ищу колонки в сети…';
  const { speakers } = await api('/api/discover');
  if (!speakers.length) {
    $('#discover-result').textContent = 'Колонки не найдены. Укажите IP вручную (его видно в списке устройств роутера).';
    return;
  }
  $('#discover-result').innerHTML = 'Найдено: ' + speakers
    .map((s) => `<a href="#" data-host="${escapeHtml(s.host)}">${escapeHtml(s.name)} (${escapeHtml(s.host)})</a>`)
    .join(', ');
});

$('#discover-result').onclick = (e) => {
  const host = e.target.dataset?.host;
  if (host) {
    e.preventDefault();
    $('#speaker-host').value = host;
    $('#save-host').click();
  }
};

document.querySelectorAll('[data-key]').forEach((btn) => {
  btn.onclick = () => run(btn, async () => {
    await api('/api/key', { key: btn.dataset.key });
    setTimeout(refreshStatus, 800);
  });
});

$('#volume').oninput = (e) => ($('#volume-value').textContent = e.target.value);
$('#volume').onchange = (e) => run(null, () => api('/api/volume', { volume: Number(e.target.value) }));

// ---------- Кнопки 1–6 ----------

function renderSlots() {
  const html = [];
  for (let n = 1; n <= 6; n++) {
    const s = config.slots[n];
    html.push(`
      <div class="slot">
        <div class="slot-num">${n}</div>
        ${s?.favicon ? `<img class="slot-logo" src="${escapeHtml(s.favicon)}" alt="" onerror="this.style.visibility='hidden'">` : '<div class="slot-logo"></div>'}
        <div class="slot-body">
          <div class="slot-name">${s ? escapeHtml(s.name) : '<span class="hint">не настроена</span>'}</div>
          ${s ? `<div class="slot-url">${escapeHtml(s.url)}</div>` : ''}
          <div class="slot-actions">
            <button data-edit="${n}">${s ? 'Изменить' : 'Настроить'}</button>
            ${s ? `<button class="secondary" data-play="${n}">▶</button>` : ''}
          </div>
        </div>
      </div>`);
  }
  $('#slots').innerHTML = html.join('');
}

$('#slots').onclick = (e) => {
  const edit = e.target.dataset.edit;
  const play = e.target.dataset.play;
  if (edit) openPicker(Number(edit));
  if (play) run(e.target, async () => {
    await api('/api/slot/play', { slot: Number(play) });
    toast('Включаю…');
    setTimeout(refreshStatus, 2000);
  });
};

// ---------- Выбор станции ----------

let pickerSlot = 0;
let chosen = null;
let tab = 'search';

function setTab(name) {
  tab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== name));
  updateSelected();
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));

function currentStation() {
  if (tab === 'manual') {
    const url = $('#manual-url').value.trim();
    return url ? { name: $('#manual-name').value.trim() || 'Радио', url, favicon: $('#manual-logo').value.trim() } : null;
  }
  return chosen;
}

function updateSelected() {
  const s = currentStation();
  $('#selected').textContent = s ? `Выбрано: ${s.name} — ${s.url}` : 'Станция не выбрана';
}
['#manual-name', '#manual-url', '#manual-logo'].forEach((id) => ($(id).oninput = updateSelected));

function openPicker(n) {
  pickerSlot = n;
  const s = config.slots[n];
  chosen = s;
  $('#picker-title').textContent = `Кнопка ${n}`;
  $('#manual-name').value = s?.name || '';
  $('#manual-url').value = s?.url || '';
  $('#manual-logo').value = s?.favicon || '';
  $('#picker-clear').hidden = !s;
  setTab('search');
  $('#picker').showModal();
  $('#search-q').focus();
}

let results = [];
async function doSearch() {
  const q = $('#search-q').value.trim();
  if (q.length < 2) return toast('Введите хотя бы 2 символа', true);
  await run($('#search-go'), async () => {
    $('#search-results').innerHTML = '<li class="hint">Ищу…</li>';
    const country = $('#search-country').value;
    results = await api(`/api/search?q=${encodeURIComponent(q)}&country=${country}`);
    $('#search-results').innerHTML = results.length
      ? results.map((r, i) => `
          <li data-i="${i}">
            <img src="${escapeHtml(r.favicon)}" alt="" onerror="this.style.visibility='hidden'">
            <div><div>${escapeHtml(r.name)}</div>
            <div class="meta">${escapeHtml([r.country, r.codec, r.bitrate ? r.bitrate + ' kbps' : '', r.tags.split(',').slice(0, 3).join(', ')].filter(Boolean).join(' · '))}</div></div>
          </li>`).join('')
      : '<li class="hint">Ничего не найдено</li>';
  });
}
$('#search-go').onclick = doSearch;
// Enter в поле поиска: неявная отправка формы диалога → ищем, диалог не закрываем
$('#picker form').addEventListener('submit', (e) => {
  if (e.submitter) return;
  e.preventDefault();
  if (document.activeElement === $('#search-q')) doSearch();
});
$('#search-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.keyCode === 13) {
    e.preventDefault();
    doSearch();
  }
});
$('#search-results').onclick = (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  chosen = results[Number(li.dataset.i)];
  document.querySelectorAll('#search-results li').forEach((x) => x.classList.toggle('active', x === li));
  updateSelected();
};

$('#picker-listen').onclick = (e) => run(e.target, async () => {
  const s = currentStation();
  if (!s) throw new Error('Сначала выберите станцию');
  await api('/api/play', s);
  toast('Включаю на колонке…');
  setTimeout(refreshStatus, 2000);
});

$('#picker-save').onclick = (e) => run(e.target, async () => {
  const s = currentStation();
  if (!s) throw new Error('Сначала выберите станцию');
  const r = await api('/api/slot', { slot: pickerSlot, ...s });
  config.slots[pickerSlot] = r.station;
  renderSlots();
  $('#picker').close();
  if (r.warning) toast(r.warning, true);
  else toast(`«${r.station.name}» сохранена на кнопку ${pickerSlot}`);
});

$('#picker-clear').onclick = (e) => run(e.target, async () => {
  await api('/api/slot', { slot: pickerSlot, url: '' });
  config.slots[pickerSlot] = null;
  renderSlots();
  $('#picker').close();
  toast(`Кнопка ${pickerSlot} очищена`);
});

// ---------- Старт ----------

await loadConfig().catch((err) => toast(err.message, true));
refreshStatus();
setInterval(refreshStatus, 10000);
