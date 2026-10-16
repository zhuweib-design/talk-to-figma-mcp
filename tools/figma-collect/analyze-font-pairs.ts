// 字号与字重配对分析的报告端，逻辑都在 font-pairs.ts。
// 用法：bun analyze-font-pairs.ts <项目目录>
import { analyzeFontPairs, styleNameForWeight } from "./font-pairs.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("用法：bun analyze-font-pairs.ts <项目目录>");
  process.exit(1);
}

const profiles = analyzeFontPairs(dir);
const head = ["字号 token", "像素", "默认字重", "苹方档位", "变体(≥3次)", "字重分布", "示例选择器"];
const rows: string[][] = [head];

for (const p of profiles) {
  rows.push([
    p.token,
    p.px ? `${p.px}px` : "?",
    String(p.base),
    styleNameForWeight(p.base),
    p.variants.length ? p.variants.join(" / ") : "-",
    p.uses.map((u) => `${u.weight}:${u.count}${u.declared ? "" : "(继承)"}`).join("  "),
    p.uses[0]?.samples[0] || "",
  ]);
}

const widths = head.map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)) + 2);
for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(widths[i])).join(""));
console.log(`\n共 ${profiles.length} 个字号，将建 ${profiles.reduce((a, p) => a + 1 + p.variants.length, 0)} 个文字样式`);
