# 实际验证记录

日期：2026-10-30，时区 Asia/Shanghai。环境：macOS Apple Silicon、Node.js 26.5.1、npm 11.17.0。仓库要求支持 Node 24 LTS；本机没有切换到 Node 24，Linux/Node 24 的 GitHub Actions 配置已经提供，远程 CI 结果需以 GitHub 实际运行为准。

## 已执行

| 命令 | 实际结果 |
| --- | --- |
| `npm install` | 安装完成并生成 lockfile；初次下载约 9 分钟 |
| `npm run typecheck` | Vue 与 API TypeScript 类型检查通过 |
| `npm test` | Vitest 5.0.5，2 个文件、25 项测试通过（最终业务测试约 0.41 秒） |
| `npm run db:setup` | 初始化演示操作人和两张原创演示图片成功 |
| `npm run build` | Vite 生产构建和后端 tsc 编译成功 |
| `E2E_BROWSER_CHANNEL=chrome npm run test:e2e` | 使用本机 Chrome 独立临时配置，8 项浏览器测试通过（约 7.4 秒，含生产构建启动） |
| `npm run test:smoke` | 临时文件 SQLite、跨工作目录生产启动、初始化幂等、重启恢复、清空后重启均通过 |
| `npm audit` / 安装修复后审计 | sharp 升级到 0.35.5、Vitest 升级到 5.0.5 后报告 0 vulnerabilities |

自动化运行需要开启本机监听端口。此工作环境沙箱会拒绝监听，因此实际 HTTP、浏览器和重启验证在获得工具授权后执行。第一次沙箱内 HTTP 测试曾因 `listen EPERM` 失败，它是执行环境限制，不是持久化验证通过的证据。

端到端覆盖：落点→保存→刷新、50%/200%下坐标与真实API值一致、滚动、清空、500保留→恢复重试、真实提交但响应丢失→核对成功、双页面409、原人保存后切人、切人保存失败时留在原人、他人后续修改后核对冲突、已有点与留白不新增、空说明校验、视口中心缩放锚点、窗口适应宽度与至少24px命中区域、编辑框可见。

SQLite/HTTP/单元覆盖：写入中途回滚 revision 与批注及历史、跨图 UUID 拒绝、未变历史保留、删除编号重排不变更修改人、清空、重复 ID、坐标边界与类型、Unicode 500/501、100×500中文字请求、损坏上传无半条记录、原始10MiB限制、EXIF方向和元数据、输出体积、2000万像素入口限制、真实两帧WebP动画拒绝。处理后输出超限测试调用同一处理函数并将独立输出上限注入为1字节，避免提交巨大随机素材；这验证分支，不声称真实生成过10MiB以上的重编码图片。

## 可复现的主动失败

```bash
npm ci
npx playwright install chromium
npm run test:e2e -- --grep '主动注入500'
```

已有 Chrome 可用 `E2E_BROWSER_CHANNEL=chrome npm run test:e2e -- --grep '主动注入500'`。

仅拦截 `PUT /api/images/:id/annotations`，返回 `500 {code:"SIMULATED_SAVE_FAILURE",message:"验证用保存失败"}`。预期页面「保存失败」，说明「失败后也不能丢失」保留在草稿，不能显示已保存。实际断言通过，见 [故障截图](save-failure.png)。移除拦截后重新保存，刷新仍能看到原文，证明恢复分支访问了真实后端与SQLite。测试通过说明故障处理正确，不是跳过故障。

事务回滚另由 `tests/service.test.ts` 中注入 `INJECTED_AFTER_FIRST_WRITE` 的真实 SQLite 用例证明；响应丢失用例先 `route.fetch()` 完成真实 PUT，再 `route.abort()` 丢弃响应，检查 revision 只增长一次。

## 开发中真实发现并修复的问题

1. **SQL参数数量错误。** 首次服务测试报 `table annotations has 10 columns but 11 values were supplied`，6项失败。修为显式列名与10个占位符后，真实数据库保存与回滚测试通过。
2. **刷新回到默认图。** 首轮浏览器测试2项失败，保存长图后刷新显示海报0条，实际长图数据没有丢失。增加URL `?image=图片ID` 并在初始化时读取，刷新恢复当前图片；不会把批注业务数据存到浏览器。
3. **编辑框被长图挤出工作区。** 新增可视区域断言捕获 `viewport ratio 0`。为grid行设置 `minmax(0,1fr)`，将canvas的 `min-height` 归零并限制内部溢出。复跑窗口缩放、编辑框可见及全套流程通过。见 [工作区截图](workspace.png)。

这些是真实发生过的本次开发问题；500是主动故障注入，性质不同。

## 同步BLOB写入测量

`npm run measure`：8次10MiB BLOB同步插入内存SQLite，样本约 `[14.06, 6.42, 7.22, 9.18, 5.58, 6.28, 8.34, 5.40]` ms，最大约14.06ms。只说明这台机器的同步SQL调用耗时，**不含图片解码、磁盘I/O或真实并发负载**，不能作为生产延迟承诺。脚本素材是测量用字节，不是有效业务图片，不经过公开上传API。

## 安装与远程交付

2026-10-31 在无 node_modules、无数据库的干净本地克隆中复验，`npm ci`（使用本机 npm 下载缓存，约2秒）、初始化、类型检查、25项单元/集成测试、生产构建、文件库重启验证、8项浏览器测试全部通过。完整输出见 [干净克隆日志](clean-run.log)。这是同机干净克隆验证，不代表已在另一台机器或Linux上执行。复现命令为 `node scripts/verify-clean.mjs`，它验证当前已提交的代码，默认使用本机Chrome；可通过 `E2E_BROWSER_CHANNEL` 选择已安装的Playwright浏览器。

远程推送结果以最终提交说明和远程分支核对为准。GitHub网页公开访问HTTP 200，远程读取无分支，确认初始为空仓库。仓库链接由用户提供；本次聊天已回复链接，不声称已替用户向作业接收方发送消息。

### 2026-10-31 远程推送阻塞

已执行 `git push -u origin main`，以及显式HTTP/1.1和低速超时重试，均未收到推送成功确认。实际错误包括 `Operation too slow. Less than 1 bytes/sec transferred the last 20 seconds`；远程只读核对也报 `Failed to connect to github.com port 443`。最后 `curl -I --connect-timeout 10 --max-time 20` 检查同一仓库网页，10秒连接超时。因此不能确认远程分支或CI状态，不能声称已上传。

代码、完整验证日志及交付文档已保存在本地Git提交中。网络恢复后在项目根目录执行 `git push -u origin main`，若GitHub提示认证，再使用有仓库写入权限的本机Git凭据完成。此前公开网页HTTP200及空仓库检查发生于2026-10-30，不代表当前网络连通。
