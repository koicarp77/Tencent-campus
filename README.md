# 审图台 · Review Desk

一个可本地运行的图片批注工具：点击问题位置、输入说明、显式保存，再次打开恢复。Vue 3 + TypeScript / Node.js + TypeScript / 本地 SQLite（包括图片二进制）。

## 环境与启动

推荐 Node.js 24 LTS（`.nvmrc`），npm 10+。本次实际环境为 macOS / Node 26.5.1 / npm 11.17.0。

```bash
npm ci
npm run db:setup
npm run dev
```

打开 http://127.0.0.1:5173。开发 API 为 http://127.0.0.1:3001，Vite 将 `/api` 代理到它。开发模式请保持 API 端口为默认值。

生产运行（同一个端口提供页面和 API）：

```bash
npm run db:setup
npm run build
npm start
```

打开 http://127.0.0.1:3001。`PORT` 可修改生产端口，`DB_FILE` 可指定绝对数据库路径；默认 `data/review.sqlite`，不依赖启动工作目录。服务只监听本机，演示操作人不提供身份认证。已有批注不会被重复执行的 `db:setup` 清空。

## 使用

1. 默认内置品牌海报与商品长图，可切换图片，也可上传 PNG、JPEG、静态 WebP。
2. 点击图片添加一个标记，右侧输入 1—500 个字符的说明。点列表可滚动定位，点圆点只选择。
3. 适应宽度、50%、100%、200% 均可标注，100% 为原始像素尺寸。
4. 点击「保存标注」（或 Cmd/Ctrl+S），等待「已保存」，刷新验证恢复。每图最多 100 个标记；支持修改说明、删除及清空全部。
5. 切图或切人有草稿时，选择保存后切换、放弃、取消。保存后切人使用原操作人身份。
6. 冲突时先复制本地说明，再自行决定加载最新版本；加载会明确询问是否放弃草稿。网络中断后先自动核对服务端，核对失败可点击「重新核对结果」。

文件原始大小和处理后大小均限制 10MiB，解码限制 2000 万像素。真实格式校验、拒绝动画、统一 EXIF 方向并剥离元数据，入库宽高来自最终二进制。

## 检查与失败复现

```bash
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run test:smoke  # 先完成 npm run build；检查真实文件库重启恢复
```

如本机已有 Chrome，可用 `E2E_BROWSER_CHANNEL=chrome npm run test:e2e` 跳过 Chromium 下载。本次端到端测试使用独立临时配置的本机 Chrome。

`test:e2e` 自行创建临时 SQLite、分配独立端口、初始化数据、构建并启动生产服务，不需要手工启动应用。单 worker，每个用例开始前重置临时数据；重置脚本有临时目录与标记校验，不能重置开发库。Playwright 关闭服务后，外层启动器删除临时目录。

只运行可复现的保存失败用例：

```bash
npm run test:e2e -- --grep '主动注入500'
```

该用例只将 PUT 保存请求拦截成 500，验证草稿保留及失败提示，然后解除拦截，真实写入 SQLite 并刷新确认。测试通过代表应用正确处理了主动注入的故障，不代表没有发生故障。另有真实事务中途抛错回滚测试和真实提交后丢弃响应测试。执行记录见 [验证记录](docs/verification/RESULTS.md)。

## 目录

- `apps/web/src`：Vue 界面、草稿状态机、坐标换算。
- `apps/api/src`：Express API、图片解码、事务保存、SQLite 表结构与幂等种子数据。
- `packages/shared/src`：共享业务类型、Unicode 长度与快照比较。
- `tests`：真实 SQLite 集成、草稿单元测试和 Playwright 流程。
- `scripts`：初始化与隔离测试生命周期。
- `SUBMISSION.md`：产品取舍、解题过程、AI 协作与交付限制。

## 常见问题

- 缺少初始化提示：先执行 `npm run db:setup`，确保启动与初始化使用相同 `DB_FILE`。
- 端口占用：关闭旧进程；e2e 不复用已有服务。生产可设置 `PORT`。
- 安装原生依赖失败：使用 Node 24 LTS；better-sqlite3 若无预编译包，需要系统 C++ 构建环境（macOS Command Line Tools）。
- Chromium 缺失：先执行 `npx playwright install chromium`。
- 页面显示无法连接服务：开发模式检查 API 3001 进程；生产先构建再 `npm start`。
- 本地草稿在刷新/关闭时可能丢失；退出提醒无法保证浏览器崩溃时恢复，请显式保存。数据库备份应在服务关闭后复制 SQLite 文件，或使用 SQLite 备份工具。
