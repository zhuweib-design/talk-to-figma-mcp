// 用新 SVG 原地替换图表节点：数据变化后重新生成 SVG，再调这条即可保留原位置和尺寸。
// 用法：bun redraw-chart.ts <节点ID> <新SVG文件> [--name 名字] [--no-bind] [--channel powerplant]
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { openFigma } from "./bridge.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const values = new Set(["--name", "--channel"]);
const pos = argv.filter((a, i) => !a.startsWith("--") && !values.has(argv[i - 1]));
const nodeId = pos[0];
const svgFile = pos[1] ? resolve(pos[1]) : "";
if (!nodeId || !svgFile || !existsSync(svgFile)) {
  console.error("用法：bun redraw-chart.ts <节点ID> <新SVG文件> [--name 名字] [--no-bind] [--channel powerplant]");
  process.exit(1);
}
const svg = readFileSync(svgFile, "utf8");
if (!/<svg[\s>]/i.test(svg)) {
  console.error(`不像 SVG 文件：${svgFile}`);
  process.exit(1);
}
const channel = flag("channel", "powerplant");
const name = flag("name", "");
const bindVariables = !argv.includes("--no-bind");
const figma = await openFigma(channel);
try {
  const result: any = await figma.call("replace_node_with_svg", { nodeId, svg, name: name || undefined, bindVariables });
  console.log(`已替换 ${result.replaced} -> ${result.id}  ${result.width}x${result.height}  补绑 ${result.bound} 处`);
} finally {
  figma.close();
}
process.exit(0);
