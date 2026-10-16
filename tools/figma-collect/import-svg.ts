// SVG 导入：把本地 .svg 文件送进 Figma 当前页，可当成一张画板导入。换项目只改参数就能跑。
// 用法：bun import-svg.ts <文件或目录> [...] [--board] [--name 名字] [--scale 1.5] [--x 0 --y 0] [--parent 节点ID] [--no-bind] [--channel 名]
// 说明：
//   - 插件沙箱读不到硬盘，所以由这个脚本把文件内容读出来经中继发给插件（MCP 端也有 filePath 一条，走 AI 时用那个）。
//   - --board 会在外面套一层固定尺寸的画框，名字、裁剪、分组、重推都跟管线建出来的画板一致；不给就只是普通矢量组。
//   - 不给 --x/--y 就落在当前视口中心，并且把视口挪过去，方便目测。
//   - 颜色按色值反查补绑到变量（同名变量才绑），--no-bind 关掉。
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { openFigma } from "./bridge.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

if (!argv.length || argv[0].startsWith("--")) {
  console.error("用法：bun import-svg.ts <文件或目录> [...] [--board] [--name 名字] [--scale n] [--x n --y n] [--parent 节点ID] [--no-bind]");
  process.exit(1);
}

const VALUES = ["--name", "--scale", "--x", "--y", "--parent", "--channel"];
const inputs = argv.filter((a, i) => !a.startsWith("--") && !VALUES.includes(argv[i - 1]));

// 目录就收全部 .svg，按名字排序保证多次运行的顺序一致
const files: string[] = [];
for (const p of inputs) {
  const abs = resolve(p);
  if (!existsSync(abs)) {
    console.error(`文件不存在：${abs}`);
    process.exit(1);
  }
  if (statSync(abs).isDirectory()) {
    for (const f of readdirSync(abs).filter((f) => f.toLowerCase().endsWith(".svg")).sort()) {
      files.push(join(abs, f));
    }
  } else {
    files.push(abs);
  }
}
if (!files.length) {
  console.error("没有可导入的 svg");
  process.exit(1);
}

const CHANNEL = flag("channel", "powerplant");
const asBoard = has("board");
const bind = !has("no-bind");
const scale = flag("scale", "") ? Number(flag("scale")) : undefined;
const hasXY = flag("x", "") !== "" && flag("y", "") !== "";
const x = hasXY ? Number(flag("x")) : undefined;
const y = hasXY ? Number(flag("y")) : undefined;
const parentId = flag("parent", "") || undefined;

const figma = await openFigma(CHANNEL);
let ok = 0;
try {
  for (const f of files) {
    const svg = readFileSync(f, "utf8");
    if (!/<svg[\s>]/i.test(svg)) {
      console.log(`跳过：${basename(f)} 不像 svg 文件`);
      continue;
    }
    // 一张画板一个名字：多文件时用文件名，避免全叫同一个名字后推的顶掉先推的
    const name = files.length === 1 && flag("name") ? flag("name") : flag("name") ? `${flag("name")} · ${basename(f).replace(/\.svg$/i, "")}` : basename(f).replace(/\.svg$/i, "");
    const args: Record<string, unknown> = { svg, name, asBoard, bindVariables: bind };
    if (scale !== undefined) args.scale = scale;
    if (hasXY) {
      args.x = x;
      args.y = y;
    }
    if (parentId) args.parentId = parentId;
    try {
      const r: any = await figma.call("import_svg", args);
      ok++;
      console.log(
        `已导入 ${name} → ${r.id}  ${r.width}x${r.height}  ${r.type}  位置 ${Math.round(r.x)},${Math.round(r.y)}  分组「${r.parentName}」  补绑变量 ${r.bound} 处  ${r.elapsedMs} 毫秒`
      );
    } catch (e: any) {
      console.log(`失败 ${name}：${e.message}`);
    }
  }
  console.log(`\n共 ${files.length} 个文件，成功 ${ok}`);
  if (ok && !hasXY) console.log("视口已经挪到导入的位置，可以直接目测");
} finally {
  figma.close();
}
process.exit(ok === files.length ? 0 : 1);
