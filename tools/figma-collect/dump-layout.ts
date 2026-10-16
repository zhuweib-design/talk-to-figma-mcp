// 把指定页面里命中关键字的容器原样打出来：布局方向、间距、两端对齐、子节点实测排布，
// 用来回答"这块空白到底是容器被撑高了，还是两端对齐把多余空间摊进了间距"。
// 用法：bun dump-layout.ts --dir pages --page 通知记录 --match card
//       bun dump-layout.ts --dir pages --page 异常识别 --match app-shell --kids
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const DIR = flag("dir", "pages");
const PAGE = flag("page", "");
const MATCH = flag("match", "");
const SHOW_KIDS = argv.includes("--kids");
const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : 0);
// 全扫描时收集"相邻空白最大"的容器，末尾统一排名
const WORST: any[] = [];
const SLACK: any[] = [];
let CURRENT_PAGE = "";
let SCANNED = 0;

const files = readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "components.json");

function describe(node: any, depth: number) {
  // 内部余量：容器自身尺寸减去子内容视觉末端，抓"底部一大片空白"
  const kidsAll = node.children || [];
  if (kidsAll.length) {
    const vEnd = Math.max(
      ...kidsAll.map((k: any) => Math.max(num(k.y) + num(k.height), num(k.x) + num(k.width)))
    );
    const vBottom = Math.max(...kidsAll.map((k: any) => num(k.y) + num(k.height)));
    const slackY = Math.round(num(node.height) - vBottom);
    if (num(node.height) >= 240 && slackY > 60)
      SLACK.push({
        page: CURRENT_PAGE,
        at: node.name || node.type,
        h: Math.round(num(node.height)),
        slackY,
        last: (kidsAll.slice().sort((a: any, b: any) => num(b.y) + num(b.height) - (num(a.y) + num(a.height)))[0] || {}).name || "?",
        pin: kidsAll.filter((k: any) => k.positionAbsolute).length,
        mode: (node.layout && node.layout.mode) || "NONE",
        align: (node.layout && node.layout.primaryAxisAlignItems) || "-",
      });
  }
  const all = (node.children || []).filter((k: any) => !k.positionAbsolute);
  if (all.length >= 2 && node.layout && node.layout.mode === "VERTICAL") {
    // 纯块级（NONE）容器也算：钉位布局同样有相邻空白，不因为没开自动布局就漏掉
    const ord = all.slice().sort((a: any, b: any) => num(a.y) - num(b.y));
    let g = 0,
      at = "";
    for (let i = 1; i < ord.length; i++) {
      const d = Math.round(num(ord[i].y) - (num(ord[i - 1].y) + num(ord[i - 1].height)));
      if (d > g) {
        g = d;
        at = `${ord[i - 1].name || ord[i - 1].type} → ${ord[i].name || ord[i].type}`;
      }
    }
    if (g > 24)
      WORST.push({
        page: CURRENT_PAGE,
        at: node.name || node.type,
        g,
        between: at,
        mode: node.layout.mode || "NONE",
        align: node.layout.primaryAxisAlignItems || "-",
        gap: node.layout.itemSpacing !== undefined ? node.layout.itemSpacing : "-",
        n: ord.length,
      });
  }
  for (const k of node.children || []) describe(k, depth + 1);
}

function describeDetail(node: any, depth: number) {
  const l = node.layout || {};
  const kids = node.children || [];
  const flow = kids.filter((k: any) => !k.positionAbsolute);
  const vertical = l.mode === "VERTICAL";
  const along = (k: any) => (vertical ? num(k.y) : num(k.x));
  const alongSize = (k: any) => (vertical ? num(k.height) : num(k.width));
  const cross = (k: any) => (vertical ? num(k.x) : num(k.y));
  // 流子里相邻的空白（按主轴排序后取最大）
  let maxGap = 0,
    gapAt = "";
  const ordered = flow.slice().sort((a: any, b: any) => along(a) - along(b));
  for (let i = 1; i < ordered.length; i++) {
    const g = along(ordered[i]) - (along(ordered[i - 1]) + alongSize(ordered[i - 1]));
    if (g > maxGap) {
      maxGap = Math.round(g);
      gapAt = `${ordered[i - 1].name || ordered[i - 1].type} → ${ordered[i].name || ordered[i].type}`;
    }
  }
  const flowEnd = flow.reduce((m: number, k: any) => Math.max(m, along(k) + alongSize(k)), 0);
  const visualEnd = kids.reduce((m: number, k: any) => Math.max(m, along(k) + alongSize(k)), 0);
  const own = vertical ? num(node.height) : num(node.width);
  // 子节点坐标是相对容器左上角、已经含内边距，所以余量直接拿容器尺寸减末端，不能再减一次内边距
  const align = l.primaryAxisAlignItems || "-";
  const gapSpec = l.itemSpacing !== undefined ? l.itemSpacing : "-";
  const wrap = l.layoutWrap && l.layoutWrap !== "NO_WRAP" ? ` wrap=${l.layoutWrap}` : "";
  console.log(
    `${"  ".repeat(depth)}${node.name || node.type} [${node.type}] ` +
      `${Math.round(num(node.width))}x${Math.round(num(node.height))} y=${Math.round(num(node.y))} ` +
      `mode=${l.mode || "NONE"} gap=${gapSpec} align=${align} cross=${l.counterAxisAlignItems || "-"}${wrap} ` +
      `子=${kids.length}(流${flow.length}) ` +
      `流末端=${Math.round(flowEnd)} 视觉末端=${Math.round(visualEnd)} 容器=${Math.round(own)} ` +
      `余量(流)=${Math.round(own - flowEnd)} 余量(视觉)=${Math.round(own - visualEnd)}` +
      (maxGap ? ` 最大相邻空白=${maxGap}（${gapAt}）` : "")
  );
  if (maxGap)
    WORST.push({
      page: CURRENT_PAGE,
      at: node.name || node.type,
      g: maxGap,
      between: gapAt,
      mode: l.mode || "NONE",
      align,
      gap: gapSpec,
      n: flow.length,
    });
  if (SHOW_KIDS) {
    for (const k of ordered.slice(0, 12))
      console.log(
        `${"  ".repeat(depth + 1)}· ${k.name || k.type} ${Math.round(num(k.width))}x${Math.round(num(k.height))} ` +
          `${vertical ? "y" : "x"}=${Math.round(along(k))}${k.positionAbsolute ? " [钉位]" : ""}${k.layoutSizingVertical ? " 尺寸" + k.layoutSizingVertical : ""}`
      );
    if (ordered.length > 12) console.log(`${"  ".repeat(depth + 1)}…还有 ${ordered.length - 12} 个`);
  }
  if (!SHOW_KIDS) for (const k of kids) if (k.children && k.children.length) describeDetail(k, depth + 1);
}

let hits = 0;
for (const f of files) {
  const p = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  const tree = p.tree;
  if (!tree) continue;
  const name = tree.name || f;
  // 页面名可以按文件名（英文 slug）筛，也可以按画板标题（中文）筛
  if (PAGE && !(f.includes(PAGE) || name.includes(PAGE))) continue;
  CURRENT_PAGE = name;
  SCANNED++;
  describe(tree, 0); // 不管哪种模式都先做一遍排名扫描
  if (!MATCH) {
    if (!argv.includes("--worst")) {
      console.log(`\n=== ${name}（整页布局树）===`);
      describeDetail(tree, 0);
    }
    hits++;
    continue;
  }
  const found: any[] = [];
  const collect = (n: any) => {
    const key = `${n.name || ""} ${n.type || ""}`;
    if (n.children && n.children.length && key.toLowerCase().includes(MATCH.toLowerCase())) found.push(n);
    for (const c of n.children || []) collect(c);
  };
  collect(tree);
  if (!found.length) continue;
  console.log(`\n=== ${name}：命中 ${found.length} 个"含 ${MATCH}"的容器 ===`);
  for (const n of found.slice(0, Number(flag("limit", "12")))) describeDetail(n, 0);
  hits++;
}
if (!hits && !argv.includes("--worst")) console.log(`没命中：目录 ${DIR}，页面 "${PAGE}"，关键字 "${MATCH}"`);

// 相邻空白排名：同一对图层名在很多页里重复出现，说明是同一个 CSS 规则的问题，不是偶发
WORST.sort((a, b) => b.g - a.g);
const RANK = Number(flag("rank", "25"));
console.log(`\n=== 相邻空白排名（扫 ${SCANNED} 页，共 ${WORST.length} 处，> 24px 才收，取前 ${RANK}）===`);
for (const w of WORST.slice(0, RANK))
  console.log(
    `  ${String(w.g).padStart(5)}px  ${w.mode}/${w.align} 声明gap=${w.gap} 子${w.n}  ${w.between}  ← ${w.at} @${String(w.page).slice(0, 16)}`
  );
const byPair = new Map<string, number>();
for (const w of WORST) byPair.set(w.between, (byPair.get(w.between) || 0) + 1);
console.log("\n=== 同一对图层重复出现的（次数 ≥ 3，指向同一条 CSS 规则）===");
for (const [k, v] of [...byPair.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
  if (v >= 3) console.log(`  ${v} 次  ${k}`);

// 容器内部余量排名：画板变高之后，是哪几层没跟着被内容填满
SLACK.sort((a, b) => b.slackY - a.slackY);
console.log(`\n=== 容器底部空白排名（容器高≥240 且内部空白>60，共 ${SLACK.length} 处，取前 ${RANK}）===`);
for (const s of SLACK.slice(0, RANK))
  console.log(
    `  空白 ${String(s.slackY).padStart(5)}px / 容器高 ${String(s.h).padStart(5)} ${s.mode}/${s.align} 钉位${s.pin}  ` +
      `${s.at}  最后子块=${String(s.last).slice(0, 28)}  @${String(s.page).slice(0, 16)}`
  );
const byName = new Map<string, number>();
for (const s of SLACK) byName.set(s.at, (byName.get(s.at) || 0) + 1);
console.log("\n=== 反复出现空白的容器类名（次数 ≥ 3）===");
for (const [k, v] of [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15))
  if (v >= 3) console.log(`  ${v} 页次  ${k}`);
