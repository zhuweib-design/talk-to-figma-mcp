// 画板版面体检：找出"画板比内容高出一截"和"容器被撑高后把多余空间摊进间距"的页面。
// 用法：bun audit-layout.ts [--dir pages-gas] [--tail 60] [--gap 40] [--top 15] [--like 通知记录,异常识别]
// 只做本地数据分析，不连 Figma，改抽取器前后都可以反复跑。
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const DIR = flag("dir", "pages");
const TAIL_LIMIT = Number(flag("tail", "60")); // 画板底部空白超过这个像素就列为可疑
const GAP_LIMIT = Number(flag("gap", "40")); // 相邻子块之间空白超过这个像素就报告
const TOP = Number(flag("top", "15"));
const LIKE = flag("like", "").split(",").filter(Boolean);

const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : 0);

// 绝对坐标：子节点的 y 是相对父节点的，逐层累加
function walk(node: any, ox: number, oy: number, out: any[]) {
  const x = ox + num(node.x);
  const y = oy + num(node.y);
  out.push({ node, x, y, bottom: y + num(node.height), right: x + num(node.width) });
  for (const c of node.children || []) walk(c, x, y, out);
}

function spaceBetweenCount(all: any[]) {
  return all.filter(
    (r) =>
      r.node.layout &&
      /SPACE_BETWEEN|SPACE_AROUND|EVENLY/.test(String(r.node.layout.primaryAxisAlignItems || ""))
  );
}

// 竖向自动布局里最大的相邻空白（用来回答"模块间距非常大"到底是谁和谁之间）
function biggestInnerGap(container: any) {
  const kids = (container.children || []).filter((k: any) => !k.positionAbsolute);
  if (kids.length < 2) return null;
  let worst = null as any;
  const ordered = kids.slice().sort((a: any, b: any) => num(a.y) - num(b.y));
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    const gap = num(cur.y) - (num(prev.y) + num(prev.height));
    if (gap > GAP_LIMIT && (!worst || gap > worst.gap)) {
      worst = { gap: Math.round(gap), between: `${prev.name || prev.type} → ${cur.name || cur.type}`, i };
    }
  }
  return worst;
}

const rows: any[] = [];
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && f !== "components.json")
  .filter((f) => !LIKE.length || LIKE.some((w: string) => f.includes(w)));

for (const f of files) {
  let p: any;
  try {
    p = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  } catch {
    continue;
  }
  const tree = p.tree;
  if (!tree) continue;
  const all: any[] = [];
  walk(tree, 0, 0, all);
  const H = num(tree.height);
  const contentBottom = all.reduce((m, r) => Math.max(m, r.node === tree ? 0 : r.bottom), 0);
  const tail = Math.round(H - contentBottom);
  const sb = spaceBetweenAll(all);
  // 容器自身的"底部余量"：容器高度减去子内容最低点，能抓出被撑高的卡片
  const stretched = all
    .filter((r) => r.node.children && r.node.children.length)
    .map((r) => {
      const kids = r.node.children.filter((k: any) => !k.positionAbsolute);
      if (!kids.length) return null;
      const kb = kids.reduce((m: number, k: any) => Math.max(m, num(k.y) + num(k.height)), 0);
      const slack = Math.round(num(r.node.height) - kb);
      return slack > TAIL_LIMIT
        ? { name: r.node.name || r.node.type, h: Math.round(num(r.node.height)), slack, gap: biggestInnerGap(r.node), absY: Math.round(r.y) }
        : null;
    })
    .filter(Boolean) as any[];
  stretched.sort((a, b) => b.slack - a.slack);
  const innerGaps = all
    .map((r) => (r.node.children && r.node.children.length ? biggestInnerGap(r.node) : null))
    .filter(Boolean) as any[];
  innerGaps.sort((a, b) => b.gap - a.gap);
  rows.push({
    file: f,
    name: tree.name || f,
    H: Math.round(H),
    tail,
    spaceBetween: sb,
    stretched: stretched.slice(0, 3),
    innerGaps: innerGaps.slice(0, 3),
  });
}

function spaceBetweenAll(all: any[]) {
  return all.filter((r) =>
    /SPACE_BETWEEN|SPACE_AROUND|EVENLY/.test(String((r.node.layout && r.node.layout.primaryAxisAlignItems) || ""))
  ).length;
}

rows.sort((a, b) => b.tail - a.tail);
const flagged = rows.filter((r) => r.tail > TAIL_LIMIT || r.stretched.length || r.innerGaps.length);

console.log(`扫描 ${files.length} 页（目录 ${DIR}），命中可疑 ${flagged.length} 页`);
console.log(`阈值：画板尾空 > ${TAIL_LIMIT}px，或容器余量 > ${TAIL_LIMIT}px，或相邻空白 > ${GAP_LIMIT}px\n`);

for (const r of rows.slice(0, TOP)) {
  const mark = r.tail > TAIL_LIMIT || r.stretched.length || r.innerGaps.length ? "可疑" : "正常";
  console.log(`[${mark}] ${r.name}`);
  console.log(`   画板高 ${r.H}，内容最低点距底 ${r.tail}px，两端对齐容器 ${r.spaceBetween} 个`);
  for (const s of r.stretched)
    console.log(`   容器余量：${s.name} 高 ${s.h} 内空 ${s.slack}${s.gap ? `（最大相邻空白 ${s.gap.gap}px：${s.gap.between}）` : ""}`);
  for (const g of r.innerGaps)
    if (!r.stretched.some((s: any) => s.gap && s.gap.between === g.between))
      console.log(`   相邻空白：${g.between} 之间 ${g.gap}px`);
}

const summary = {
  pages: rows.length,
  suspect: flagged.length,
  worstTail: rows[0] ? { name: rows[0].name, tail: rows[0].tail } : null,
  withSpaceBetween: rows.filter((r) => r.spaceBetween > 0).length,
  withStretched: rows.filter((r) => r.stretched.length > 0).length,
};
console.log("\n汇总:", JSON.stringify(summary));
