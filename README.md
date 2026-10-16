# talk-to-figma-mcp

Figma 原型转稿管线的本地改造版：MCP 服务、WebSocket 中继、Figma 开发版插件，以及把 HTML 原型
还原成 Figma 画板的一批脚本。基于上游 [grab/cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp)
（commit `ddd90f3`）改造，插件端多出 17 条上游没有的命令。

## 目录

| 路径 | 内容 |
| --- | --- |
| `tools/figma-bridge` | MCP 服务、WebSocket 中继（3055）、控制台页、Figma 插件 |
| `tools/figma-collect` | 抽取与推送脚本（`extractor.js`、`batch-extract.js`、`build-page.ts`、`check-pushed.ts` 等） |
| `adapters/figma-pipeline` | Windows 下的启动与停止脚本（常驻、端口避让、停止标记） |

## 插件端新增的命令

`list_fonts`、`set_font_family`、`set_text_auto_resize`、`create_local_style`、
`create_variable_collection`、`bind_fill_to_variable`、`bind_stroke_to_variable`、`set_variable_mode`、
`create_layer_tree`、`make_component`、`instantiate_component`、`apply_theme`、`read_node_paints`、
`find_boards`、`list_export_targets`、`component_usage`、`import_svg`

## 跑起来

1. 装 bun（`npm install -g bun`），然后在 `tools/figma-bridge` 里 `bun install`。
2. 起中继：`bun run src/socket.ts`（默认端口 3055）。浏览器打开 `http://127.0.0.1:3055/` 就是控制台页，
   能看哪些客户端连着、每条命令耗时、推送进度与运行日志。
3. 在 Figma 里 Plugins → Development → Link existing plugin，选
   `tools/figma-bridge/src/cursor_mcp_plugin/manifest.json`，运行插件并加入频道。
   插件界面的频道名固定显示 `powerplant` 才是这份改造版，出现随机串说明 link 错了。
4. 起收集服务：在 `tools/figma-collect` 里 `bun collect-server.ts --port 8768 --pages-dir pages-gas`。
   它给浏览器提供 `extractor.js` 与 `batch-extract.js`，并把抽到的页面树落成 `pages-gas/<页面名>.json`。
5. 抽取：在浏览器里打开你的原型页，控制台粘一行
   `__FIGMA_BATCH(["页面A", "页面B"], { width: 1920, height: 1080, components: true, dir: "pages-gas" })`。
6. 推送：在 `tools/figma-collect` 里 `bun build-page.ts pages-gas/页面A.json --channel powerplant`。
   整站按 `build-batch.ts`，推完用 `check-pushed.ts` 对账（缺页、旧页、同名重复都会列出来）。

## 需要你按本机改的地方

- 脚本与批处理里的 `<你的用户名>`、`%USERPROFILE%` 是原来写死的本机绝对路径，clone 后要换成你自己的目录。
- `.mcp.json` 指向上游发布包；要用本仓库这份，把 command 指向
  `tools/figma-bridge/src/talk_to_figma_mcp/server.ts`。
- 改过 `code.js` 或 `ui.html` 必须在 Figma 里把插件关掉重开一次才生效；只改 `server.ts` 不用。

## 本仓库不包含

各项目抽出来的页面树、导出图与历史快照（属于具体项目的数据），以及内部开发文档与测试用例。
