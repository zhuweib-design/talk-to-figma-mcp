// 建树性能与画面的对照量测：推一页 → 读回执统计 → 导出 PNG 比指纹。
// 用途是任何改动 buildNode 的优化都要同时回答两个问题：快了多少、画面有没有变。
// 用法：bun perf-compare.ts <pages/页面.json> [--base 基线.png] [--src 原型目录] [--library 库名] [--channel 名]
// 第一次不带 --base 跑，会把结果 PNG 存下来当基线；之后带上它做逐字节比对。
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { openFigma } from "./bridge.ts";

const argv = process.argv.slice(2);
const page = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
if (!page || !existsSync(page)) {
  console.error("用法：bun perf-compare.ts <pages/页面.json> [--base 基线.png] [--src 原型目录] [--library 库名]");
  process.exit(1);
}
const CHANNEL = flag("channel", "powerplant");
const BASE = flag("base", "");

const args = [process.execPath, join(import.meta.dir, "build-page.ts"), page, "--channel", CHANNEL];
for (const k of ["src", "library", "font", "name"]) {
  const v = flag(k, "");
  if (v) args.push("--" + k, v);
}

const wall0 = Date.now();
const proc = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
let text = "";
const dec = new TextDecoder();
for await (const chunk of proc.stdout as any) {
  const s = dec.decode(chunk, { stream: true });
  text += s;
  process.stdout.write(s);
}
await proc.exited;
const wall = Date.now() - wall0;

const line = text.split("\n").find((l) => l.startsWith("__RESULT__"));
if (!line) {
  console.error("没拿到 __RESULT__，无法统计");
  process.exit(1);
}
const r = JSON.parse(line.replace("__RESULT__", ""));
// msBuild 是所有内层分段的父项、msScan 在 elapsedMs 之外，两者都不能再进加总，
// 否则"未归属"会算成负数，看着像计时无效其实是加错了。
// msSelf 也是父项：它是"本节点自己耗的时间（不含子节点递归）"，整棵树加起来约等于 msBuild。
const OUTER = new Set(["msBuild", "msScan", "msSelf"]);
// 这三段在 msBuild 之外、elapsedMs 之内，算总缺口时要计入，算建树缺口时要剔除
const OUTSIDE_BUILD = new Set(["msColorMap", "msKern", "msHome"]);
const timed = Object.keys(r).filter((k) => /^ms[A-Z]/.test(k) && !OUTER.has(k));
const sum = timed.reduce((a, k) => a + (Number(r[k]) || 0), 0);
const innerSum = timed
  .filter((k) => !OUTSIDE_BUILD.has(k))
  .reduce((a, k) => a + (Number(r[k]) || 0), 0);

console.log("\n统计");
console.log("  墙钟耗时      ", (wall / 1000).toFixed(1), "秒");
console.log("  插件自报      ", (r.elapsedMs / 1000).toFixed(2), "秒  (msBuild " + r.msBuild + " 毫秒)");
console.log("  分段之和      ", sum, "毫秒  →  未归属", (r.elapsedMs || 0) - sum, "毫秒");
console.log("  建树缺口      ", (r.msBuild || 0) - innerSum, "毫秒  (msBuild − 建树内各分段之和)");
console.log("  自检 msSelf   ", r.msSelf ?? "无", "毫秒  (与 msBuild 接近说明计时已覆盖全部代码)");
console.log("  节点 / 实例   ", r.created, "/", r.instances ?? 0);
console.log("  钉位 pinned   ", r.pinned, "  ← 优化后这个数突变就是布局算错了");
console.log("  同名扫描 msScan", r.msScan, "毫秒 | 挂载 msMount", r.msMount ?? "无", "毫秒");
console.log("  画布核对      ", r.verified ? "通过" : "未确认", "| 子节点", r.childCount, "/", r.expectChildren);

// 分段按大小排出来，优化才有靶子；只看总耗时会把力气花在小段上
const rows = timed
  .map((k) => [k, Number(r[k]) || 0] as [string, number])
  .filter(([, v]) => v > 0)
  .sort((a, b) => b[1] - a[1]);
console.log("  分段耗时（从大到小）");
for (const [k, v] of rows) {
  const share = r.msBuild ? Math.round((v / r.msBuild) * 100) : 0;
  console.log("    " + k.padEnd(12), String(v).padStart(7), "毫秒", (share + "%").padStart(6));
}
const counters = ["ovrWalks", "ovrFonts", "tickSends", "instanceOverrides", "components", "fontFallback", "textShrunk"]
  .filter((k) => r[k] !== undefined);
if (counters.length) {
  console.log("  计数", counters.map((k) => k + "=" + r[k]).join("  "));
}

if (r.id) {
  const out = BASE && !existsSync(BASE) ? BASE : join(import.meta.dir, "perf-shot.png");
  const figma = await openFigma(CHANNEL);
  try {
    await figma.call("export_node_as_image", { nodeId: r.id, format: "PNG", scale: 1, out });
  } finally {
    figma.close();
  }
  const buf = readFileSync(out);
  let h = 0;
  for (const b of buf) h = (h * 31 + b) >>> 0;
  console.log("  画面指纹      ", "hash", h, "| 字节", buf.length, "|", out);
  if (BASE && existsSync(BASE)) {
    const base = readFileSync(BASE);
    const same = base.length === buf.length && base.equals(buf);
    console.log("  与基线比对    ", same ? "逐字节一致" : "有差异（可能只是节点 id 变了导致重排，需目测）");
  } else {
    console.log("  与基线比对    ", BASE ? "基线文件不存在，已把本次截图存到 " + BASE : "未给 --base，本次截图存为 perf-shot.png");
  }
}
process.exit(0);
