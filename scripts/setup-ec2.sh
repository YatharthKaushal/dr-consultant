#!/usr/bin/env bash
#
# One-shot EC2 bootstrap: Postgres + Redis + self-hosted LiveKit via Docker,
# then builds and starts THIS backend directly on the host (not containerized
# — see the "why the backend isn't in Docker" note below).
#
# USAGE
#   Run this FROM THE ROOT OF THE CLONED BACKEND REPO on a fresh EC2 instance:
#     chmod +x scripts/setup-ec2.sh
#     ./scripts/setup-ec2.sh
#
#   Safe to re-run. Already-generated secrets in .env are never overwritten —
#   only genuinely missing ones are filled in, the same idempotent posture
#   every seed script in this repo already uses.
#
# WHAT THIS DOES NOT DO, ON PURPOSE
#   - Does not fill in SLIDE_API_KEY / SLIDE_OTP_WIDGET_ID (your OTP vendor
#     account) or the three RAZORPAY_* keys (your payment gateway account).
#     There is no way to generate a real third-party credential — these MUST
#     be entered by hand. The script writes clearly marked placeholders and
#     refuses to claim victory until they're filled in.
#   - Does not create the CloudFront distribution or open security-group
#     ports for you, unless you pass --with-aws-automation AND this instance
#     already has AWS credentials/an IAM role that can do it. Otherwise it
#     prints the exact commands/console steps and moves on — a half-failed
#     AWS API call mid-script is worse than a clear instruction afterward.
#   - Does not containerize the backend itself. Compiling this app's native
#     dependencies inside a fresh Docker build on ARM64, unverified against
#     your exact box, is exactly the kind of thing that fails in ways a
#     script can't preemptively catch. Postgres/Redis/LiveKit are commodity,
#     pre-built images with no such risk — the app itself runs as a normal
#     Node process under pm2, which is simpler to see, log into, and fix.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WITH_AWS_AUTOMATION=false
RUN_DEMO_SEED=false
for arg in "$@"; do
  case "$arg" in
    --with-aws-automation) WITH_AWS_AUTOMATION=true ;;
    --with-demo-seed) RUN_DEMO_SEED=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Config — the only knobs you're likely to want to change before running.
# ---------------------------------------------------------------------------
BACKEND_PORT="${BACKEND_PORT:-3000}"
POSTGRES_DB="${POSTGRES_DB:-dr_consultation}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
RTC_PORT_RANGE_START=50000
RTC_PORT_RANGE_END=50100

log()  { printf '\n\033[1;34m>>> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m!!! %s\033[0m\n' "$1" >&2; }
die()  { printf '\033[1;31mFATAL: %s\033[0m\n' "$1" >&2; exit 1; }

# Explicit if/then/else, not `A && B || C` — if the app is already registered
# and `pm2 reload` itself fails for a real operational reason, `A && B || C`
# would silently fall through to `pm2 start` and could leave a duplicate
# process entry registered under the same name.
start_or_reload_backend() {
  if pm2 describe backend >/dev/null 2>&1; then
    pm2 reload backend
  else
    pm2 start dist/main.js --name backend
  fi
}

[ -f "package.json" ] && grep -q '"nest build"' package.json \
  || die "Run this from the root of the cloned backend repo (package.json with 'nest build' not found here)."

# ---------------------------------------------------------------------------
# 1. OS packages: docker, docker compose plugin, node 20, pm2, openssl, jq
# ---------------------------------------------------------------------------
log "Checking/installing OS packages"

# Deliberately does NOT ask apt/dnf for a "docker compose plugin" package.
# The plugin only reliably ships from Docker's own official apt/yum repo,
# which this script does not add; Ubuntu/Amazon Linux's default repos either
# lack that package outright or carry a version out of step with the distro
# release. Rather than guess at a package name that will break on the next
# OS release, engine install is unconditional, and the compose plugin is
# ALWAYS handled uniformly by the direct-binary fallback below, for both
# branches, every time.
if command -v dnf >/dev/null 2>&1; then
  PKG_INSTALL="sudo dnf install -y"
  sudo dnf install -y docker curl jq openssl >/dev/null
elif command -v apt-get >/dev/null 2>&1; then
  PKG_INSTALL="sudo apt-get install -y"
  sudo apt-get update -y >/dev/null
  sudo apt-get install -y docker.io curl jq openssl >/dev/null
else
  die "Neither dnf nor apt-get found — this script supports Amazon Linux and Ubuntu. Install docker/curl/jq/openssl yourself and re-run."
fi

if ! docker compose version >/dev/null 2>&1; then
  # Neither distro's plain engine package (docker / docker.io) bundles the
  # compose plugin, and it's deliberately not requested from apt/dnf above —
  # see that block's own comment. Downloaded directly from Docker's GitHub
  # releases instead, which works identically regardless of distro/version.
  #
  # Installed to the SYSTEM-WIDE plugin path, not ~/.docker/cli-plugins —
  # deliberately. Whether this script ends up invoking `docker` directly or
  # `sudo docker` (decided just below, based on whether this shell's group
  # membership has actually taken effect yet) isn't known at this point in a
  # fresh run, and `sudo docker compose` looks for plugins under ROOT's home,
  # not the invoking user's — a plugin dropped into ~/.docker/cli-plugins
  # here would be invisible to it. /usr/local/lib/docker/cli-plugins is one
  # of Docker CLI's own documented plugin search paths and is checked for
  # every user, root included, so this is correct either way.
  log "Installing the docker compose plugin"
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  ARCH="$(uname -m)"
  case "$ARCH" in
    aarch64|arm64) COMPOSE_ARCH="aarch64" ;;
    x86_64) COMPOSE_ARCH="x86_64" ;;
    *) die "Unsupported architecture for docker compose plugin: $ARCH" ;;
  esac
  curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${COMPOSE_ARCH}" \
    | sudo tee /usr/local/lib/docker/cli-plugins/docker-compose >/dev/null
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

sudo systemctl enable --now docker
if ! groups "$USER" | grep -q docker; then
  sudo usermod -aG docker "$USER"
  warn "Added $USER to the docker group for future convenience — that only takes effect on your NEXT login, though, so this run uses sudo for every docker command instead of waiting for it."
fi

# A freshly-added group membership never applies to the current shell, so
# deciding this once, up front, based on whether the socket is ACTUALLY
# reachable right now (rather than trusting `groups` or hoping) is what makes
# the very first run work without a re-login.
if docker info >/dev/null 2>&1; then
  DOCKER="docker"
else
  DOCKER="sudo docker"
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//;s/\..*//')" -lt 20 ]; then
  log "Installing Node.js 20"
  curl -fsSL https://rpm.nodesource.com/setup_20.x 2>/dev/null | sudo bash - >/dev/null 2>&1 \
    || curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
  $PKG_INSTALL nodejs >/dev/null
fi
node -v

if ! command -v pm2 >/dev/null 2>&1; then
  log "Installing pm2"
  sudo npm install -g pm2 >/dev/null
fi

# ---------------------------------------------------------------------------
# 2. Detect the instance's public IPv4 (IMDSv2) — used as a fallback
#    LIVEKIT_URL and printed for the CloudFront/security-group steps.
# ---------------------------------------------------------------------------
log "Detecting public IP via the EC2 metadata service"
IMDS_TOKEN="$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" || true)"
PUBLIC_IP="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  "http://169.254.169.254/latest/meta-data/public-ipv4" || true)"
PUBLIC_DNS="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  "http://169.254.169.254/latest/meta-data/public-hostname" || true)"
[ -n "$PUBLIC_IP" ] && echo "Public IP:  $PUBLIC_IP" || warn "Could not read public IP from IMDS — not running on EC2, or IMDS is blocked."
[ -n "$PUBLIC_DNS" ] && echo "Public DNS: $PUBLIC_DNS (use this as the CloudFront origin domain)"

# ---------------------------------------------------------------------------
# 3. .env — generate what can be safely auto-generated, never touch what's
#    already set, loudly flag what still needs a real external credential.
# ---------------------------------------------------------------------------
log "Preparing .env"
ENV_FILE="$REPO_ROOT/.env"
touch "$ENV_FILE"

# Reads an existing value for KEY out of .env, empty string if absent/blank.
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
# Sets KEY=VALUE in .env: replaces an existing (possibly blank) line, or appends.
env_set() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s#^${key}=.*#${key}=${value}#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}
# Only fills KEY if it's currently missing or blank — the idempotency rule.
env_set_if_blank() {
  local key="$1" value="$2"
  [ -n "$(env_get "$key")" ] && return 0
  env_set "$key" "$value"
}

POSTGRES_PASSWORD="$(env_get POSTGRES_PASSWORD)"
if [ -z "$POSTGRES_PASSWORD" ]; then
  POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  env_set POSTGRES_PASSWORD "$POSTGRES_PASSWORD"   # not read by the app itself — kept so this script stays idempotent
fi

env_set_if_blank DATABASE_URL "postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
env_set_if_blank PORT "$BACKEND_PORT"
env_set_if_blank NODE_ENV "production"

env_set_if_blank JWT_ACCESS_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
env_set_if_blank JWT_REFRESH_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
env_set_if_blank AI_CREDENTIAL_ENCRYPTION_KEY "$(openssl rand -hex 32)"

# --- LiveKit keys: generate once via the real binary, reuse on every re-run ---
LIVEKIT_API_KEY="$(env_get LIVEKIT_API_KEY)"
LIVEKIT_API_SECRET="$(env_get LIVEKIT_API_SECRET)"
if [ -z "$LIVEKIT_API_KEY" ] || [ -z "$LIVEKIT_API_SECRET" ]; then
  log "Generating LiveKit API key/secret"
  KEYS_OUTPUT="$($DOCKER run --rm livekit/livekit-server generate-keys)"
  LIVEKIT_API_KEY="$(echo "$KEYS_OUTPUT" | grep -i 'API Key:' | awk '{print $NF}')"
  LIVEKIT_API_SECRET="$(echo "$KEYS_OUTPUT" | grep -i 'API Secret:' | awk '{print $NF}')"
  [ -n "$LIVEKIT_API_KEY" ] && [ -n "$LIVEKIT_API_SECRET" ] || die "Could not parse LiveKit generate-keys output:\n$KEYS_OUTPUT"
  env_set LIVEKIT_API_KEY "$LIVEKIT_API_KEY"
  env_set LIVEKIT_API_SECRET "$LIVEKIT_API_SECRET"
fi

# LIVEKIT_URL needs wss:// through a real TLS front door (CloudFront, per the
# setup this was designed against) — that domain doesn't exist until you've
# done the CloudFront step by hand (or via --with-aws-automation below). Until
# then this is a plain ws:// placeholder that will NOT work from a real
# browser or mobile app (they refuse insecure signaling) — it's here only so
# the app boots and you can test LiveKit's HTTP port directly if you want to.
env_set_if_blank LIVEKIT_URL "ws://${PUBLIC_IP:-CHANGE_ME}:7880"

for placeholder_key in SLIDE_API_KEY SLIDE_OTP_WIDGET_ID RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET; do
  env_set_if_blank "$placeholder_key" "CHANGE_ME"
done

# ---------------------------------------------------------------------------
# 4. docker-compose.yml + livekit.yaml — generated fresh every run so they
#    always match the current .env (secrets are the only thing preserved,
#    via the .env idempotency above, not by hand-editing these two files).
# ---------------------------------------------------------------------------
log "Writing docker-compose.yml and livekit.yaml"

cat > "$REPO_ROOT/docker-compose.yml" <<EOF
# Generated by scripts/setup-ec2.sh — re-running the script regenerates this
# file. Hand edits here will be lost; change .env or the script instead.
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    network_mode: host
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    network_mode: host
    volumes:
      - redis-data:/data
    # Nothing in this backend reads Redis yet (grep the codebase — there is no
    # REDIS_* env var). Included because it was asked for and it's zero-cost
    # to have running for whatever uses it later (a job queue, a cache).

  livekit:
    image: livekit/livekit-server:latest
    command: --config /etc/livekit.yaml
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro

volumes:
  postgres-data:
  redis-data:
EOF

cat > "$REPO_ROOT/livekit.yaml" <<EOF
# Generated by scripts/setup-ec2.sh — re-running the script regenerates this
# file from .env's LIVEKIT_API_KEY/SECRET.
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: ${RTC_PORT_RANGE_START}
  port_range_end: ${RTC_PORT_RANGE_END}
  use_external_ip: true

keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}

webhook:
  api_key: ${LIVEKIT_API_KEY}
  urls:
    - http://127.0.0.1:${BACKEND_PORT}/api/video/webhook

turn:
  enabled: true
  udp_port: 3478
EOF

# ---------------------------------------------------------------------------
# 5. Bring up Postgres, Redis, LiveKit; wait for Postgres to actually accept
#    connections before touching it.
# ---------------------------------------------------------------------------
log "Starting Postgres, Redis and LiveKit"
$DOCKER compose up -d

log "Waiting for Postgres"
for i in $(seq 1 30); do
  $DOCKER compose exec -T postgres pg_isready -U "$POSTGRES_USER" >/dev/null 2>&1 && break
  [ "$i" -eq 30 ] && die "Postgres never became ready — check: $DOCKER compose logs postgres"
  sleep 2
done
echo "Postgres is ready."

# ---------------------------------------------------------------------------
# 6. Build the backend and run migrations. The app is NOT started yet if any
#    required secret is still a placeholder — see the gate below.
# ---------------------------------------------------------------------------
log "Installing dependencies and building"
npm ci

# *** MUST run before every build, not just the first. ***
# tsconfig.json has "incremental": true, and nest-cli.json's own
# "deleteOutDir": true only wipes dist/ — it does NOT touch this separate
# root-level cache file. TypeScript's incremental mode decides whether to
# re-emit based on whether SOURCE files changed since the timestamps this
# file recorded, not on whether dist/ still exists. So the second time this
# script runs npm run build with no source changes in between, tsc reads a
# still-valid cache, concludes "nothing to recompile," and silently emits
# NOTHING — even though deleteOutDir just wiped dist clean seconds earlier.
# `nest build` reports success (exit 0) either way, so this fails silently
# until something downstream (pm2, here) tries to run a dist/main.js that
# was never written. A one-shot deploy script has no legitimate use for
# incremental caching ACROSS separate invocations of itself — only within
# one long-running dev watch session — so it's removed before every build,
# guaranteeing a full, honest compile every single run.
rm -f tsconfig.build.tsbuildinfo tsconfig.tsbuildinfo

npm run build
[ -f "dist/main.js" ] || die "nest build reported success but dist/main.js does not exist — this should be impossible now that the incremental cache is cleared first. Check: npx nest build (run directly, not through this script) for the real error."

log "Running database migrations"
npm run db:migrate

MISSING_REQUIRED=()
for required_key in SLIDE_API_KEY SLIDE_OTP_WIDGET_ID RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET; do
  [ "$(env_get "$required_key")" = "CHANGE_ME" ] && MISSING_REQUIRED+=("$required_key")
done
[ "$(env_get LIVEKIT_URL)" = "ws://CHANGE_ME:7880" ] && MISSING_REQUIRED+=("LIVEKIT_URL (public IP could not be auto-detected)")

if [ "$RUN_DEMO_SEED" = true ] && [ "${#MISSING_REQUIRED[@]}" -eq 0 ]; then
  log "Seeding reference data + demo data"
  npm run db:seed
  npm run db:seed:demo
elif [ "$RUN_DEMO_SEED" = true ]; then
  warn "Skipping seed — fill in the required secrets listed below first, then run manually: npm run db:seed && npm run db:seed:demo"
fi

# ---------------------------------------------------------------------------
# 7. Optional: attempt the AWS-side pieces (security group + CloudFront) —
#    only if explicitly requested AND this instance can actually call AWS.
# ---------------------------------------------------------------------------
if [ "$WITH_AWS_AUTOMATION" = true ]; then
  log "Attempting AWS automation (--with-aws-automation)"
  if command -v aws >/dev/null 2>&1 && aws sts get-caller-identity >/dev/null 2>&1; then
    INSTANCE_ID="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)"
    SG_ID="$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
      --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)"
    echo "Opening ports on security group $SG_ID (ignoring 'already exists' errors)..."
    aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 7880 --cidr 0.0.0.0/0 2>/dev/null || true
    aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port 7881 --cidr 0.0.0.0/0 2>/dev/null || true
    aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol udp --port "${RTC_PORT_RANGE_START}-${RTC_PORT_RANGE_END}" --cidr 0.0.0.0/0 2>/dev/null || true
    aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol udp --port 3478 --cidr 0.0.0.0/0 2>/dev/null || true
    echo "Security group ports opened. CloudFront distribution creation is NOT automated here"
    echo "(it needs a several-minute deploy-and-poll loop) — follow the console steps in the"
    echo "setup guide, using ${PUBLIC_DNS:-<this instance public DNS name>} as the origin, port 7880, HTTP only."
  else
    warn "aws CLI not found or not authenticated — skipping. Run 'aws configure' or attach an IAM instance role with ec2:AuthorizeSecurityGroupIngress, then re-run with --with-aws-automation."
  fi
fi

# ---------------------------------------------------------------------------
# 8. Start (or reload) the backend under pm2 — only if it can actually run.
# ---------------------------------------------------------------------------
if [ "${#MISSING_REQUIRED[@]}" -eq 0 ]; then
  log "Starting the backend under pm2"
  start_or_reload_backend
  pm2 save
  echo "Backend running under pm2 as 'backend'. 'pm2 startup' once, following its printed instructions, to survive a reboot."
else
  warn "NOT starting the backend yet — required secrets are still placeholders (listed below). It would only crash-loop on boot."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log "Done. Summary:"
echo "  Postgres, Redis, LiveKit: running via docker compose ($DOCKER compose ps to check)."
echo "  Generated and written to .env: POSTGRES_PASSWORD, DATABASE_URL, JWT_ACCESS_SECRET,"
echo "  JWT_REFRESH_SECRET, AI_CREDENTIAL_ENCRYPTION_KEY, LIVEKIT_API_KEY, LIVEKIT_API_SECRET."
echo
if [ "${#MISSING_REQUIRED[@]}" -gt 0 ]; then
  warn "STILL REQUIRED before this app can actually boot and take a real call/payment/OTP:"
  for k in "${MISSING_REQUIRED[@]}"; do echo "    - $k"; done
  echo
  echo "  Fill these into .env by hand, then run:"
  echo "    ./scripts/setup-ec2.sh   (safe to re-run — it will not touch secrets already set, and will start the backend once every required value above is real)"
else
  echo "  All required secrets are set. Backend is up."
fi
echo
echo "  LIVEKIT_URL is currently: $(env_get LIVEKIT_URL)"
echo "  Once you've created the CloudFront distribution (see the setup guide — origin"
echo "  ${PUBLIC_DNS:-<this box public DNS name>}, port 7880, HTTP only), update LIVEKIT_URL to"
echo "  wss://<your-distribution>.cloudfront.net in .env and reload: pm2 reload backend"
