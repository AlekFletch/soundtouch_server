#!/usr/bin/env bash
# Копирует станции на кнопках 1-6 с одной колонки на другую.
#
#   bash scripts/copy-presets.sh                         # сам найдёт колонки и спросит
#   bash scripts/copy-presets.sh <IP образца> <IP получателя>
#
# Без адресов скрипт ищет колонки во всех сетях компьютера, берёт за образец
# колонку, где станций больше, и перед записью спрашивает подтверждение.
# Работает напрямую с колонками по их API (порт 8090), планшет не нужен.
# Перед записью копия пресетов получателя ложится в data/backup/.
# Повторный запуск безвреден.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$REPO_DIR/data/backup"
STAMP="$(date '+%Y-%m-%d-%H%M%S')"

name_of() { curl -s -m 5 "http://$1:8090/info" | grep -o '<name>[^<]*' | sed 's/<name>//'; }

# один пресет на строку: <preset id="N" ...>...</preset>
preset_lines() { sed 's/<preset /\n<preset /g; s#</presets>#\n#' | grep '^<preset id="[1-6]"'; }

translit() { # кириллица -> латиница: SoundTouch 10 портит UTF-8 в названиях кнопок
  local args=() pair
  for pair in а:a б:b в:v г:g д:d е:e ё:e ж:zh з:z и:i й:y к:k л:l м:m н:n о:o п:p р:r с:s т:t у:u ф:f \
              х:kh ц:ts ч:ch ш:sh щ:shch ъ: ы:y ь: э:e ю:yu я:ya \
              А:A Б:B В:V Г:G Д:D Е:E Ё:E Ж:Zh З:Z И:I Й:Y К:K Л:L М:M Н:N О:O П:P Р:R С:S Т:T У:U Ф:F \
              Х:Kh Ц:Ts Ч:Ch Ш:Sh Щ:Shch Ъ: Ы:Y Ь: Э:E Ю:Yu Я:Ya; do
    args+=(-e "s/${pair%%:*}/${pair#*:}/g")
  done
  sed "${args[@]}"
}

titles() { # "N название" для каждой занятой кнопки
  curl -s -m 8 "http://$1:8090/presets" | preset_lines \
    | sed -E 's/^<preset id="([1-6])".*<itemName>([^<]*).*/\1 \2/'
}

count_presets() { titles "$1" | grep -c . ; }

key() { # нажать и отпустить кнопку колонки: key <IP> <кнопка>
  local k
  for k in press release; do
    curl -s -m 5 -X POST -H 'Content-Type: application/xml' \
      --data-raw "<key state=\"$k\" sender=\"Gabbo\">$2</key>" "http://$1:8090/key" >/dev/null
  done
}

local_prefixes() { # подсети сетевых адаптеров компьютера (только домашние диапазоны)
  ipconfig 2>/dev/null | tr -d '\r' \
    | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' \
    | grep -E '^(192\.168|10|172\.(1[6-9]|2[0-9]|3[01]))\.' \
    | sed -E 's/\.[0-9]+$//' | sort -u
}

find_speakers() { # IP всех колонок SoundTouch в сетях компьютера
  local prefix i
  for prefix in $(local_prefixes); do
    for i in $(seq 1 254); do
      ( curl -s -m 2 "http://$prefix.$i:8090/info" 2>/dev/null | grep -q '<info ' \
          && echo "$prefix.$i" ) &
    done
    wait
  done | sort -t. -k4 -n
}

FROM="${1:-}"; TO="${2:-}"

if [ -z "$FROM" ] || [ -z "$TO" ]; then
  echo "Ищу колонки в сети (до минуты)..."
  mapfile -t SPEAKERS < <(find_speakers)
  if [ "${#SPEAKERS[@]}" -lt 2 ]; then
    echo
    echo "Нашлось колонок: ${#SPEAKERS[@]}, а нужно две."
    echo "Проверьте, что обе колонки включены и компьютер подключён к той же сети (Wi-Fi или хотспот)."
    [ "${#SPEAKERS[@]}" = 1 ] && echo "Нашлась только: ${SPEAKERS[0]} ($(name_of "${SPEAKERS[0]}"))"
    exit 1
  fi

  echo
  echo "Найдены колонки:"
  best=""; best_n=-1
  for n in "${!SPEAKERS[@]}"; do
    ip="${SPEAKERS[$n]}"; c=$(count_presets "$ip")
    printf '  %d) %-16s %-28s станций на кнопках: %s\n' "$((n + 1))" "$ip" "$(name_of "$ip")" "$c"
    [ "$c" -gt "$best_n" ] && { best="$ip"; best_n="$c"; }
  done

  if [ "$best_n" -le 0 ]; then
    echo; echo "Ни на одной колонке нет станций на кнопках — копировать нечего."
    exit 1
  fi

  FROM="$best"
  if [ "${#SPEAKERS[@]}" = 2 ]; then
    for ip in "${SPEAKERS[@]}"; do [ "$ip" != "$FROM" ] && TO="$ip"; done
  else
    echo
    printf 'Номер колонки, НА которую копировать: '
    read -r num || exit 1
    TO="${SPEAKERS[$((num - 1))]:-}"
    [ -z "$TO" ] || [ "$TO" = "$FROM" ] && { echo "Неверный номер."; exit 1; }
  fi

  echo
  echo "Станции с «$(name_of "$FROM")» ($FROM):"
  titles "$FROM" | sed 's/^/  кнопка /'
  echo
  printf 'Записать их на «%s» (%s)? Enter — да, n — отмена: ' "$(name_of "$TO")" "$TO"
  read -r answer || { echo; echo "Отменено."; exit 1; }
  case "$answer" in n|N|н|Н|no|нет) echo "Отменено, ничего не менял."; exit 0 ;; esac
  echo
fi

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

# Если получатель играет, запись в играющий слот молча не применяется — выключаем его.
if ! curl -s -m 5 "http://$TO:8090/now_playing" | grep -q 'source="STANDBY"'; then
  echo "Выключаю получателя на время записи..."
  key "$TO" POWER; sleep 4
fi

echo
write_slots() { # write_slots [latin] — записать все кнопки; latin: названия латиницей
  local mode="${1:-}" line slot item title shown code
  while IFS= read -r line; do
    slot=$(printf '%s' "$line" | grep -o '^<preset id="[1-6]"' | grep -o '[1-6]')
    item=$(printf '%s' "$line" | grep -o '<ContentItem.*</ContentItem>')
    title=$(printf '%s' "$line" | grep -o '<itemName>[^<]*' | sed 's/<itemName>//')
    shown="$title"
    if [ "$mode" = latin ]; then
      shown=$(printf '%s' "$title" | translit)
      item=$(printf '%s' "$item" | sed "s#<itemName>[^<]*</itemName>#<itemName>$shown</itemName>#")
    fi
    code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/xml' \
      --data-raw "<preset id=\"$slot\">$item</preset>" "http://$TO:8090/storePreset")
    printf '  кнопка %s: %-25s %s\n' "$slot" "$shown" "$([ "$code" = 200 ] && echo записана || echo "ОШИБКА (http $code)")"
  done <<< "$src"
}

# SoundTouch 10 хранит русские названия в cp1251 и отдаёт список не в UTF-8:
# плеер сервера такой список не читает и показывает пустые кнопки.
valid_utf8() { curl -s -m 8 "http://$1:8090/presets" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; }

write_slots
sleep 2
if ! valid_utf8 "$TO"; then
  echo
  echo "Колонка «$to_name» отдаёт русские названия не в UTF-8 — плеер сервера покажет пустые кнопки."
  echo "Записываю названия латиницей (ссылки на станции те же):"
  write_slots latin
  sleep 2
  valid_utf8 "$TO" || echo "Внимание: список кнопок всё ещё не читается как UTF-8."
fi

# Сверка по ссылкам: названия сравнивать нельзя, SoundTouch 10 хранит кириллицу
# в другой кодировке (cp1251), хотя станция та же.
locs() {
  curl -s -m 8 "http://$1:8090/presets" | preset_lines \
    | sed -E 's/^<preset id="([1-6])".*location="([^"]*)".*/\1 \2/'
}
sleep 2
if [ "$(locs "$FROM")" = "$(locs "$TO")" ]; then
  echo; echo "Готово: кнопки на «$to_name» совпадают с «$from_name»."
else
  echo; echo "Внимание: кнопки совпали не полностью. Сейчас на «$to_name»:"
  titles "$TO" | sed 's/^/  /'
  echo "Запустите скрипт ещё раз — повторный запуск безопасен."
  exit 1
fi
