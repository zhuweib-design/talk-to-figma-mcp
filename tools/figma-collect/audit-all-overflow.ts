// 全项目文字溢出体检：逐画板调用插件端的 audit_text_overflow，汇总还剩多少处顶出容器。
// 用法：bun audit-all-overflow.ts [--channel powerplant] [--minOver 0.5] [--top 15] [--dump 溢出明细.json]
import { openFigma } from "./bridge.ts";
import { writeFileSync } from "fs";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const CHANNEL = flag("channel", "powerplant");
const MIN_OVER = Number(flag("minOver", "0.5"));
const TOP = Number(flag("top", "15"));
const DUMP = flag("dump", "");

const figma = await openFigma(CHANNEL);
try {
  const r: any = await figma.call("find_boards", { names: [] });
  const boards = (r.boards || []).filter((b: any) => b.type === "FRAME");
  console.log(`画布页：${r.page}，待体检画板 ${boards.length} 张\n`);

  const rows: any[] = [];
  const all: any[] = [];
  let scanned = 0;
  let overflow = 0;
  for (const b of boards) {
    let res: any = null;
    try {
      res = await figma.call("audit_text_overflow", { nodeId: b.id, minOver: MIN_OVER, top: 5000 });
    } catch (e) {
      console.log(`  ${b.name}：体检失败 ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    scanned += res.scanned || 0;
    overflow += res.overflow || 0;
    for (const w of res.worst || []) all.push({ board: b.name, ...w });
    rows.push({ name: b.name, id: b.id, scanned: res.scanned || 0, overflow: res.overflow || 0, worst: (res.worst || [])[0] || null });
  }

  // 幅度分布：能一眼看出还剩多少是"肉眼明显"的
  const buckets = [
    [0.5, 1], [1, 2], [2, 4], [4, 8], [8, 1e9],
  ];
  console.log(`体检文字 ${scanned} 个，仍顶出容器（超过 ${MIN_OVER}px）${overflow} 处\n`);
  console.log("溢出幅度分布：");
  for (const [lo, hi] of buckets) {
    const n = all.filter((x) => x.over >= lo && x.over < hi).length;
    const label = hi > 1e8 ? `>= ${lo}px` : `${lo} - ${hi}px`;
    console.log(`  ${label.padEnd(12)} ${n}`);
  }

  // 按父元素样式类归类：残留集中在少数几类就说明是特定组件的处理问题
  const byParent = new Map<string, number>();
  for (const x of all) {
    const k = x.parentName || "(无)";
    byParent.set(k, (byParent.get(k) || 0) + 1);
  }
  const topParents = [...byParent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log("\n残留最多的父元素（前 12）：");
  for (const [k, n] of topParents) console.log(`  ${String(n).padStart(4)}  ${k}`);

  rows.sort((a, b) => b.overflow - a.overflow);
  const dirty = rows.filter((x) => x.overflow > 0);
  console.log(`\n仍有溢出的画板 ${dirty.length} 张，前 ${TOP} 张：`);
  for (const x of dirty.slice(0, TOP)) {
    const w = x.worst;
    console.log(`  ${String(x.overflow).padStart(3)} 处  ${x.name}`);
    if (w) console.log(`           最严重 ${w.over}px「${w.chars}」(${w.fs}px, 父 ${w.parentName})`);
  }

  if (DUMP) {
    writeFileSync(DUMP, JSON.stringify(all, null, 2), "utf8");
    console.log(`\n完整明细已写入 ${DUMP}（${all.length} 条）`);
  }
} finally {
  figma.close();
}
process.exit(0);