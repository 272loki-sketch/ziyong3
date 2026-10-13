#!/usr/bin/env bash
# Liyuan Agent — 一键安装（Linux）
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/272loki-sketch/ziyong3/main/deploy/install.sh | bash
#   bash install.sh [--dir /opt/liyuan] [--port 7620] [--repo URL] [--ref main] [--start]
#
# 环境变量（可选）：
#   LIYUAN_DIR   安装目录，默认 /opt/liyuan
#   LIYUAN_PORT  端口，默认 7620
#   LIYUAN_REF   git 标签/分支，默认 main
#   LIYUAN_REPO  仓库 URL，默认 https://github.com/272loki-sketch/ziyong3.git
set -euo pipefail

REPO_DEFAULT="https://github.com/272loki-sketch/ziyong3.git"
DIR="${LIYUAN_DIR:-/opt/liyuan}"
PORT="${LIYUAN_PORT:-7620}"
REF="${LIYUAN_REF:-main}"
REPO="${LIYUAN_REPO:-$REPO_DEFAULT}"
REPO_EXPLICIT="${LIYUAN_REPO:+1}"
SERVICE_NAME="${LIYUAN_SERVICE:-liyuan}"
DO_START=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --repo) REPO="$2"; REPO_EXPLICIT=1; shift 2 ;;
    --service) SERVICE_NAME="$2"; shift 2 ;;
    --start) DO_START=1; shift ;;
    --no-start) DO_START=0; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "[liyuan] unknown arg: $1"; exit 1 ;;
  esac
done

log() { echo "[liyuan] $*"; }
die() { echo "[liyuan] ERROR: $*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "需要命令: $1"
}

require_node_version() {
  command -v node >/dev/null 2>&1 || die "未找到 Node.js；请先安装 Node.js >= 22.19.0"
  local version major minor
  version="$(node -v 2>/dev/null || true)"
  version="${version#v}"
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+$ ]] || die "无法识别 Node.js 版本 '$version'；需要 >= 22.19.0"
  major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"
  if (( 10#$major < 22 || (10#$major == 22 && 10#$minor < 19) )); then
    die "Node.js $version 过旧；请先升级到 >= 22.19.0，再重新运行安装脚本"
  fi
  log "Node v$version OK (>= 22.19.0)"
}

need_cmd curl
need_cmd git
require_node_version
need_cmd npm

log "安装目录: $DIR"
log "版本/分支: $REF"
log "端口: $PORT"

mkdir -p "$(dirname "$DIR")"
if [[ -d "$DIR/.git" ]]; then
  STATUS="$(git -C "$DIR" status --porcelain --untracked-files=all 2>/dev/null)" \
    || die "无法核验已有仓库状态；停止安装"
  [[ -z "$STATUS" ]] || die "已有仓库包含 tracked/untracked 改动；请先自行处理，安装不会覆盖或清理"
  ORIGIN="$(git -C "$DIR" remote get-url origin 2>/dev/null)" \
    || die "无法核验已有仓库 origin；停止安装"
  [[ -n "$ORIGIN" ]] || die "已有仓库 origin 为空；停止安装"
  if [[ -n "$REPO_EXPLICIT" && "$ORIGIN" != "$REPO" ]]; then
    die "已有仓库 origin 与显式指定的仓库不一致；停止安装"
  fi
  log "已有 git 仓库，获取 $REF ..."
  git -C "$DIR" fetch --tags origin >/dev/null 2>&1 \
    || die "获取 origin 失败；停止安装"
  git -C "$DIR" checkout "$REF" >/dev/null 2>&1 \
    || git -C "$DIR" checkout "origin/$REF" >/dev/null 2>&1 \
    || die "无法切换到指定版本/分支；停止安装"
  # Tags and remote-only detached checkouts already point at the requested ref.
  if git -C "$DIR" symbolic-ref --quiet HEAD >/dev/null 2>&1; then
    git -C "$DIR" merge --ff-only "origin/$REF" >/dev/null 2>&1 \
      || die "分支无法快进到 origin 的指定版本；停止安装"
  fi
else
  if [[ -d "$DIR" ]] && [[ -n "$(ls -A "$DIR" 2>/dev/null || true)" ]]; then
    die "目录非空且不是 git 仓库: $DIR（请换目录或清空）"
  fi
  log "克隆指定仓库 ($REF) ..."
  git clone --depth 1 --branch "$REF" "$REPO" "$DIR" >/dev/null 2>&1 \
    || git clone --depth 1 "$REPO" "$DIR" >/dev/null 2>&1 \
    || die "克隆指定仓库失败；停止安装"
  git -C "$DIR" checkout "$REF" >/dev/null 2>&1 \
    || die "无法切换到指定版本/分支；停止安装"
fi

cd "$DIR"

if [[ ! -f liyuan.config.json && -f liyuan.config.example.json ]]; then
  cp liyuan.config.example.json liyuan.config.json
fi
if [[ ! -f liyuan.agent.json && -f liyuan.agent.example.json ]]; then
  cp liyuan.agent.example.json liyuan.agent.json
  log "已生成 liyuan.agent.json — 请填入 API Key"
fi

log "npm install ..."
npm install --omit=dev --no-audit --no-fund

if [[ ! -f web/dist/index.html ]]; then
  log "构建前端 ..."
  npm run web:build
fi

# systemd unit（可选，有权限时；服务名可用 --service 区分多实例）
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
if [[ "$(id -u)" -eq 0 ]] && command -v systemctl >/dev/null 2>&1; then
  log "写入 systemd: $UNIT"
  cat > "$UNIT" <<EOF
[Unit]
Description=Liyuan Agent (${SERVICE_NAME})
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=HOST=0.0.0.0
Environment=PORT=$PORT
ExecStart=$(command -v node) server/main.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}.service"
  if [[ "$DO_START" -eq 1 ]]; then
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${PORT}/tcp" 2>/dev/null || true
    fi
    systemctl restart "${SERVICE_NAME}.service"
    sleep 2
    systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
  fi
  log "管理: systemctl status|restart|stop ${SERVICE_NAME}"
else
  log "非 root 或无 systemd — 跳过服务注册"
  if [[ "$DO_START" -eq 1 ]]; then
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${PORT}/tcp" 2>/dev/null || true
    fi
    nohup env HOST=0.0.0.0 PORT="$PORT" node server/main.ts >>"$DIR/liyuan.log" 2>&1 &
    echo $! > "$DIR/liyuan.pid"
    log "已后台启动 PID=$(cat "$DIR/liyuan.pid") 日志 $DIR/liyuan.log"
  fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
log "完成。访问: http://${IP:-localhost}:$PORT"
log "配置 API: 编辑 $DIR/liyuan.agent.json"
