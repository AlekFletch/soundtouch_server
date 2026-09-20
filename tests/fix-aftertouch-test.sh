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

rm -f "$CONF_FILE_OVERRIDE"
echo
printf 'итог: успешно %d, сбоев %d\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
