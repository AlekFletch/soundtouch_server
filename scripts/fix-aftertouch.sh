#!/usr/bin/env bash
# Перенастройка AfterTouch после смены IP, роутера или сети — одной командой.
#
#   bash scripts/fix-aftertouch.sh
#
# Скрипт сам находит планшет и колонки в текущей сети, приводит адреса
# в согласованное состояние и проверяет результат. Если всё уже в порядке,
# ничего не меняет. Повторный запуск безвреден.
#
# Чего скрипт НЕ делает: не задаёт планшету статический IP (только руками
# на самом устройстве) и не воскрешает станции с протухшими ссылками.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$REPO_DIR/data/backup"
CONF_FILE="$REPO_DIR/data/network.conf"           # сюда запоминаем введённые вручную адреса
STAMP="$(date '+%Y-%m-%d-%H%M%S')"

# Адреса, введённые в прошлый раз, имеют приоритет над заводскими умолчаниями.
SAVED_LAST_OCTET=""; SAVED_SPEAKER_OCTETS=""
# shellcheck disable=SC1090
[ -f "$CONF_FILE" ] && . "$CONF_FILE"

SSH_KEY="${SSH_KEY:-C:/Users/Konnov/.ssh/id_tablet}"
SSH_USER="${SSH_USER:-u0_a113}"
SSH_PORT="${SSH_PORT:-8022}"
SSH_ALIAS="${SSH_ALIAS:-[10.109.159.48]:8022}"   # под этим именем ключ лежит в known_hosts
KNOWN_HOSTS="${KNOWN_HOSTS:-C:/Users/Konnov/.ssh/known_hosts_tablet}"
LAST_OCTET="${LAST_OCTET:-${SAVED_LAST_OCTET:-161}}"            # обычно планшет на .161
SPEAKER_OCTETS="${SPEAKER_OCTETS:-${SAVED_SPEAKER_OCTETS:-11 179}}"  # где обычно живут колонки
CLI='./soundtouch-cli-v0.136.0-linux-arm64'

SERVER_IP=""
CHANGED=0
WARNINGS=()

say()  { printf '%s\n' "$*"; }
step() { printf '\n=== %s ===\n' "$*"; }
warn() { WARNINGS+=("$*"); printf '  ! %s\n' "$*"; }

ssh_t() { # выполнить команду на планшете
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile="$KNOWN_HOSTS" -o HostKeyAlias="$SSH_ALIAS" \
      -o ConnectTimeout=10 "$SSH_USER@$SERVER_IP" "$@"
}

cli() { # выполнить soundtouch-cli на планшете: cli <IP колонки> <аргументы...>
  local host="$1"; shift
  ssh_t "cd ~/aftertouch && termux-chroot $CLI --host $host $*" 2>&1
}

http_code() { curl -s -m "${2:-6}" -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }

# ---------------------------------------------------------------- шаг 1: сеть

local_prefixes() { # подсети всех сетевых адаптеров компьютера, без последнего октета
  ipconfig 2>/dev/null | tr -d '\r' \
    | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' \
    | grep -vE '^(255|0)\.' \
    | sed -E 's/\.[0-9]+$//' | sort -u
}

# Спрашивать адреса можно только когда есть кому отвечать.
# ASK=1 включает вопросы и без терминала — этим прогоняются проверки.
interactive() { [ -t 0 ] || [ "${ASK:-0}" = "1" ]; }

remember() { # запомнить введённые адреса, чтобы в следующий раз не спрашивать
  mkdir -p "$(dirname "$CONF_FILE")" 2>/dev/null
  {
    echo "# Адреса, введённые вручную при последней перенастройке ($STAMP)."
    echo "# Файл читается скриптом при запуске; удали его, чтобы вернуть умолчания."
    echo "SAVED_LAST_OCTET=\"$LAST_OCTET\""
    echo "SAVED_SPEAKER_OCTETS=\"$SPEAKER_OCTETS\""
  } > "$CONF_FILE" 2>/dev/null
}

probe_server() { # 0, если по адресу отвечает сервер или хотя бы SSH планшета
  local cand="$1"
  [ "$(http_code "http://$cand:8000/" 4)" = "200" ] && { SERVER_IP="$cand"; return 0; }
  SERVER_IP="$cand" ssh_t 'echo ok' >/dev/null 2>&1 && { SERVER_IP="$cand"; return 0; }
  SERVER_IP=""
  return 1
}

# Превращает ввод пользователя в список адресов-кандидатов.
# Принимает как последние цифры («161»), так и полный адрес («192.168.1.50»).
expand_input() {
  local raw="$1" prefix
  case "$raw" in
    *.*.*.*) printf '%s\n' "$raw" ;;
    *[!0-9]*|'') ;;                       # мусор — кандидатов нет
    *) for prefix in $(local_prefixes); do printf '%s.%s\n' "$prefix" "$raw"; done ;;
  esac
}

ask_server() { # спросить адрес планшета у пользователя
  local raw cand tries
  say ""
  say "  Планшет не найден автоматически."
  say "  Подсети этого компьютера: $(local_prefixes | sed 's/$/.x/' | tr '\n' ' ')"
  say "  Посмотри в настройках роутера, какой адрес у планшета, и введи его."
  say "  Можно только последние цифры (например 161) или адрес целиком"
  say "  (например 192.168.1.50). Пустая строка — выйти."

  for tries in 1 2 3; do
    printf '  Адрес планшета: '
    read -r raw || return 1
    [ -z "$raw" ] && return 1

    for cand in $(expand_input "$raw"); do
      printf '    пробую %s ... ' "$cand"
      if probe_server "$cand"; then
        say "есть"
        LAST_OCTET="${cand##*.}"
        remember
        return 0
      fi
      say "нет"
    done
    say "  По этому адресу планшет не отвечает. Проверь, что он включён и разблокирован."
  done
  return 1
}

find_server() {
  step "Шаг 1. Ищу сервер в текущей сети"
  local prefix cand

  if [ -z "$(local_prefixes)" ]; then
    warn "не удалось прочитать адреса сетевых адаптеров (ipconfig)"
  fi

  for prefix in $(local_prefixes); do
    cand="$prefix.$LAST_OCTET"
    printf '  пробую %s ... ' "$cand"
    if probe_server "$cand"; then
      say "отвечает"
      return 0
    fi
    say "нет"
  done

  interactive && ask_server && return 0

  SERVER_IP=""
  return 1
}

# --------------------------------------------------- шаг 2: служба на планшете

ensure_service() {
  step "Шаг 2. Проверяю службу на планшете"
  if [ "$(http_code "http://$SERVER_IP:8000/" 6)" = "200" ]; then
    say "  служба работает: http://$SERVER_IP:8000"
    return 0
  fi

  if ssh_t 'pgrep -f soundtouch-service-v0 >/dev/null' 2>/dev/null; then
    # процесс жив, но снаружи порт недоступен: так бывает, когда планшет
    # уходил в сон и служба потеряла сетевой интерфейс — помогает перезапуск
    say "  процесс жив, но порт снаружи закрыт — перезапускаю службу"
    ssh_t 'nohup setsid ~/aftertouch/restart.sh >/dev/null 2>&1 < /dev/null &' >/dev/null 2>&1
  else
    say "  служба не запущена, запускаю"
    ssh_t 'nohup setsid ~/.shortcuts/AfterTouch.sh >/dev/null 2>&1 < /dev/null &' >/dev/null 2>&1
  fi
  CHANGED=1
  local i
  for i in 1 2 3 4 5 6; do
    sleep 5
    [ "$(http_code "http://$SERVER_IP:8000/" 5)" = "200" ] && { say "  поднялась"; return 0; }
  done
  warn "служба так и не поднялась — смотри ~/aftertouch/service.log на планшете"
  return 1
}

# ------------------------------------------------- шаг 3: адрес внутри сервера

fix_server_address() {
  step "Шаг 3. Сверяю адрес, записанный внутри сервера"
  local current old
  current=$(ssh_t 'grep -o "\"server_url\": *\"[^\"]*\"" ~/aftertouch/data/settings.json' 2>/dev/null \
            | sed 's/.*"http:\/\///; s/:8000".*//')

  if [ -z "$current" ]; then
    warn "не смог прочитать settings.json — пропускаю этот шаг"
    return 1
  fi

  if [ "$current" = "$SERVER_IP" ]; then
    say "  в настройках уже $SERVER_IP — менять нечего"
    ssh_t "echo $SERVER_IP > ~/aftertouch/server-ip" >/dev/null 2>&1
    return 0
  fi

  old="$current"
  say "  в настройках $old, а сервер живёт на $SERVER_IP — переписываю"
  ssh_t "echo $SERVER_IP > ~/aftertouch/server-ip; ~/aftertouch/reip.sh $old $SERVER_IP" 2>&1 | sed 's/^/  /'
  CHANGED=1

  local i
  for i in 1 2 3 4 5 6; do
    sleep 5
    [ "$(http_code "http://$SERVER_IP:8000/" 5)" = "200" ] && { say "  служба перезапустилась с новым адресом"; return 0; }
  done
  warn "после переписывания адреса служба не поднялась"
  return 1
}

# ----------------------------------------------------------- шаг 4: где колонки

find_speakers() {
  step "Шаг 4. Ищу колонки"
  local prefix octet ip name found=""
  prefix="${SERVER_IP%.*}"

  for octet in $SPEAKER_OCTETS; do
    ip="$prefix.$octet"
    name=$(curl -s -m 5 "http://$ip:8090/info" 2>/dev/null | grep -o '<name>[^<]*' | sed 's/<name>//')
    [ -n "$name" ] && { say "  $ip — $name"; found="$found $ip"; }
  done

  # добираем то, что сервер сам нашёл по UPnP
  for ip in $(ssh_t "grep -oE 'at $prefix\.[0-9]+:8090' ~/aftertouch/service.log 2>/dev/null | grep -oE '$prefix\.[0-9]+' | sort -u" 2>/dev/null); do
    case " $found " in *" $ip "*) continue ;; esac
    name=$(curl -s -m 5 "http://$ip:8090/info" 2>/dev/null | grep -o '<name>[^<]*' | sed 's/<name>//')
    [ -n "$name" ] && { say "  $ip — $name (из журнала сервера)"; found="$found $ip"; }
  done

  SPEAKERS="${found# }"

  if interactive; then
    case "$(printf '%s\n' $SPEAKERS | grep -c .)" in
      0) ask_speakers "нет"  ;;
      1) ask_speakers "одна" ;;
    esac
  fi

  [ -z "$SPEAKERS" ] && { warn "колонки не найдены: проверь, что они подключены к этой же сети"; return 1; }
  return 0
}

# Спрашивает адреса колонок, когда автопоиск нашёл не всё.
# Принимает несколько значений через пробел: «11 179» или полные адреса.
ask_speakers() {
  local how="$1" raw item cand name added=""
  say ""
  case "$how" in
    нет)  say "  Колонки не найдены по обычным адресам." ;;
    одна) say "  Нашлась только одна колонка." ;;
  esac
  say "  Посмотри в настройках роутера адреса колонок и введи их через пробел."
  say "  Можно только последние цифры (например 11 179) или адреса целиком."
  say "  Пустая строка — продолжить с тем, что нашлось."
  printf '  Адреса колонок: '
  read -r raw || return 0
  [ -z "$raw" ] && return 0

  for item in $raw; do
    for cand in $(expand_input "$item"); do
      case " $SPEAKERS $added " in *" $cand "*) continue ;; esac
      name=$(curl -s -m 5 "http://$cand:8090/info" 2>/dev/null | grep -o '<name>[^<]*' | sed 's/<name>//')
      if [ -n "$name" ]; then
        say "    $cand — $name"
        added="$added $cand"
        break
      fi
    done
  done

  if [ -n "$added" ]; then
    SPEAKERS="$(printf '%s %s' "$SPEAKERS" "${added# }" | sed 's/^ *//; s/  */ /g')"
    # запоминаем последние цифры, чтобы в следующий раз найти сразу
    SPEAKER_OCTETS="$(printf '%s\n' $SPEAKERS | sed 's/.*\.//' | sort -un | tr '\n' ' ')"
    SPEAKER_OCTETS="${SPEAKER_OCTETS% }"
    remember
  else
    say "    по этим адресам колонки не отвечают"
  fi
}

# ------------------------------------------------- шаг 5: перенаправить колонку

migrate_speaker() {
  local ip="$1" marge
  marge=$(curl -s -m 6 "http://$ip:8090/info" | grep -o '<margeURL>[^<]*' | sed 's/<margeURL>//')

  if [ "$marge" = "http://$SERVER_IP:8000" ]; then
    say "  $ip: уже смотрит на наш сервер"
    return 0
  fi

  say "  $ip: смотрит на $marge — перенаправляю"
  cli "$ip" setup migrate --method telnet --service-url "http://$SERVER_IP:8000" | tail -2 | sed 's/^/    /'
  cli "$ip" setup reboot | tail -1 | sed 's/^/    /'
  CHANGED=1

  printf '    жду возвращения колонки'
  local i
  for i in $(seq 1 12); do
    sleep 10; printf '.'
    marge=$(curl -s -m 5 "http://$ip:8090/info" 2>/dev/null | grep -o '<margeURL>[^<]*' | sed 's/<margeURL>//')
    if [ "$marge" = "http://$SERVER_IP:8000" ]; then
      say " вернулась"
      sleep 20   # ещё немного: команды принимает раньше, чем начинает играть
      return 0
    fi
  done
  say ""
  warn "$ip: после перезагрузки адрес так и не сменился"
  return 1
}

# ----------------------------------------------------------- шаг 6: пресеты

fix_presets() {
  local ip="$1" presets slot loc name newloc fixed=0 stopped=0
  presets=$(curl -s -m 8 "http://$ip:8090/presets")
  [ -z "$presets" ] && { warn "$ip: не удалось прочитать пресеты"; return 1; }

  mkdir -p "$BACKUP_DIR"
  printf '%s' "$presets" > "$BACKUP_DIR/presets-$ip-$STAMP.xml"

  for slot in 1 2 3 4 5 6; do
    loc=$(printf '%s' "$presets" | sed 's/></>\n</g' | awk -v s="$slot" '
      $0 ~ "<preset id=\""s"\"" {p=1} p{print} p && /\/preset>/{exit}' \
      | grep -o 'location="[^"]*"' | head -1 | sed 's/location="//; s/"$//')
    [ -z "$loc" ] && continue

    # нас интересуют только ссылки на облако (наше или мёртвое бозовское)
    case "$loc" in
      *"$SERVER_IP:8000"*) continue ;;
      *content.api.bose.io*|*"/core02/svc-bmx-adapter-orion/"*) ;;
      *) continue ;;
    esac

    name=$(printf '%s' "$presets" | sed 's/></>\n</g' | awk -v s="$slot" '
      $0 ~ "<preset id=\""s"\"" {p=1} p{print} p && /\/preset>/{exit}' \
      | grep -o '<itemName>[^<]*' | head -1 | sed 's/<itemName>//')

    # адрес станции у нас закодирован в query — меняем только хост
    newloc=$(printf '%s' "$loc" | sed -E "s#^https?://[^/]+#http://$SERVER_IP:8000#")

    if [ "$stopped" = "0" ]; then
      # запись не применяется, если колонка играет этот же слот
      cli "$ip" key send --key POWER >/dev/null 2>&1
      sleep 4
      stopped=1
    fi

    printf '  %s слот %s (%s): переписываю адрес\n' "$ip" "$slot" "${name:-без названия}"
    curl -s -m 10 -X POST -H 'Content-Type: application/xml' \
      --data-raw "<preset id=\"$slot\"><ContentItem source=\"LOCAL_INTERNET_RADIO\" type=\"stationurl\" location=\"$newloc\" sourceAccount=\"\" isPresetable=\"true\"><itemName>$name</itemName><containerArt></containerArt></ContentItem></preset>" \
      "http://$ip:8090/storePreset" >/dev/null 2>&1
    fixed=$((fixed + 1)); CHANGED=1
  done

  [ "$fixed" = "0" ] && say "  $ip: пресеты уже указывают на наш сервер"
  return 0
}

# ----------------------------------------------------------- шаг 7: проверка

verify_speaker() {
  local ip="$1" slot status
  # берём первый слот, который ссылается на наш сервер
  slot=$(curl -s -m 8 "http://$ip:8090/presets" | sed 's/></>\n</g' \
    | awk -v srv="$SERVER_IP:8000" '
        /<preset id=/ { id=$0; sub(/.*<preset id="/,"",id); sub(/".*/,"",id) }
        index($0, srv) && id { print id; exit }')

  if [ -z "$slot" ]; then
    warn "$ip: нет ни одного пресета, указывающего на сервер — нечего проверять"
    return 1
  fi

  cli "$ip" preset select --slot="$slot" >/dev/null 2>&1
  sleep 20
  # читаем состояние прямо у колонки: soundtouch-cli спотыкается, когда
  # станция присылает метаданные не в UTF-8
  status=$(curl -s -m 8 "http://$ip:8090/now_playing" | grep -oE 'playStatus>[A-Z_]*' | head -1 | sed 's/playStatus>//')
  case "$status" in
    PLAY_STATE)   say "  $ip слот $slot: играет"; return 0 ;;
    BUFFERING*)   say "  $ip слот $slot: буферизация — подожди несколько секунд"; return 0 ;;
    *)            warn "$ip: пресет $slot не заиграл (состояние: ${status:-нет ответа}) — проверь станцию вручную"; return 1 ;;
  esac
}

# ---------------------------------------------------------------------- запуск

# AFTERTOUCH_LIB=1 — подключить файл как библиотеку функций, ничего не запуская
# (так проверяются отдельные функции, см. tests/fix-aftertouch-test.sh).
[ "${AFTERTOUCH_LIB:-0}" = "1" ] && return 0

say "AfterTouch — перенастройка под текущую сеть"

if ! find_server; then
  say ""
  say "Планшет не найден. Что проверить:"
  say "  1. Планшет включён и разблокирован. После перезагрузки сервер стартует"
  say "     только после первого разблокирования экрана — это нормально."
  say "  2. Планшет в той же сети, что и компьютер. Его адрес можно посмотреть"
  say "     в списке клиентов роутера и ввести, когда скрипт спросит."
  say "  3. Колонки подключены к этой же сети."
  say ""
  say "Запусти скрипт ещё раз, когда планшет будет доступен."
  exit 1
fi

say "  сервер: $SERVER_IP"
ensure_service || exit 1
fix_server_address

if find_speakers; then
  step "Шаг 5. Проверяю, куда смотрят колонки"
  for spk in $SPEAKERS; do migrate_speaker "$spk"; done

  step "Шаг 6. Проверяю пресеты"
  for spk in $SPEAKERS; do fix_presets "$spk"; done

  step "Шаг 7. Проверяю воспроизведение"
  for spk in $SPEAKERS; do verify_speaker "$spk"; done
fi

step "Итог"
if [ "$CHANGED" = "0" ]; then
  say "Перенастройка не потребовалась: сервер на $SERVER_IP, колонки его видят."
else
  say "Готово. Сервер: http://$SERVER_IP:8000"
fi

if [ "${#WARNINGS[@]}" -gt 0 ]; then
  say ""
  say "На что обратить внимание:"
  for w in "${WARNINGS[@]}"; do say "  - $w"; done
fi

say ""
say "Проверь физические кнопки на колонках — этот путь идёт через эмуляцию"
say "облака и проверяется только руками."
