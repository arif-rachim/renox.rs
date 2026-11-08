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
# …, "node": …}` with the last journal lines of the unit; a Slack or
# Mattermost incoming webhook shows `text`, ntfy and most chat bridges accept
# it too. Without the file (or with only the unit's SetCredential= fallback,
# a comment line, #545) it logs `renox-alert: no alert.env; <unit> failed on
# <node>` to the journal and exits 0, so the unit itself never fails for want
# of a receiver. The URL is never printed.
# The node's name comes from the node-name credential (or NODE_NAME_FILE for
# a test; /etc/renox/node-name on the host, written by bootstrap-node.sh);
# without it the Linux host name stands in.
set -euo pipefail

unit=${1:?usage: renox-alert.sh <unit>}
[[ $unit =~ ^[A-Za-z0-9@._:-]+$ ]] || { echo "renox-alert: not a unit name: $unit" >&2; exit 2; }
host=$(hostname 2>/dev/null || echo unknown)
env_file=${ALERT_ENV:-${CREDENTIALS_DIRECTORY:-/nonexistent}/alert.env}
node_file=${NODE_NAME_FILE:-${CREDENTIALS_DIRECTORY:-/nonexistent}/node-name}

node=""
if [[ -r $node_file ]]; then read -r node < "$node_file" || true; fi
[[ $node =~ ^[a-z0-9][a-z0-9_.-]{0,62}$ ]] || node=$host

url="" keys=0
if [[ -r $env_file ]]; then
  while IFS='=' read -r key value || [[ -n $key ]]; do
    case $key in
      ALERT_WEBHOOK_URL) url=$value; keys=$((keys + 1)) ;;
      ''|'#'*) ;;
      *) echo "renox-alert: unknown key $key in alert.env" >&2; exit 2 ;;
    esac
  done < "$env_file"
fi

text="$unit failed on $node"
[[ $node == "$host" ]] || text="$text ($host)"
if [[ $keys -eq 0 ]]; then
  # No file, or only comments (the unit's fallback): the journal is the alert.
  echo "renox-alert: no alert.env; $text"
  echo "renox-alert: the alert is only in this journal"
  exit 0
fi
lines=$(journalctl -u "$unit" -n 15 --no-pager -o cat 2>/dev/null | tail -n 15 || true)
echo "renox-alert: $text"
if [[ -z $url ]]; then
  echo "renox-alert: ALERT_WEBHOOK_URL is empty in alert.env; the alert is only in this journal"
  exit 0
fi
[[ $url == https://* ]] || { echo "renox-alert: ALERT_WEBHOOK_URL must be https://" >&2; exit 2; }

body=$(TEXT="$text" UNIT="$unit" HOST="$host" NODE="$node" LINES="$lines" python3 -c 'import json, os; print(json.dumps({"text": os.environ["TEXT"] + "\n" + os.environ["LINES"], "unit": os.environ["UNIT"], "host": os.environ["HOST"], "node": os.environ["NODE"]}))')
# The URL goes to curl on its standard input (a config line), never in argv.
printf 'url = "%s"\n' "$url" | curl -fsS --max-time 20 --retry 3 -X POST -H 'content-type: application/json' --data-binary "$body" -K - >/dev/null
echo "renox-alert: sent"
