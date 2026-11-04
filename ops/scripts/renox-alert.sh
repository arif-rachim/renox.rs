#!/usr/bin/env bash
# Tells the operator that a systemd unit failed (#450). Started by
# renox-alert@.service (OnFailure= of the backup and billing units) with the
# failed unit's name:
#
#   renox-alert.sh <unit>
#
# Reads ALERT_WEBHOOK_URL from the alert.env credential
# ($CREDENTIALS_DIRECTORY/alert.env, or ALERT_ENV for a test): one line
# `ALERT_WEBHOOK_URL=https://…`. Posts JSON `{"text": …, "unit": …, "host":
# …}` with the last journal lines of the unit; a Slack or Mattermost incoming
# webhook shows `text`, ntfy and most chat bridges accept it too. Without the
# file it prints the alert to the journal only and exits 0, so the unit
# itself never fails for want of a receiver. The URL is never printed.
set -euo pipefail

unit=${1:?usage: renox-alert.sh <unit>}
[[ $unit =~ ^[A-Za-z0-9@._:-]+$ ]] || { echo "renox-alert: not a unit name: $unit" >&2; exit 2; }
host=$(hostname 2>/dev/null || echo unknown)
env_file=${ALERT_ENV:-${CREDENTIALS_DIRECTORY:-/nonexistent}/alert.env}

url=""
if [[ -r $env_file ]]; then
  while IFS='=' read -r key value; do
    case $key in
      ALERT_WEBHOOK_URL) url=$value ;;
      ''|'#'*) ;;
      *) echo "renox-alert: unknown key $key in alert.env" >&2; exit 2 ;;
    esac
  done < "$env_file"
fi

lines=$(journalctl -u "$unit" -n 15 --no-pager -o cat 2>/dev/null | tail -n 15 || true)
text="$unit failed on $host"
echo "renox-alert: $text"
if [[ -z $url ]]; then
  echo "renox-alert: no ALERT_WEBHOOK_URL in alert.env; the alert is only in this journal"
  exit 0
fi
[[ $url == https://* ]] || { echo "renox-alert: ALERT_WEBHOOK_URL must be https://" >&2; exit 2; }

body=$(TEXT="$text" UNIT="$unit" HOST="$host" LINES="$lines" python3 -c 'import json, os; print(json.dumps({"text": os.environ["TEXT"] + "\n" + os.environ["LINES"], "unit": os.environ["UNIT"], "host": os.environ["HOST"]}))')
# The URL goes to curl on its standard input (a config line), never in argv.
printf 'url = "%s"\n' "$url" | curl -fsS --max-time 20 --retry 3 -X POST -H 'content-type: application/json' --data-binary "$body" -K - >/dev/null
echo "renox-alert: sent"
