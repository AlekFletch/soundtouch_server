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

// Выбранная колонка запоминается в браузере
const remember = {
  get: () => { try { return localStorage.getItem('speaker') || ''; } catch { return ''; } },
  set: (id) => { try { localStorage.setItem('speaker', id); } catch {} },
};

let config = { speakers: [] };
let statuses = {}; // id → статус из /api/status
let currentId = remember.get();

const current = () => config.speakers.find((s) => s.id === currentId) || null;
const speakerLabel = (sp) => sp.name || statuses[sp.id]?.name || sp.host;

// ---------- загрузка и отрисовка ----------

async function loadConfig() {
  config = await api('/api/config');
  if (!current()) currentId = config.speakers[0]?.id || '';
  render();
}

function select(id) {
  currentId = id;
  remember.set(id);
  render();
  refreshStatus();
}

function dotClass(st) {
  if (!st) return '';
  if (!st.online) return 'bad';
  return st.bridgeConnected ? 'ok' : 'warn';
}

function render() {
  const sp = current();

  $('#speaker-tabs').innerHTML = config.speakers
    .map((s) => `<button class="speaker-tab${s.id === currentId ? ' active' : ''}" data-speaker="${s.id}" role="tab">
      <span class="dot ${dotClass(statuses[s.id])}"></span>${escapeHtml(speakerLabel(s))}</button>`)
    .join('');

  $('#add-speaker').open = config.speakers.length === 0 || $('#add-speaker').open;
  $('#speaker-detail').hidden = !sp;
  $('#slots-panel').hidden = !sp;
  if (!sp) return;

  $('#sp-name').textContent = speakerLabel(sp);
  $('#slots-title').textContent = `— ${speakerLabel(sp)}`;
  if (document.activeElement !== $('#sp-host')) $('#sp-host').value = sp.host;
  if (document.activeElement !== $('#sp-label')) $('#sp-label').value = sp.name || '';

  renderCopy();
  renderStatus();
  renderSlots(sp);
}

function renderCopy() {
  const others = config.speakers.filter((s) => s.id !== currentId);
  const selected = $('#copy-from').value;
  $('#copy-row').hidden = others.length === 0;
  $('#copy-from').innerHTML = others.map((s) => `<option value="${s.id}">с колонки «${escapeHtml(speakerLabel(s))}»</option>`).join('');
  if (others.some((s) => s.id === selected)) $('#copy-from').value = selected;
}

function renderStatus() {
  const sp = current();
  if (!sp) return;
  const st = statuses[sp.id];
  const el = $('#sp-status');
  $('#sp-meta').textContent = [st?.type, sp.host].filter(Boolean).join(' · ');
  if (!st) {
    el.textContent = 'Проверяю…';
    el.className = 'status';
  } else if (!st.online) {
    el.textContent = 'Недоступна';
    el.title = st.error || '';
    el.className = 'status bad';
  } else {
    el.textContent = st.bridgeConnected ? 'Кнопки активны' : 'Нет связи с кнопками';
    el.title = '';
    el.className = 'status ' + (st.bridgeConnected ? 'ok' : 'warn');
  }
  const np = st?.nowPlaying;
  $('#now-playing').textContent = !np
    ? ''
    : np.source === 'STANDBY'
      ? 'Колонка в режиме ожидания'
      : `Сейчас: ${[np.station, np.artist, np.track].filter((v, i, a) => v && a.indexOf(v) === i).join(' — ') || np.source} (${np.playStatus || np.source})`;
  if (typeof st?.volume === 'number' && document.activeElement !== $('#volume')) {
    $('#volume').value = st.volume;
    $('#volume-value').textContent = st.volume;
  }
}

async function refreshStatus() {
  try {
    const list = await api('/api/status');
    statuses = Object.fromEntries(list.map((s) => [s.id, s]));
    // точки в вкладках и названия
    document.querySelectorAll('.speaker-tab').forEach((tab) => {
      const s = config.speakers.find((x) => x.id === tab.dataset.speaker);
      if (s) tab.innerHTML = `<span class="dot ${dotClass(statuses[s.id])}"></span>${escapeHtml(speakerLabel(s))}`;
    });
    const sp = current();
    if (sp) {
      $('#sp-name').textContent = speakerLabel(sp);
      $('#slots-title').textContent = `— ${speakerLabel(sp)}`;
      if (document.activeElement !== $('#copy-from')) renderCopy();
    }
    renderStatus();
  } catch {
    $('#sp-status').textContent = 'Мост недоступен';
    $('#sp-status').className = 'status bad';
  }
}

// ---------- колонки ----------

$('#speaker-tabs').onclick = (e) => {
  const tab = e.target.closest('[data-speaker]');
  if (tab) select(tab.dataset.speaker);
};

async function addSpeaker(host) {
  const sp = await api('/api/speakers', { host });
  await loadConfig();
  $('#new-host').value = '';
  $('#add-speaker').open = false;
  select(sp.id);
  toast(`Колонка «${speakerLabel(sp)}» добавлена`);
}

$('#add-host').onclick = (e) => run(e.target, () => addSpeaker($('#new-host').value.trim()));

$('#discover').onclick = (e) => run(e.target, async () => {
  $('#discover-result').textContent = 'Ищу колонки в сети…';
  const { speakers } = await api('/api/discover');
  if (!speakers.length) {
    $('#discover-result').textContent = 'Колонки не найдены. Укажите IP вручную (его видно в списке устройств роутера).';
    return;
  }
  $('#discover-result').innerHTML = 'Найдено: ' + speakers
    .map((s) => s.added
      ? `${escapeHtml(s.name)} (${escapeHtml(s.host)}) — уже добавлена`
      : `<a href="#" data-host="${escapeHtml(s.host)}">${escapeHtml(s.name)} (${escapeHtml(s.host)}) — добавить</a>`)
    .join(', ');
});

$('#discover-result').onclick = (e) => {
  const host = e.target.dataset?.host;
  if (host) {
    e.preventDefault();
    run(null, () => addSpeaker(host));
  }
};

$('#sp-save').onclick = (e) => run(e.target, async () => {
  await api('/api/speakers/update', { id: currentId, host: $('#sp-host').value.trim(), name: $('#sp-label').value.trim() });
  await loadConfig();
  refreshStatus();
  toast('Сохранено');
});

$('#sp-remove').onclick = (e) => {
  const sp = current();
  if (!sp || !confirm(`Удалить колонку «${speakerLabel(sp)}» и её станции из моста?`)) return;
  run(e.target, async () => {
    await api('/api/speakers/remove', { id: sp.id });
    currentId = '';
    await loadConfig();
    toast('Колонка удалена');
  });
};

document.querySelectorAll('[data-key]').forEach((btn) => {
  btn.onclick = () => run(btn, async () => {
    await api('/api/key', { speaker: currentId, key: btn.dataset.key });
    setTimeout(refreshStatus, 800);
  });
});

$('#volume').oninput = (e) => ($('#volume-value').textContent = e.target.value);
$('#volume').onchange = (e) => run(null, () => api('/api/volume', { speaker: currentId, volume: Number(e.target.value) }));

$('#copy-go').onclick = (e) => {
  const from = config.speakers.find((s) => s.id === $('#copy-from').value);
  const to = current();
  if (!from || !to || !confirm(`Заменить все 6 кнопок колонки «${speakerLabel(to)}» станциями с «${speakerLabel(from)}»?`)) return;
  run(e.target, async () => {
    const r = await api('/api/slots/copy', { from: from.id, to: to.id });
    await loadConfig();
    if (r.warning) toast(r.warning, true);
    else toast('Станции скопированы');
  });
};

// ---------- кнопки 1–6 ----------

function renderSlots(sp) {
  const html = [];
  for (let n = 1; n <= 6; n++) {
    const s = sp.slots[n];
    html.push(`
      <div class="slot">
        <div class="slot-num">${n}</div>
        ${s?.favicon ? `<img class="slot-logo" src="${escapeHtml(s.favicon)}" alt="" onerror="this.style.visibility='hidden'">` : '<div class="slot-logo"></div>'}
        <div class="slot-body">
          <div class="slot-name">${s ? escapeHtml(s.name) : '<span class="hint">не настроена</span>'}</div>
          ${s ? `<div class="slot-url">${escapeHtml(s.url)}</div>` : ''}
          <div class="slot-actions">
            <button data-edit="${n}">${s ? 'Изменить' : 'Настроить'}</button>
            ${s ? `<button class="secondary" data-play="${n}" title="Включить на колонке">▶</button>` : ''}
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
    await api('/api/slot/play', { speaker: currentId, slot: Number(play) });
    toast('Включаю…');
    setTimeout(refreshStatus, 2000);
  });
};

// ---------- выбор станции ----------

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
  const sp = current();
  pickerSlot = n;
  const s = sp.slots[n];
  chosen = s;
  $('#picker-title').textContent = `${speakerLabel(sp)} · кнопка ${n}`;
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
$('#new-host').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#add-host').click();
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
  await api('/api/play', { speaker: currentId, ...s });
  toast('Включаю на колонке…');
  setTimeout(refreshStatus, 2000);
});

$('#picker-save').onclick = (e) => run(e.target, async () => {
  const s = currentStation();
  if (!s) throw new Error('Сначала выберите станцию');
  const r = await api('/api/slot', { speaker: currentId, slot: pickerSlot, ...s });
  current().slots[pickerSlot] = r.station;
  renderSlots(current());
  $('#picker').close();
  if (r.warning) toast(r.warning, true);
  else toast(`«${r.station.name}» сохранена на кнопку ${pickerSlot}`);
});

$('#picker-clear').onclick = (e) => run(e.target, async () => {
  await api('/api/slot', { speaker: currentId, slot: pickerSlot, url: '' });
  current().slots[pickerSlot] = null;
  renderSlots(current());
  $('#picker').close();
  toast(`Кнопка ${pickerSlot} очищена`);
});

// ---------- старт ----------

await loadConfig().catch((err) => toast(err.message, true));
refreshStatus();
setInterval(refreshStatus, 10000);
