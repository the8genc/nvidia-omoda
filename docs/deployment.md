# Deployment: green means green on the box

The rule, stated once: **a change is not green until it passes on the actual Acer
box**, both the test suite and a functional check against the running service. A
passing run on a laptop is necessary but never sufficient. The box is the source
of truth because the box is where this runs: the GPU, the OpenShell gateway, the
vLLM, and the systemd service all live there and none of them exist on a laptop.

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
