// 本地体检：找出"文字宽度接近父内容盒"的节点，也就是 Figma 里可能被苹方顶出容器的文字。
// 插件端的兜底（先压字距、再缩字号）只登记宽度 >= 父内容盒 97% 的节点，这里把阈值降下来看漏网之鱼。
// 用法：bun audit-text-overflow.ts [--dir pages] [--ratio 0.97] [--top 20]
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DIR = flag("dir", "pages");
const RATIO = Number(flag("ratio", "0.97"));
const TOP = Number(flag("top", "20"));

const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : 0);

// 这四行刻意和插件端 buildNode 的算法保持一致，否则本地数和插件端对不上
function usableOf(node: any) {
  const l = node.layout || {};
  const pad = l.padding ? (l.padding.left || 0) + (l.padding.right || 0) : 0;
  const sw = node.stroke && node.stroke.weights
    ? (node.stroke.weights.left || 0) + (node.stroke.weights.right || 0)
    : node.stroke && node.stroke.weight ? node.stroke.weight * 2 : 0;
  return Math.max(0, (node.width || 0) - pad - sw);
}

const buckets = [0.7, 0.8, 0.85, 0.9, 0.95, 0.97];
const rows: any[] = [];
let total = 0;

for (const f of readdirSync(DIR).filter((x) => x.endsWith(".json") && x !== "components.json")) {
  let p: any;
  try {
    p = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  } catch {
    continue;
  }
  if (!p.tree) continue;
  let texts = 0;
  const counts = new Map<number, number>();
  let worst: any = null;
  const walk2 = (node: any, parentUsable: number) => {
    if (node.type === "text") {
      texts++;
      if (parentUsable > 4 && (node.width || 0) >= parentUsable * RATIO) {
        total++;
        const r = (node.width / parentUsable);
        if (!worst || r > worst.r) {
          worst = { r, w: Math.round(node.width * 100) / 100, usable: Math.round(parentUsable * 100) / 100, chars: String(node.text?.characters || "").slice(0, 18), fs: node.text?.fontSize };
        }
      }
      for (const b of buckets) {
        const i = Math.round(b * 100);
        if (parentUsable > 4 && (node.width || 0) >= parentUsable * b) counts.set(i, (counts.get(i) || 0) + 1);
      }
      return;
    }
    const my = usableOf(node);
    for (const c of node.children || []) walk2(c, my);
  };
  walk2(p.tree, p.tree.width);
  rows.push({ file: f.replace(/\.json$/, ""), name: p.tree.name, texts, worst, counts });
}

const hit = rows.filter((r) => r.worst);
hit.sort((a, b) => b.worst.r - a.worst.r);
console.log(`目录 ${DIR}，${rows.length} 页，阈值 ${RATIO}`);
console.log(`命中 ${hit.length} 页，累计候选文字 ${total} 个\n`);
for (const r of hit.slice(0, TOP)) {
  const c = r.counts;
  console.log(`${r.name}`);
  console.log(`   文字 ${r.texts} 个，最紧张一条：宽 ${r.worst.w} / 可用 ${r.worst.usable}（${r.worst.r.toFixed(3)}），${r.worst.fs}px「${r.worst.chars}」`);
  console.log(`   各阈值命中：70% ${c.get(70) || 0} / 80% ${c.get(80) || 0} / 85% ${c.get(85) || 0} / 90% ${c.get(90) || 0} / 95% ${c.get(95) || 0} / 97% ${c.get(97) || 0}`);
}
console.log(`\n全目录阈值合计：`, JSON.stringify({
  at70: rows.reduce((a, r) => a + (r.counts.get(70) || 0), 0),
  at80: rows.reduce((a, r) => a + (r.counts.get(80) || 0), 0),
  at85: rows.reduce((a, r) => a + (r.counts.get(85) || 0), 0),
  at90: rows.reduce((a, r) => a + (r.counts.get(90) || 0), 0),
  at95: rows.reduce((a, r) => a + (r.counts.get(95) || 0), 0),
  at97: rows.reduce((a, r) => a + (r.counts.get(97) || 0), 0),
}));

