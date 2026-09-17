// Поиск станций в открытом каталоге https://www.radio-browser.info
// all.api — DNS-балансировщик на все живые зеркала (актуальный список: /json/servers)
const MIRRORS = ['de1.api.radio-browser.info', 'all.api.radio-browser.info'];
const USER_AGENT = 'SoundTouchBridge/0.1';

export async function searchStations(query, { limit = 30, countrycode = '' } = {}) {
  const params = new URLSearchParams({
    name: query,
    limit: String(limit * 2),
    hidebroken: 'true',
    order: 'clickcount',
    reverse: 'true',
  });
  if (countrycode) params.set('countrycode', countrycode);

  let lastError;
  for (const mirror of MIRRORS) {
    try {
      const res = await fetch(`https://${mirror}/json/stations/search?${params}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      return list
        .filter((s) => !s.hls && (s.url_resolved || s.url))
        .slice(0, limit)
        .map((s) => ({
          name: s.name.trim(),
          url: s.url_resolved || s.url,
          favicon: s.favicon || '',
          country: s.countrycode || s.country || '',
          codec: s.codec || '',
          bitrate: s.bitrate || 0,
          tags: s.tags || '',
        }));
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Каталог Radio-Browser недоступен: ${lastError?.message}`);
}
