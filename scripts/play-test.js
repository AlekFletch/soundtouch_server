// Тест воспроизведения (шаг 2 плана): запускает поток на колонке через UPnP.
// Запуск:  node scripts/play-test.js <IP колонки> [http-ссылка на поток]
// Для https-потоков используйте веб-форму — там работает прокси.
import * as upnp from '../src/upnp.js';

const [host, url = 'http://icecast.omroep.nl/radio1-bb-mp3'] = process.argv.slice(2);
if (!host) {
  console.log('Использование: node scripts/play-test.js <IP колонки> [http-ссылка]');
  process.exit(1);
}
if (!url.startsWith('http://')) {
  console.log('Колонка играет только http:// — для https запустите сервер (npm start)');
  process.exit(1);
}
try {
  console.log('controlURL:', await upnp.getAvTransportUrl(host));
  await upnp.playUrl(host, { url, title: 'Тест SoundTouch Bridge' });
  console.log('Команда Play отправлена — колонка должна заиграть:', url);
} catch (err) {
  console.error('Ошибка:', err.message);
  process.exit(1);
}
