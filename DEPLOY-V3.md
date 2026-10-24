# Deploying screen-bot-v3 to the DigitalOcean droplet

Same convention as v1 and v2: one directory, one service.

| | v1 | v2 | **v3 (this)** |
|---|---|---|---|
| Directory | /home/botuser/ | /home/botuser/v2/ | **/home/botuser/bot-v3/** |
| Script | rh-new-token-screen.js | token-screener-v3.js | **watch-launches.js** |
| Service | token-screener | token-screener-v2 | **token-screener-v3** |
| Records | screening-data.jsonl | v2/screening-data.jsonl | **bot-v3/launches.jsonl** |
| Log | screener.log | v2/screener.log | **bot-v3/logs/watch-*.txt** (one per start) |

Name clash to be aware of: v2's *script* is called `token-screener-v3.js`. The v3 *bot* is
this folder; its script is `watch-launches.js`.

This folder (`deploy-v3/`) holds exactly what the server needs: the 16 runtime files,
13 offline test suites, `package.json`, the systemd unit and `server-setup.sh`.
`.env` and `launches.jsonl` are copied separately from the project folder.

## On the PC (Git Bash)

Stop the PC watcher first (Ctrl+C) so `launches.jsonl` is final. Then:

    cd /e/De-Fi-work-2/Flashbot-test/screen-bot-v3
    ssh root@138.197.134.201 "mkdir -p /home/botuser/bot-v3"
    scp -r deploy-v3/* root@138.197.134.201:/home/botuser/bot-v3/
    scp .env launches.jsonl root@138.197.134.201:/home/botuser/bot-v3/

## On the server

    ssh root@138.197.134.201
    bash /home/botuser/bot-v3/server-setup.sh

It checks the upload, comments out the debug switches in the server's `.env`, installs
packages as botuser, runs all offline tests, tests the RPC / Blockscout / Tenderly from the
droplet, and installs + enables the service **without starting it**. It ends with
`ALL GOOD` or `SOMETHING FAILED`.

Live smoke test (1-2 minutes, should end `==> SNIP`):

    cd /home/botuser/bot-v3 && sudo -u botuser node screen-token.js 0x66A844fcbf4705Dbde3c97394d5a4C9822E8F35b

Start:

    systemctl start token-screener-v3
    systemctl is-active token-screener-v3

## What the bot saves (all in /home/botuser/bot-v3/)

| File | What | Use |
|---|---|---|
| `launches.jsonl` | one summary line per **screened** token: verdict, reason, gate, Gate 1b/5b/5c/6 summaries, flags | scorecard, quick tables |
| `detections.jsonl` | one line per **event seen**: `pool_created` (incl. extra pools for known tokens, `knownToken: true`), every `liquidity` add with running total, `launched`, `expired` (never reached the minimum in 24h) | everything detected, screened or not |
| `screens/<date>/<time>_<SYMBOL>_<token>.json` | the **complete** result of every gate for one screened token (numbers as exact strings) | digging into one token |
| `logs/watch-*.txt` | everything printed, one file per start | reading a run as text |

Download everything for analysis (run on the PC):

    cd /e/De-Fi-work-2/Flashbot-test/screen-bot-v3
    scp root@138.197.134.201:/home/botuser/bot-v3/launches.jsonl ./server-launches.jsonl
    scp root@138.197.134.201:/home/botuser/bot-v3/detections.jsonl ./server-detections.jsonl
    scp -r root@138.197.134.201:/home/botuser/bot-v3/screens ./server-screens
    scp -r root@138.197.134.201:/home/botuser/bot-v3/logs ./server-logs

## Day to day

    systemctl is-active token-screener-v3                     # running?
    tail -f $(ls -t /home/botuser/bot-v3/logs/*.txt | head -1)    # watch live (Ctrl+C stops watching only)
    wc -l /home/botuser/bot-v3/launches.jsonl                     # records so far
    tail -n 1 /home/botuser/bot-v3/launches.jsonl | head -c 300   # newest record (is it still working?)
    cat /home/botuser/bot-v3/service-error.log                    # crashes
    systemctl restart token-screener-v3
    systemctl stop token-screener-v3
    free -h ; df -h / ; du -sh /home/botuser/bot-v3/logs

Download the records for analysis (run on the PC):

    cd /e/De-Fi-work-2/Flashbot-test/screen-bot-v3
    scp root@138.197.134.201:/home/botuser/bot-v3/launches.jsonl ./launches-server.jsonl
    scp -r root@138.197.134.201:/home/botuser/bot-v3/logs ./logs-server

## Updating the code later

Upload only the changed files with `scp`, then `systemctl restart token-screener-v3`.
Re-running `server-setup.sh` after an upload is safe and re-runs the tests.

## Rules carried over from the v2 guide

- Never run `npm audit fix --force` (it would install ethers 6 and break every file).
- `npm install` only as botuser (`server-setup.sh` does this).
- Always check an upload landed — `server-setup.sh` checks Gate 5c and the Tenderly fix are present.
- Leave the server timezone alone; records use America/Edmonton on purpose.
- Nothing here trades or needs a private key. Never put one in the server's `.env`.
