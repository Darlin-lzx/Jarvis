#!/usr/bin/env bash
# ============================================================================
# 数据库国产化迁移智能编排平台 —— 一键部署脚本
#
# 用法:
#   ./deploy.sh                 # 完整部署并前台启动后端
#   ./deploy.sh --build-front   # 部署前先重新构建前端 (web-ui/dist)
#   ./deploy.sh --daemon        # 完整部署并以后台 nohup 方式启动
#   ./deploy.sh --skip-build    # 跳过前端构建（使用已有 web-ui/dist）
#   ./deploy.sh --help          # 查看全部参数
#
# 说明:
#   - 使用项目内 .venv（不存在则自动创建）
#   - Python 依赖: requirements.txt + 缺失的 faiss-cpu / numpy / pymysql
#   - 数据库: 依据 config.yaml 的 mysql_url —— 非空则自动建 MySQL 库，
#     留空则用 SQLite（首次启动自动建表）
#   - 自动导入 data/seed/*.json 种子数据
#   - 安全: 部署脚本不写死任何密钥，LLM api_key 直接沿用 config.yaml
# ============================================================================
set -euo pipefail

# ---------- 基础路径 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------- 参数 ----------
BUILD_FRONT=0
DAEMON=0
SKIP_BUILD=0
PORT=""

print_help() {
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

for arg in "$@"; do
    case "$arg" in
        --build-front) BUILD_FRONT=1 ;;
        --daemon)      DAEMON=1 ;;
        --skip-build)  SKIP_BUILD=1 ;;
        --help|-h)     print_help ;;
        --port=*)      PORT="${arg#*=}" ;;
        *) echo "未知参数: $arg (用 --help 查看用法)" >&2; exit 1 ;;
    esac
done

# ---------- 颜色输出 ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()   { echo -e "${RED}[deploy][错误]${NC} $*"; }

# ---------- 工具函数 ----------
command_exists() { command -v "$1" >/dev/null 2>&1; }

fail() { err "$*"; exit 1; }

# ---------- 1. 环境检查 ----------
info "检查基础环境 ..."
command_exists python3 || fail "未找到 python3，请先安装 Python 3.11+"
command_exists npm  || fail "未找到 npm，请先安装 Node.js 18+（前端构建需要）"

PYTHON_BIN="python3"
if [ -x ".venv/bin/python" ]; then
    PYTHON_BIN=".venv/bin/python"
    info "复用已有 .venv (Python $($PYTHON_BIN --version 2>&1 | awk '{print $2}'))"
else
    info "创建 .venv ..."
    python3 -m venv .venv
    PYTHON_BIN=".venv/bin/python"
fi

# ---------- 2. 安装后端依赖 ----------
info "安装 Python 依赖 (requirements.txt) ..."
"$PYTHON_BIN" -m pip install --upgrade pip -q
"$PYTHON_BIN" -m pip install -r requirements.txt -q

info "补齐 requirements.txt 缺失但运行必需的依赖 (faiss-cpu/numpy/pymysql) ..."
"$PYTHON_BIN" -m pip install faiss-cpu numpy pymysql -q

# ---------- 3. 前端构建 ----------
if [ "$SKIP_BUILD" -eq 1 ]; then
    info "跳过前端构建（使用现有 web-ui/dist）"
elif [ "$BUILD_FRONT" -eq 1 ]; then
    info "构建前端 (web-ui/dist) ..."
    ( cd web-ui && npm install && npm run build )
else
    if [ -f "web-ui/dist/index.html" ]; then
        info "web-ui/dist 已存在，跳过构建（如需重新构建请加 --build-front）"
    else
        warn "未找到 web-ui/dist，自动构建前端 ..."
        ( cd web-ui && npm install && npm run build )
    fi
fi

# ---------- 4. 数据库准备 ----------
MYSQL_URL="$(grep -E '^mysql_url:' config.yaml | sed -E 's/^mysql_url:[[:space:]]*"([^"]*)".*/\1/')"

if [ -n "$MYSQL_URL" ] && [[ "$MYSQL_URL" != '""' ]]; then
    # 从 mysql_url 解析 主机/端口/用户/密码/库名
    # 格式: mysql+pymysql://user:pass@host:port/dbname
    MYSQL_PARSED="${MYSQL_URL#mysql+pymysql://}"
    MYSQL_CRED="${MYSQL_PARSED%%@*}"
    MYSQL_HOSTPORT="${MYSQL_PARSED#*@}"
    MYSQL_HOSTPORT="${MYSQL_HOSTPORT%%/*}"
    MYSQL_DB="${MYSQL_PARSED##*/}"
    MYSQL_HOST="${MYSQL_HOSTPORT%%:*}"
    MYSQL_PORT="${MYSQL_HOSTPORT##*:}"
    MYSQL_USER="${MYSQL_CRED%%:*}"
    MYSQL_PASS="${MYSQL_CRED#*:}"

    info "检测到 MySQL 配置: ${MYSQL_USER}@${MYSQL_HOST}:${MYSQL_PORT} 库 ${MYSQL_DB}"

    if command_exists mysql; then
        if mysql -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_USER" -p"$MYSQL_PASS" \
               -e "CREATE DATABASE IF NOT EXISTS \`$MYSQL_DB\` DEFAULT CHARACTER SET utf8mb4;" 2>/dev/null; then
            info "MySQL 数据库就绪: $MYSQL_DB"
        else
            warn "无法自动连接 MySQL（凭据/主机不可达）。请手动执行:"
            warn "  CREATE DATABASE IF NOT EXISTS \`$MYSQL_DB\` DEFAULT CHARACTER SET utf8mb4;"
        fi
    else
        warn "未安装 mysql 客户端，跳过自动建库。请手动创建库 $MYSQL_DB（后端启动时自动建表）。"
    fi
else
    info "使用 SQLite 作为业务库 (db_path: data/db.sqlite3)，首次启动自动建表"
fi

# ---------- 5. 导入种子数据 ----------
info "导入种子数据 (data/seed) ..."
"$PYTHON_BIN" run_seed.py || warn "种子数据导入失败（若库中已有数据可忽略）"

# ---------- 6. 启动 ----------
HOST="$(grep -E '^host:' config.yaml | awk '{print $2}')"
CFG_PORT="$(grep -E '^port:' config.yaml | awk '{print $2}')"
[ -n "$PORT" ] && CFG_PORT="$PORT"
[ -z "$HOST" ] && HOST="0.0.0.0"

info "启动后端: $HOST:$CFG_PORT"
CMD=("$PYTHON_BIN" run.py)

if [ "$DAEMON" -eq 1 ]; then
    LOG_DIR="logs"; mkdir -p "$LOG_DIR"
    LOG_FILE="$LOG_DIR/deploy_$(date +%Y%m%d_%H%M%S).log"
    nohup "${CMD[@]}" >"$LOG_FILE" 2>&1 &
    PID=$!
    sleep 2
    if kill -0 "$PID" 2>/dev/null; then
        info "后端已在后台启动 (PID=$PID)，日志: $LOG_FILE"
        info "访问: http://$HOST:$CFG_PORT"
        echo "$PID" > "$LOG_DIR/server.pid"
    else
        err "后端启动失败，请查看日志: $LOG_FILE"
        exit 1
    fi
else
    info "前台启动中，Ctrl+C 停止。访问: http://$HOST:$CFG_PORT"
    exec "${CMD[@]}"
fi
