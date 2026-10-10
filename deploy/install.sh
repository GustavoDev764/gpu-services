#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/gpu-services
STATE_DIR=/var/lib/gpu-services
ENV_FILE=/etc/gpu-services.env
TORCH_INDEX=${TORCH_INDEX:-https://download.pytorch.org/whl/cu128}
API_PORT=${API_PORT:-8000}
LAMA_URL=https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt
DETECTOR_ID=ogkalu/comic-text-and-bubble-detector
SRC=$(cd "$(dirname "$0")/.." && pwd)

if [ "$(id -u)" -ne 0 ]; then
  echo "rode com sudo" >&2
  exit 1
fi

echo "==> pacotes do sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -q
apt-get install -y -q redis-server python3-venv python3-dev curl ca-certificates rsync openssl
if ! command -v node >/dev/null || ! node -v | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi

echo "==> usuário e pastas"
id gpu >/dev/null 2>&1 || useradd --system --home "$STATE_DIR" --shell /usr/sbin/nologin gpu
mkdir -p "$APP_DIR" "$STATE_DIR/data" "$STATE_DIR/hf"
if [ "$SRC" != "$APP_DIR" ]; then
  rsync -a --delete --exclude node_modules --exclude worker/.venv --exclude data --exclude models --exclude .env --exclude dist "$SRC/" "$APP_DIR/"
fi

echo "==> API (Node)"
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund

echo "==> worker (Python + torch CUDA)"
[ -x worker/.venv/bin/python ] || python3 -m venv worker/.venv
worker/.venv/bin/pip install -q --upgrade pip
worker/.venv/bin/pip install -q torch torchvision --index-url "$TORCH_INDEX"
worker/.venv/bin/pip install -q -r worker/requirements.txt

echo "==> modelos"
mkdir -p models
[ -s models/big-lama.pt ] || curl -fL --retry 3 -o models/big-lama.pt "$LAMA_URL"
if [ ! -s models/detector/config.json ]; then
  HF_HOME="$STATE_DIR/hf" worker/.venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('$DETECTOR_ID', local_dir='models/detector')"
fi

echo "==> redis"
REDIS_CONF=/etc/redis/redis.conf
sed -i -E 's/^#?\s*appendonly .*/appendonly yes/; s/^#?\s*appendfsync .*/appendfsync everysec/; s/^#?\s*bind .*/bind 127.0.0.1 -::1/' "$REDIS_CONF"
systemctl enable --now redis-server
systemctl restart redis-server

echo "==> configuração"
if [ ! -f "$ENV_FILE" ]; then
  IP=$(curl -fsS --max-time 5 https://api.ipify.org || echo 127.0.0.1)
  cat > "$ENV_FILE" <<CONF
ADMIN_KEY=$(openssl rand -hex 24)
REDIS_URL=redis://127.0.0.1:6379
REDIS_DB=0
DATA_DIR=$STATE_DIR/data
API_HOST=0.0.0.0
API_PORT=$API_PORT
PUBLIC_URL=${PUBLIC_URL:-http://$IP:$API_PORT}
LAMA_MODEL=$APP_DIR/models/big-lama.pt
DETECTOR_MODEL=$APP_DIR/models/detector
HF_HOME=$STATE_DIR/hf
HF_HUB_OFFLINE=1
DEVICE=auto
DECODE_THREADS=2
TORCH_THREADS=2
CONF
  chmod 640 "$ENV_FILE"
  chgrp gpu "$ENV_FILE"
  echo "ADMIN_KEY gerada em $ENV_FILE"
fi
chown -R gpu:gpu "$STATE_DIR"
chown -R root:gpu "$APP_DIR"
chmod -R g+rX "$APP_DIR"

echo "==> serviços"
install -m 644 deploy/gpu-api.service /etc/systemd/system/gpu-api.service
install -m 644 deploy/gpu-worker.service /etc/systemd/system/gpu-worker.service
systemctl daemon-reload
systemctl enable gpu-api gpu-worker
systemctl restart gpu-api gpu-worker

echo "==> pronto: curl http://127.0.0.1:8000/health"
