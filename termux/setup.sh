#!/data/data/com.termux/files/usr/bin/bash
# Установка SoundTouch Bridge на Android-планшет (Termux).
# Запуск в Termux:  bash termux/setup.sh
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Обновляю пакеты и ставлю Node.js"
pkg update -y
pkg install -y nodejs-lts git termux-api 2>/dev/null || pkg install -y nodejs git

node --version

echo "==> Настраиваю автозапуск (нужно приложение Termux:Boot из F-Droid)"
mkdir -p ~/.termux/boot
sed "s#__REPO_DIR__#${REPO_DIR}#g" "$REPO_DIR/termux/boot/start-bridge.sh" > ~/.termux/boot/start-bridge.sh
chmod +x ~/.termux/boot/start-bridge.sh

echo
echo "Готово. Запустить сейчас:  ~/.termux/boot/start-bridge.sh"
echo "Лог:                       tail -f ~/soundtouch-bridge.log"
echo "Форма настройки:           http://<IP планшета>:8000"
