# Deployment: green means green on the box

The rule, stated once: **a change is not green until it passes on the actual Acer
box**, both the test suite and a functional check against the running service. A
passing run on a laptop is necessary but never sufficient. The box is the source
of truth because the box is where this runs: the GPU, the OpenShell gateway, the
vLLM, and the systemd service all live there and none of them exist on a laptop.

## No workstation is part of the system

A laptop is for editing code. Nothing at runtime may depend on one. Concretely:

- **Every demo and script defaults to the box's own addresses.** The gateway is
  `ws://127.0.0.1:18789` on the box, not a tunnel port. `OPENCLAW_GATEWAY_URL`
  exists so a developer can point at an SSH tunnel; that is a convenience for
  development and never how it is deployed or demonstrated.
- **Secrets live on the box.** `/home/arif/omoda/.env`, mode 600, gitignored:
  the Telegram token and allowlist, and the OpenClaw gateway token. systemd loads
  it as an `EnvironmentFile`, so nothing is passed on a command line.
- **Identity is generated on the box.** The ed25519 device key that authenticates
  to the gateway is created on first run at `var/device/openclaw-device.key`
  (gitignored, mode 600). It is deliberately not copied from a laptop, so the
  identity that talks to the gateway lives where the system lives.
- **The model is on the box.** Local Nemotron on `:8000`, no hosted API key
  anywhere in the deployment.

The test: kill every SSH tunnel from the workstation, then run
`ssh gn100 'cd /home/arif/omoda && node src/demo/three-layer.js'`. It must pass.
That is checked automatically in the smoke section below, which runs the demo on
the device and asserts its four properties.

## The only deploy path

```
scripts/deploy-box.sh              # deploy origin/main
scripts/deploy-box.sh <git-ref>    # deploy a specific ref
```

It runs from a workstation and does, in order, aborting RED on any failure:

1. **Preflight** the box is reachable and the ref exists.
2. **Sync** the box checkout to the ref (`git reset --hard`) and `npm ci`.
3. **Parity** the box's git tree hash must equal the ref's exactly, not just the
   commit id. This catches a dirty checkout or a partial sync.
4. **Tests on the device**: `scripts/box-verify.sh tests` runs the full `node --test`
   suite and the compliance gate on the box. A broken build is never deployed.
5. **Restart** the `omoda` systemd service and wait for `/healthz` to return 200.
6. **Functional smoke on the device**: `scripts/box-verify.sh smoke` hits the live
   service:
   - `omoda.service` is active under systemd
   - `GET /healthz` and `GET /ui` return 200
   - the stream port returns 426 (upgrade required)
   - `GET /v1/ledger` with no token returns 401/403 (auth is enforced, not bypassed)
   - the boot log shows the **OpenShell sandbox** policy, i.e. real Layer 3, not the
     in-process simulator
   - the local **Nemotron answers on `:8000`**, because a degraded planner leaves
     every process looking healthy while half the system's claims stop being
     demonstrable
   - **all three layers run end to end** against the live gateway, asserted on
     substance rather than exit code: the gateway said `hello-ok`, the read ran
     with no human in the loop, the write reverted to `403`, and the prohibited
     call was refused by `gateway-self-protection`

Only if all of that passes does it print `GREEN on the device`.

## Why a systemd service

`nohup … &` over a one-shot SSH does not survive the session; a launch looked
successful and then vanished, and a stale log read as if it were live. The service
(`/etc/systemd/system/omoda.service`, `Restart=on-failure`, `enabled`) survives SSH
logout and reboot, and loads the Telegram secrets from `/home/arif/omoda/.env` as
an `EnvironmentFile` so they are never on a command line.

Manage it: `sudo systemctl {status,restart,stop} omoda`; logs at
`/home/arif/omoda/var/log/omoda.out` or `journalctl -u omoda`.

## One poller

The box is the single Telegram poller. Do not run `serve:live` or `demo:live`
locally while the service is up, or the two loops fight over `getUpdates`.

## Reporting

When you say a deploy is done, it means `scripts/deploy-box.sh` printed GREEN on
the device. If you only ran tests locally, say exactly that and that it is not yet
deployed. Do not call a change green on the strength of a laptop run.
