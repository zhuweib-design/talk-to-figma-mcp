// 对账：本地抽好的页面 vs 画布上实际画板，列出"没推 / 推的是旧数据（高度对不上）"的页面。
// 用法：bun check-pushed.ts [--dir pages-gas] [--channel powerplant] [--out 待推清单.txt]
// 批次中途断连、失败重试、只推了部分页之后要收尾，都靠这个把差额找出来，不用翻日志。
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { openFigma } from "./bridge.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const DIR = flag("dir", "pages");
const CHANNEL = flag("channel", "powerplant");
const OUT = flag("out", "");

const figma = await openFigma(CHANNEL);
let boards: any[] = [];
try {
  const r: any = await figma.call("find_boards", { names: [] });
  boards = r.boards || [];
  console.log(`画布页：${r.page}，画板 ${boards.length} 张`);
} finally {
  figma.close();
}

const local = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f !== "components.json")
  .map((f) => {
    const p = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    return { slug: f.replace(/\.json$/, ""), name: p.tree?.name || "", h: Number(p.tree?.height) || 0, nodes: Number(p.stats?.nodes) || 0 };
  })
  .filter((x) => x.name);

// 同名多张（历史上堆出来的重复）也算异常
const byName = new Map<string, any[]>();
for (const b of boards) byName.set(b.name, [...(byName.get(b.name) || []), b]);

const missing: any[] = [];
const stale: any[] = [];
const dup: any[] = [];
for (const l of local) {
  const hit = byName.get(l.name);
  if (!hit || !hit.length) {
    missing.push(l);
    continue;
  }
  if (hit.length > 1) dup.push({ ...l, count: hit.length });
  if (Math.abs(hit[0].height - l.h) > 1) stale.push({ ...l, canvasH: hit[0].height });
}

console.log(`\n本地 ${local.length} 页：缺 ${missing.length} 页，高度对不上（画布还是旧数据）${stale.length} 页，重复画板 ${dup.length} 页`);
const show = (arr: any[], label: string) => {
  if (!arr.length) return;
  console.log(`\n${label}：`);
  for (const x of arr) console.log(`  ${x.slug.padEnd(22)} 本地高 ${x.h}${x.canvasH ? ` / 画布高 ${x.canvasH}` : ""}${x.count ? ` / 画板 ${x.count} 张` : ""}`);
};
show(missing, "没推上去");
show(stale, "画布是旧数据，需要重推");
show(dup, "同名画板不止一张");

const need = [...new Set([...missing, ...stale].map((x) => x.slug))];
if (OUT) {
  writeFileSync(OUT, need.join(" "), "utf8");
  console.log(`\n待推清单已写入 ${OUT}（${need.length} 页）`);
}
console.log(`\n一条命令补完：bun build-batch.ts --dir ${DIR} --src <原型目录> --library "<组件库名>" --by-nodes ${need.join(" ")}`);
process.exit(0);
