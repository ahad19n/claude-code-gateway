# Claude Code gateway

Lets Claude Code on several workstations share one Max subscription. The
setup-token lives only on the gateway. Each workstation gets its own key, its
own model block list, and its usage is recorded separately.

Runs as a single container serving HTTPS on https://claude.semafore.co. The
certificate comes from Let's Encrypt via certbot on the host, which only runs
while renewing; the gateway reloads renewed certificates without a restart.

## 1. AWS Lightsail instance

1. Create a Linux instance on the $5/month plan **with public IPv4**, using
   the newest **Debian** image Lightsail offers (lightest on memory; Ubuntu
   also works but runs more in the background).
2. **Networking → Attach static IP.** Free while attached; keeps the address
   fixed. Use this IP everywhere below.
3. **Networking → IPv4 Firewall:** allow TCP 22 (SSH), 80 and 443. Nothing else.
   Port 80 is only used by certbot while issuing or renewing the certificate,
   but it must be reachable from anywhere for that. If your workstations have
   static IPs, you can restrict 443 to them.

SSH in (`ssh -i path/to/lightsail-key.pem admin@<static-ip>`), then:

### Swap (do this first)

512 MB is enough for the gateway, with 1 GB of swap as a safety margin:

    sudo fallocate -l 1G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

Only use swap when memory actually runs short:

    echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
    sudo sysctl -p /etc/sysctl.d/99-swappiness.conf

`free -m` should now show `Swap: 1023`.

### System updates

    sudo apt update
    sudo apt full-upgrade -y

If a new kernel was installed (`linux-image` in the output), `sudo reboot`.

Automatic security updates (choose "Yes" when asked):

    sudo apt install -y unattended-upgrades
    sudo dpkg-reconfigure -plow unattended-upgrades

These don't reboot by themselves; reboot after kernel updates when convenient.
The gateway and swap come back on their own.

### Docker

From Docker's official repository (includes the Compose plugin):

    sudo apt-get update
    sudo apt-get install -y ca-certificates curl
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt-get update
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

Run Docker without `sudo` (log out and SSH back in afterwards):

    sudo usermod -aG docker $USER

Check:

    systemctl is-enabled docker        # enabled
    docker compose version
    docker run --rm hello-world        # "Hello from Docker!"

Expected memory at this point: roughly 120 MB used, 330 MB available.

## 2. DNS (Route 53)

In the hosted zone for `semafore.co`, create:

    Name: claude    Type: A    Value: <the static IP>

Wait until it resolves to the static IP before the next step:

    getent hosts claude.semafore.co

(Route 53 only answers for the domain if the domain's nameservers point to
Route 53; otherwise add the record wherever the domain's DNS is hosted.)

## 3. Gateway

### Clone the project

    sudo apt install -y git
    sudo git clone https://github.com/ahad19n/claude-code-gateway.git /opt/claude-code-gateway
    sudo chown -R admin:admin /opt/claude-code-gateway
    cd /opt/claude-code-gateway

All commands from here on run in `/opt/claude-code-gateway`.

### HTTPS certificate

Ports 80 and 443 must be open in the Lightsail firewall and DNS must resolve.

    sudo ./deploy/setup-cert.sh claude.semafore.co you@example.com

The email is optional (expiry notices). This installs certbot, gets the
certificate, copies it into `./certs`, and enables automatic renewal. The
renewal hook records this folder's path, so if you move or rename the folder
later, run the script again from the new location. Check the recorded path:

    sudo grep certs /etc/letsencrypt/renewal-hooks/deploy/claude-code-gateway.sh

### Setup-token

Create it on a trusted machine with a browser (not on a workstation):

    claude setup-token

Save it on the server:

    printf '%s' 'sk-ant-oat01-...' > secrets/setup-token
    chmod 600 secrets/setup-token
    sudo chown 1000:1000 secrets/setup-token     # container runs as uid 1000

### Settings: block Fable on every workstation

    cp .env.example .env
    nano .env

Set:

    GLOBAL_BLOCKED_MODELS=*fable*

(Comma-separate several patterns, e.g. `*fable*,*mythos*`. The global list
can't be overridden per workstation; for per-workstation blocks use
`gw block` instead.)

After changing `.env` later, apply it with `docker compose up -d` (a plain
`restart` doesn't re-read `.env`).

### Start

    docker compose up -d --build
    docker compose logs -f                           # Ctrl+C to stop watching

The log should show `listening on https://...` and
`global blocked: *fable*`. Then check from the server or your PC:

    curl https://claude.semafore.co/health           # {"ok":true}

Memory check:

    free -m
    docker stats --no-stream

### Updating

    cd /opt/claude-code-gateway
    git pull
    docker compose up -d --build
    docker compose ps                                # "(healthy)" after ~30 s

`.env`, `secrets/` and `certs/` aren't tracked by git, so a pull never touches
them, and the usage database lives in the `gateway-data` volume. Don't edit
tracked files on the server (including `chmod`), or `git pull` will refuse to
update; `git status` shows what changed and `git checkout -- <file>` undoes it.

## 4. Workstations

    docker compose exec gateway gw add ws1 --block "*fable*"
    docker compose exec gateway gw add ws2

Each `add` prints the workstation's key once. On the workstation, run the
setup script and paste the key when asked:

    irm https://claude.semafore.co/setup.ps1 | iex           # Windows PowerShell
    curl -fsSL https://claude.semafore.co/setup.sh | bash    # macOS / Linux

It installs Claude Code if needed, checks the key against the gateway, and
writes `~/.claude/settings.json` (keeping what's already there, with a backup):
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
`ENABLE_CLAUDEAI_MCP_SERVERS=false` (claude.ai connectors can't work through
the gateway, so this hides their warning) and the status line below. It
removes `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from the settings
and, on Windows, from the user environment, and removes any pinned
`ANTHROPIC_MODEL` so Claude Code's default and `/model` apply. Re-run it after
`gw rotate`.

To do it by hand instead: set `ANTHROPIC_BASE_URL=https://claude.semafore.co`
and `ANTHROPIC_AUTH_TOKEN=<key>`, and make sure `ANTHROPIC_API_KEY` and
`CLAUDE_CODE_OAUTH_TOKEN` are not set. Don't run `claude login` on the
workstations.

Changes made with `gw` take effect on the next request; no restart needed.

## Show Max usage in Claude Code's status line

Workstations can't use `/usage`, because they aren't logged in to claude.ai.
Instead, the gateway serves the 5-hour and 7-day figures to each workstation
at `GET /gateway/status` (authenticated with the workstation's key), and
`public/gateway-statusline.{sh,ps1}` put them in Claude Code's status line:

    5h 21% (1h56m) | 7d 25% (1d9h) | ws1 24h 1.2M tok

The time in brackets is until that window resets. The last part is this
workstation's tokens over the past 24 hours (input + cache writes + output;
cache reads are left out because they're tiny in cost but huge in count).

The setup script installs this. By hand: download
`https://claude.semafore.co/gateway-statusline.sh` (or `.ps1`) into the
workstation's `~/.claude/` folder and add to `~/.claude/settings.json`:

Git Bash / Linux / macOS:

    "statusLine": { "type": "command", "command": "bash ~/.claude/gateway-statusline.sh" }

PowerShell:

    "statusLine": { "type": "command",
      "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<you>/.claude/gateway-statusline.ps1" }

The scripts read `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. If the
status line says "gateway unreachable" while Claude Code itself works, set
`GATEWAY_URL` and `GATEWAY_KEY` for the script instead.

The figures come from Anthropic's response headers, so they update whenever
any workstation makes a request. If a window has reset since the last
request, it shows 0%.

## Public files (setup scripts)

Anything in `public/` is served at `https://claude.semafore.co/<name>` without
a key, for example:

    irm https://claude.semafore.co/setup.ps1 | iex           # PowerShell
    curl -fsSL https://claude.semafore.co/setup.sh | bash    # bash

Only files directly in `public/` are served (no subfolders or dotfiles).
`.ps1`, `.sh`, `.txt` and `.md` are served as plain text. The folder is mounted
read-only into the container, so new or changed files are live straight after
`git pull`, without a rebuild.

These files are readable by anyone on the internet. Never put a workstation
key or the setup-token in them; have scripts ask for the key instead.

## Commands

All run as `docker compose exec gateway gw <command>`:

    list                                  workstations, status, blocks, last seen
    block <name> "*fable*"                block models (glob, case-insensitive)
    unblock <name> "*fable*"
    disable <name> / enable <name>        cut a workstation off / restore it
    rotate <name>                         new key; old one stops working
    remove <name>                         delete (usage history kept)

    usage                                 last 7 days, per workstation
    usage --since 24h --by model          also: --by day | session, --ws <name>
    recent --ws ws1 --limit 50            latest requests
    plan                                  Max 5-hour / 7-day utilization
    export --since 30d > usage.csv        raw rows as CSV

Blocked requests return a clear error in Claude Code; switch with `/model`.
If you block Haiku on a workstation, Claude Code's background tasks
(titles, web-fetch summaries) also use Haiku, so point them at an allowed
model with `ANTHROPIC_DEFAULT_HAIKU_MODEL` on that workstation (older Claude
Code versions use `ANTHROPIC_SMALL_FAST_MODEL`).

## What gets recorded

One row per request: time, workstation, Claude Code session id, model,
status, outcome (ok / blocked / upstream_error / client_aborted /
gateway_error), input / output / cache-write / cache-read tokens, web search
count, duration, Anthropic request id, and the Max utilization reported at
that moment. Prompt and response content is never stored.

The database is in the `gateway-data` Docker volume. Back it up with:

    docker compose exec gateway node -e "new (require('node:sqlite').DatabaseSync)('/data/gateway.db').exec(\"VACUUM INTO '/data/backup.db'\")"
    docker compose cp gateway:/data/backup.db ./backup.db

## Resources

One container, memory-limited to 192 MB (Node heap capped at 96 MB); it
normally uses 50–80 MB. With the OS and Docker that fits a 512 MB instance,
with 1 GB swap as a safety margin. certbot only runs for a few seconds twice a
day. CPU use is negligible. Each request passes through twice (in from the
workstation, out to Anthropic), so heavy use is roughly 100–120 GB/month of
transfer, well inside the Lightsail allowance.

## Notes

- `GET /health` reports gateway and database status.
- `HEAD /api/hello` (Claude Code's startup check) is answered locally.
- Certificate renewal: `sudo certbot renew --dry-run` tests it; renewed
  certificates are picked up within an hour (`TLS_RELOAD_MINUTES`).
- Without `TLS_CERT_FILE`/`TLS_KEY_FILE` the gateway serves plain HTTP (useful
  for local testing). If you ever put a reverse proxy in front, set
  `TRUST_PROXY=1` so logs show the real client IP.
- The setup-token is valid for about a year; regenerate it before it expires,
  replace `secrets/setup-token`, and run `docker compose restart gateway`.
- To change the domain: update the DNS record, run
  `sudo ./deploy/setup-cert.sh <new-domain>`, and `docker compose restart`.
