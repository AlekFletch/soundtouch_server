#!/data/data/com.termux/files/usr/bin/bash
# Кнопка «AfterTouch» для Termux:Widget. Копия лежит на планшете в ~/.shortcuts/
# и в ~/.shortcuts/tasks/ (вариант из tasks/ не открывает окно терминала).
# Запускает сервер, если он ещё не работает; второй тап ничего не ломает.
LOG="$HOME/aftertouch/widget.log"
mkdir -p "$HOME/aftertouch"

if pgrep -f soundtouch-service-v0 >/dev/null; then
  echo "$(date '+%F %T') уже запущен" >> "$LOG"
  echo "AfterTouch уже работает: http://$(cat "$HOME/aftertouch/server-ip" 2>/dev/null):8000"
  exit 0
fi

termux-wake-lock
pgrep -x sshd >/dev/null || sshd
echo "$(date '+%F %T') запуск по кнопке" >> "$LOG"
cd "$HOME/aftertouch" && nohup setsid ./start.sh >> service.log 2>&1 < /dev/null &

sleep 6
if pgrep -f soundtouch-service-v0 >/dev/null; then
  echo "AfterTouch запущен: http://$(cat "$HOME/aftertouch/server-ip" 2>/dev/null):8000"
else
  echo "не удалось запустить — смотри ~/aftertouch/service.log"
fi
