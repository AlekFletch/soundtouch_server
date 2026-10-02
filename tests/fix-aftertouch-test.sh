#!/usr/bin/env bash
# Проверки разбора адресов и ручного ввода в scripts/fix-aftertouch.sh.
# Сеть не трогаются: местные подсети и опрос колонок подменяются заглушками.
#
#   bash tests/fix-aftertouch-test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$DIR/data"
CONF_FILE_OVERRIDE="$DIR/data/network.conf.test"   # data/ вне git, настоящий конфиг не трогаем
rm -f "$CONF_FILE_OVERRIDE"

AFTERTOUCH_LIB=1 . "$DIR/scripts/fix-aftertouch.sh"
CONF_FILE="$CONF_FILE_OVERRIDE"   # чтобы тест не трогал настоящий data/network.conf

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ок   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  СБОЙ %s\n     ожидалось: %s\n     получено:  %s\n' "$1" "$2" "$3"; }
check() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

# заглушки вместо реальной сети
local_prefixes() { printf '%s\n' 192.168.1 10.0.0; }

say() { :; }   # тесты не печатают приглашения скрипта

echo "expand_input — из чего получаются адреса-кандидаты"
check "последние цифры разворачиваются во все подсети" \
  "192.168.1.161 10.0.0.161" "$(expand_input 161 | tr '\n' ' ' | sed 's/ $//')"
check "полный адрес берётся как есть" \
  "192.168.1.50" "$(expand_input 192.168.1.50)"
check "мусор не даёт кандидатов" \
  "" "$(expand_input 'привет')"
check "пустой ввод не даёт кандидатов" \
  "" "$(expand_input '')"

echo
echo "ask_speakers — ручной ввод адресов колонок"

# колонка «отвечает» только по двум адресам
curl() {
  local url="${*: -1}"
  case "$url" in
    *192.168.1.11:8090/info)  printf '<info><name>SoundTouch 10</name></info>' ;;
    *192.168.1.179:8090/info) printf '<info><name>SoundTouch 20</name></info>' ;;
  esac
}

SPEAKERS=""; SPEAKER_OCTETS=""
ask_speakers "нет" <<< "11 179" >/dev/null
check "обе колонки добавлены по последним цифрам" "192.168.1.11 192.168.1.179" "$SPEAKERS"
check "цифры запомнены для следующего запуска" "11 179" "$SPEAKER_OCTETS"

SPEAKERS=""; SPEAKER_OCTETS=""
ask_speakers "нет" <<< "192.168.1.179" >/dev/null
check "полный адрес тоже принимается" "192.168.1.179" "$SPEAKERS"

SPEAKERS="192.168.1.11"; SPEAKER_OCTETS="11"
ask_speakers "одна" <<< "179" >/dev/null
check "вторая колонка добавляется к найденной" "192.168.1.11 192.168.1.179" "$SPEAKERS"

SPEAKERS="192.168.1.11"; SPEAKER_OCTETS="11"
ask_speakers "одна" <<< "" >/dev/null
check "пустой ввод ничего не меняет" "192.168.1.11" "$SPEAKERS"

SPEAKERS=""; SPEAKER_OCTETS=""
ask_speakers "нет" <<< "77" >/dev/null
check "молчащий адрес не добавляется" "" "$SPEAKERS"

echo
echo "запомненные адреса"
# последним запоминался набор из случая «вторая колонка добавляется к найденной»
check "файл настроек записан" "SAVED_SPEAKER_OCTETS=\"11 179\"" "$(grep SAVED_SPEAKER_OCTETS "$CONF_FILE" | tail -1)"


echo
echo "привязка к аккаунту и пустые кнопки"
SERVER_IP="192.168.1.216"; WARNINGS=(); CHANGED=0
ACC_STATE=""            # что колонка 11 сейчас отвечает в margeAccountUUID
CALLS_FILE="$DIR/data/calls.test"; : > "$CALLS_FILE"; SERVER_ACCOUNTS="default
8350196"

curl() {
  local url="${*: -1}"
  case "$url" in
    *192.168.1.11:8090/info)  printf "<info><margeAccountUUID>%s</margeAccountUUID></info>" "$([ -s "$CALLS_FILE" ] && grep -q "^pair" "$CALLS_FILE" && echo 8350196)" ;;
    *192.168.1.179:8090/info) printf '<info><margeAccountUUID>8350196</margeAccountUUID></info>' ;;
    *192.168.1.11:8090/presets)  printf '<presets />' ;;
    *192.168.1.179:8090/presets) printf '<presets><preset id="1"></preset><preset id="2"></preset></presets>' ;;
  esac
}
ssh_t() { printf '%s\n' "$SERVER_ACCOUNTS"; }
cli() { echo "pair|$*" >> "$CALLS_FILE"; ACC_STATE_FILE=1; echo "ok"; }
bash() { echo "copy|$*" >> "$CALLS_FILE"; }

check "пустой аккаунт читается как пусто" "" "$(account_of 192.168.1.11)"
check "аккаунт колонки 179" "8350196" "$(account_of 192.168.1.179)"
check "аккаунт сервера — числовой, без default" "8350196" "$(server_account)"
check "кнопки считаются" "2" "$(count_presets 192.168.1.179)"
check "пустые кнопки: ноль" "0" "$(count_presets 192.168.1.11)"

pair_speaker 192.168.1.179 >/dev/null
check "привязанную колонку не трогаем" "" "$(cat "$CALLS_FILE")"

pair_speaker 192.168.1.11 >/dev/null
case "$(cat "$CALLS_FILE")" in
  *"192.168.1.11 setup pair --account 8350196 --service-url http://192.168.1.216:8000"*) ok "непривязанная колонка привязывается к аккаунту сервера" ;;
  *) bad "непривязанная колонка привязывается к аккаунту сервера" "setup pair --account 8350196" "$(cat "$CALLS_FILE")" ;;
esac

: > "$CALLS_FILE"; ACC_STATE=""; SERVER_ACCOUNTS="1111111
2222222"; WARNINGS=()
pair_speaker 192.168.1.11 >/dev/null
check "два аккаунта на сервере: не угадываем, предупреждаем" "0|1" "$(grep -c ^pair "$CALLS_FILE")|${#WARNINGS[@]}"

SPEAKERS="192.168.1.11 192.168.1.179"; : > "$CALLS_FILE"
fill_empty_presets 192.168.1.11 >/dev/null
check "пустая колонка заполняется с соседней" "copy|scripts/copy-presets.sh 192.168.1.179 192.168.1.11" "$(sed "s#$DIR/##" "$CALLS_FILE")"
: > "$CALLS_FILE"
fill_empty_presets 192.168.1.179 >/dev/null
check "колонку с кнопками не трогаем" "" "$(cat "$CALLS_FILE")"
rm -f "$CALLS_FILE"; unset -f curl ssh_t cli bash

echo
echo "translit — названия кнопок для SoundTouch 10"
eval "$(sed -n '/^translit() {/,/^}/p' "$DIR/scripts/copy-presets.sh")"
check "кириллица становится латиницей" "Radio Romantika" "$(printf 'Радио Романтика' | translit)"
check "ь, ъ пропадают, щ — shch" "Ezhik Shchuka" "$(printf 'Ёжик Щука' | translit)"
check "латиница и цифры не меняются" "101.ru Relax Gold" "$(printf '101.ru Relax Gold' | translit)"
rm -f "$CONF_FILE_OVERRIDE"
echo
printf 'итог: успешно %d, сбоев %d\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
