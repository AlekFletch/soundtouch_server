#!/data/data/com.termux/files/usr/bin/bash
# Автозапуск SoundTouch Bridge при загрузке планшета (Termux:Boot).
# setup.sh копирует этот файл в ~/.termux/boot/ и подставляет путь к проекту.

# Не даём Android усыпить Termux
termux-wake-lock

cd "__REPO_DIR__" || exit 1

# Перезапуск, если процесс упал
while true; do
  echo "$(date '+%F %T') запуск моста" >> ~/soundtouch-bridge.log
  node src/server.js >> ~/soundtouch-bridge.log 2>&1
  echo "$(date '+%F %T') мост остановился, перезапуск через 5 с" >> ~/soundtouch-bridge.log
  sleep 5
done &
