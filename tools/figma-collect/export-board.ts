// 画板导出：按名字或节点 id 把画板导成 PNG / JPG / SVG / PDF 落盘，换项目只改参数就能跑。
// 用法：bun export-board.ts <画板名或节点ID> [更多画板...] [--fmt png,jpg,svg] [--scale 2] [--quality 90] [--dir 导出目录] [--channel 名]
// 说明：
//   - 名字按包含匹配，命中多张就都导；id 形如 107:40696 直接用。
//   - 只在"当前页"里找名字（Figma 插件读不到别的页），要导别的项目先把 Figma 切到那一页。
//   - 同名文件直接覆盖，重跑不产生 second copy。
import { resolve } from "path";
import { openFigma } from "./bridge.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const targets = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--fmt" && argv[i - 1] !== "--scale" && argv[i - 1] !== "--quality" && argv[i - 1] !== "--dir" && argv[i - 1] !== "--channel");

if (!targets.length) {
  console.error('用法：bun export-board.ts <画板名或节点ID> [...] [--fmt png,jpg,svg] [--scale 2] [--quality 90] [--dir 目录]');
  process.exit(1);
}

const CHANNEL = flag("channel", "powerplant");
// 必须在这里就转成绝对路径：out 是发给 MCP 端落盘的，那个进程的当前目录是 fork 仓库，
// 直接传相对路径会把文件写到 cursor-talk-to-figma-mcp\exports 去（实测踩过）
const DIR = resolve(flag("dir", "exports"));
const SCALE = Number(flag("scale", "1")) || 1;
const QUALITY = Number(flag("quality", "92")) || 92;
// 扩展名与插件里的格式一一对应；位图才有倍率和画质
const EXT_FMT: Record<string, string> = { png: "PNG", jpg: "JPG", jpeg: "JPG", svg: "SVG", pdf: "PDF" };
const fmts = (flag("fmt", "png") + "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
for (const f of fmts) {
  if (!EXT_FMT[f]) {
    console.error(`不支持的格式 ${f}，可选：png jpg svg pdf`);
    process.exit(1);
  }
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
const ID_RE = /^\d+[:-]?\d+$/;

const figma = await openFigma(CHANNEL);
try {
  // 先取一次当前页的画板清单，名字匹配和归属分组都从这里读，省得每张画板都翻一遍页
  const scan: any = await figma.call("find_boards", { names: [] });
  const boards: any[] = scan.boards || [];
  console.log(`当前页：${scan.page}，画板 ${boards.length} 张`);

  const picked: any[] = [];
  for (const t of targets) {
    if (ID_RE.test(t)) {
      const id = t.replace("-", ":");
      const hit = boards.find((b) => b.id === id);
      picked.push(hit || { id, name: id, parentName: "" });
      continue;
    }
    const key = t.toLowerCase();
    const hits = boards.filter((b) => String(b.name || "").toLowerCase().includes(key));
    if (!hits.length) {
      console.log(`跳过：当前页找不到名字含「${t}」的画板（切到对应页再导，或直接给节点 id）`);
      continue;
    }
    picked.push(...hits);
  }
  if (!picked.length) {
    console.error("没有要导的画板");
    process.exit(1);
  }

  const rows: string[] = [];
  for (const b of picked) {
    for (const ext of fmts) {
      const out = `${DIR}/${safe(b.name)}.${ext}`;
      const args: Record<string, unknown> = { nodeId: b.id, format: EXT_FMT[ext], out };
      // 矢量格式没有倍率概念，插件端给了 constraint 会报错
      if (ext === "png" || ext === "jpg" || ext === "jpeg") args.scale = SCALE;
      if (ext === "jpg" || ext === "jpeg") args.quality = QUALITY;
      try {
        const r: any = await figma.call("export_node_as_image", args);
        rows.push(`  ${r.savedTo || out}  ${((r.bytes || 0) / 1024).toFixed(1)} KB  ${r.format || EXT_FMT[ext]}`);
      } catch (e: any) {
        rows.push(`  失败 ${safe(b.name)}.${ext}  ${e.message}`);
      }
    }
  }
  console.log(`\n已导出 ${rows.length} 个文件到 ${DIR}`);
  console.log(rows.join("\n"));
} finally {
  figma.close();
}
process.exit(0);
