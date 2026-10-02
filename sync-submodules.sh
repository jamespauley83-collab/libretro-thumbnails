#!/usr/bin/env sh
# Request a sync from the running server, which serializes manual/startup/periodic
# jobs. With one argument, initialize that system only; otherwise update loaded ones.
set -eu
cd "$(dirname "$0")"
node - "$@" <<'NODE'
const system = process.argv[2];
fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/sync`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(system === undefined ? {} : { system })
}).then(async response => {
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
