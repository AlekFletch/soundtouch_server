#!/usr/bin/env bash
# Записывает станцию в пресет колонки через эмуляцию облака (AfterTouch).
#
#   scripts/set-preset.sh <IP колонки> <слот 1-6> <название> <URL потока> [IP сервера]
#
# Колонка не умеет играть произвольный URL: её BMX-модуль ждёт по адресу пресета
# JSON-ответ Orion, поэтому ссылка на поток заворачивается в адрес нашего сервера.
# По умолчанию сервер — 10.201.175.161:8000 (планшет, последний октет всегда 161).
set -euo pipefail

SPEAKER="${1:?нужен IP колонки}"
SLOT="${2:?нужен номер слота 1-6}"
NAME="${3:?нужно название станции}"
STREAM="${4:?нужен URL потока}"
SERVER="${5:-10.201.175.161:8000}"

case "$SLOT" in [1-6]) ;; *) echo "слот должен быть от 1 до 6" >&2; exit 1 ;; esac

json=$(printf '{"name":"%s","imageUrl":"","streamUrl":"%s"}' "$NAME" "$STREAM")
data=$(printf '%s' "$json" | base64 -w0 | sed 's/=/%3D/g; s/+/%2B/g; s|/|%2F|g')
loc="http://$SERVER/core02/svc-bmx-adapter-orion/prod/orion/station?data=$data"

# Убеждаемся, что сервер отдаёт станцию, прежде чем трогать колонку.
if ! curl -sf -m 10 "$loc" | grep -q '"streamUrl"'; then
  echo "сервер $SERVER не отдал станцию по адресу пресета — колонку не трогаю" >&2
  exit 1
fi

body="<preset id=\"$SLOT\"><ContentItem source=\"LOCAL_INTERNET_RADIO\" type=\"stationurl\" location=\"$loc\" sourceAccount=\"\" isPresetable=\"true\"><itemName>$NAME</itemName><containerArt></containerArt></ContentItem></preset>"
code=$(curl -s -m 10 -X POST -H "Content-Type: application/xml" --data-raw "$body" \
  "http://$SPEAKER:8090/storePreset" -o /dev/null -w "%{http_code}")
echo "колонка $SPEAKER, слот $SLOT ($NAME): http $code"
