#!/bin/bash
# macOS: 双击本文件；终端: bash start.command
set -euo pipefail

# 从任意工作目录启动，都使用脚本所在的项目。
REVIEW_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$REVIEW_ROOT"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

on_exit() {
  local result=$?
  if [ "$result" -ne 0 ]; then
    printf '\n启动失败，请查看上面的错误信息。\n'
    if [ -t 0 ]; then
      read -r -p '按回车键关闭窗口…' || true
    fi
  fi
  exit "$result"
}
trap on_exit EXIT

# Finder 打开的终端不一定已加载 nvm。
if ! command -v node >/dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # nvm 内部不保证兼容 nounset。
  set +u
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use --silent || true
  set -u
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '未找到 Node.js/npm，请先安装 Node.js 24 LTS，再重新运行此脚本。\n'
  exit 1
fi
node --input-type=module -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (!((major === 22 && minor >= 13) || major === 24 || major >= 26)) {
  console.error(`当前 Node.js ${process.versions.node} 不受支持，请使用 Node.js 24 LTS。`);
  process.exit(1);
}
'

export PORT="${PORT:-3001}"
# 提前给出端口冲突提示，避免启动到一半才发现已有服务。
node --input-type=module -e '
import net from "node:net";
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT 必须是 1—65535 的整数。");
  process.exit(1);
}
const server = net.createServer();
server.on("error", error => {
  console.error(error.code === "EADDRINUSE"
    ? `端口 ${port} 已被占用。请关闭之前启动的服务，或用 PORT=3002 bash start.command 换一个端口。`
    : `无法监听本机端口：${error.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => server.close());
'

printf '\n审图台 · 一键启动\n项目目录：%s\n\n' "$REVIEW_ROOT"
if ! npm ls --depth=0 --silent >/dev/null 2>&1; then
  printf '[1/4] 安装项目依赖（首次运行需要联网）…\n'
  npm ci
else
  printf '[1/4] 项目依赖已就绪。\n'
fi
printf '\n[2/4] 初始化数据库（保留已有标注）…\n'
npm run db:setup
printf '\n[3/4] 构建前端和后端…\n'
npm run build
printf '\n[4/4] 启动服务。请在浏览器打开：http://127.0.0.1:%s\n' "$PORT"
printf '请保持此终端窗口开启；按 Control+C 停止整个项目。\n\n'
# 生产入口在同一端口提供前端页面和后端 API。
exec npm start
