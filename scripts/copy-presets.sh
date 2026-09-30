#!/usr/bin/env bash
# Копирует станции на кнопках 1-6 с одной колонки на другую.
#
#   bash scripts/copy-presets.sh <IP колонки-образца> <IP колонки-получателя>
#
# Работает напрямую с колонками по их API (порт 8090), планшет не нужен.
# Перед записью копия пресетов получателя ложится в data/backup/.
# Повторный запуск безвреден.
set -uo pipefail

FROM="${1:-}"; TO="${2:-}"
if [ -z "$FROM" ] || [ -z "$TO" ]; then
  echo "Использование: bash scripts/copy-presets.sh <IP образца> <IP получателя>" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$REPO_DIR/data/backup"
STAMP="$(date '+%Y-%m-%d-%H%M%S')"

name_of() { curl -s -m 5 "http://$1:8090/info" | grep -o '<name>[^<]*' | sed 's/<name>//'; }

# один пресет на строку: <preset id="N" ...>...</preset>
preset_lines() { sed 's/<preset /\n<preset /g; s#</presets>#\n#' | grep '^<preset id="[1-6]"'; }

key() { # нажать и отпустить кнопку колонки
  local k
  for k in press release; do
    curl -s -m 5 -X POST -H 'Content-Type: application/xml' \
      --data-raw "<key state=\"$k\" sender=\"Gabbo\">$1</key>" "http://$TO:8090/key" >/dev/null
  done
}

from_name=$(name_of "$FROM"); to_name=$(name_of "$TO")
[ -z "$from_name" ] && { echo "Колонка $FROM не отвечает. Проверьте адрес и что она в той же сети." >&2; exit 1; }
[ -z "$to_name" ]   && { echo "Колонка $TO не отвечает. Проверьте адрес и что она в той же сети." >&2; exit 1; }
echo "Образец:    $FROM ($from_name)"
echo "Получатель: $TO ($to_name)"

src=$(curl -s -m 8 "http://$FROM:8090/presets" | preset_lines)
[ -z "$src" ] && { echo "На колонке-образце нет ни одной станции на кнопках — копировать нечего." >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
curl -s -m 8 "http://$TO:8090/presets" > "$BACKUP_DIR/presets-$TO-$STAMP.xml"
echo "Копия старых кнопок получателя: data/backup/presets-$TO-$STAMP.xml"

# Если получатель играет, запись в играющий слот молча не применяется — ставим на паузу-выключение.
if ! curl -s -m 5 "http://$TO:8090/now_playing" | grep -q 'source="STANDBY"'; then
  echo "Выключаю получателя на время записи..."
  key POWER; sleep 4
fi

echo
while IFS= read -r line; do
  slot=$(printf '%s' "$line" | grep -o '^<preset id="[1-6]"' | grep -o '[1-6]')
  item=$(printf '%s' "$line" | grep -o '<ContentItem.*</ContentItem>')
  title=$(printf '%s' "$line" | grep -o '<itemName>[^<]*' | sed 's/<itemName>//')
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/xml' \
    --data-raw "<preset id=\"$slot\">$item</preset>" "http://$TO:8090/storePreset")
  printf '  кнопка %s: %-25s %s\n' "$slot" "$title" "$([ "$code" = 200 ] && echo записана || echo "ОШИБКА (http $code)")"
done <<< "$src"

# Сверка: названия на кнопках обеих колонок должны совпасть.
sleep 2
titles() { curl -s -m 8 "http://$1:8090/presets" | preset_lines \
  | sed -E 's/^<preset id="([1-6])".*<itemName>([^<]*).*/\1 \2/'; }
if [ "$(titles "$FROM")" = "$(titles "$TO")" ]; then
  echo; echo "Готово: кнопки на «$to_name» совпадают с «$from_name»."
else
  echo; echo "Внимание: кнопки совпали не полностью. Сейчас на «$to_name»:"
  titles "$TO" | sed 's/^/  /'
  exit 1
fi
