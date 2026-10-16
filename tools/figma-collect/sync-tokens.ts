// 设计变量同步器：把任意前端项目的 CSS 自定义属性同步成 Figma 的变量和样式。
// 用法：bun sync-tokens.ts <项目目录> [--channel powerplant] [--collection 名称] [--font 字体名]
// 换项目只改目录参数即可，主题块数量和名字自动识别。
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { openFigma } from "./bridge.ts";
import { analyzeFontPairs, styleNameForWeight } from "./font-pairs.ts";

// ---------- 命令行 ----------
const argv = process.argv.slice(2);
const dir = argv[0];
if (!dir) {
  console.error("用法: bun sync-tokens.ts <项目目录> [--channel 名字] [--collection 名字] [--font 字体]");
  process.exit(1);
}
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const CHANNEL = flag("channel", "powerplant");
const COLLECTION = flag("collection", "设计变量");
const DEFAULT_FONT = flag("font", "PingFang SC");
// 样式名前缀：同一个 Figma 文件里放多个项目时必给，
// 否则第二个项目的 文字/fs-h1 会把第一个项目的同名样式覆盖掉
const PREFIX = flag("prefix", "");
const stylePath = (kind: string, name: string) => `${kind}/${PREFIX ? PREFIX + "/" : ""}${name}`;
const DRY = argv.includes("--dry");

// ---------- 找 CSS ----------
function findCssFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 2) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory() && !["node_modules", "dist", "build"].includes(e.name)) {
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".css")) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  // 名字里带 token / variable / theme 的优先，先解析基础值
  const rank = (p: string) => (/token|variable|var|theme|design/i.test(p) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

// ---------- 解析自定义属性，连同所在选择器一起记录 ----------
type Rule = { selectors: string[]; props: Record<string, string> };

function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  // 先整体剥掉注释，否则跨行的 /* ... */ 会被当成选择器碎片
  const lines = css.replace(/\/\*[\s\S]*?\*\//g, "").split("\n");
  let current: Rule | null = null;
  // 选择器允许跨行写，例如 ":root," 换行后再接 "html[data-theme=dark] {"
  let selectorBuf = "";
  let media = "";
  let depth = 0;

  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;

    const mediaMatch = line.match(/^@media([^{]*)\{/);
    if (mediaMatch) {
      media = mediaMatch[1].trim();
      depth++;
      continue;
    }

    if (line === "}") {
      if (current) {
        rules.push(current);
        current = null;
      }
      if (depth > 0) depth--;
      if (depth === 0) media = "";
      selectorBuf = "";
      continue;
    }

    const open = line.indexOf("{");
    if (open >= 0) {
      const head = line.slice(0, open).trim();
      const full = `${selectorBuf} ${head}`.trim();
      selectorBuf = "";
      const selectors = full
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      current = { selectors: media ? selectors.map((s) => `${s} @media ${media}`) : selectors, props: {} };
      depth++;
      const body = line.slice(open + 1).replace(/\}\s*$/, "").trim();
      if (body) collectProps(body, current);
      continue;
    }

    if (current) {
      collectProps(line, current);
    } else if (!line.endsWith(";")) {
      selectorBuf = `${selectorBuf} ${line}`.trim();
    }
  }
  if (current) rules.push(current);
  return rules;
}

function collectProps(line: string, rule: Rule) {
  for (const stmt of line.split(";")) {
    const m = stmt.trim().match(/^(--[a-zA-Z0-9-]+)\s*:\s*(.+)$/);
    if (m) rule.props[m[1]] = m[2].trim();
  }
}

// ---------- 主题识别 ----------
function themeNameOf(selector: string): string | null {
  const dataTheme = selector.match(/data-theme\s*=\s*["']?([\w-]+)/);
  if (dataTheme) return dataTheme[1];
  const classTheme = selector.match(/\.theme-([\w-]+)/);
  if (classTheme) return classTheme[1];
  const scheme = selector.match(/prefers-color-scheme\s*:\s*(\w+)/);
  if (scheme) return scheme[1];
  if (/^:root\b|^html$|^body$/.test(selector.trim()) && !selector.includes("data-theme")) {
    return "base";
  }
  return null;
}

// ---------- var() 解析 ----------
function resolve(value: string, map: Record<string, string>, depth = 0): string {
  if (depth > 8 || !value.includes("var(")) return value;
  return value.replace(/var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,\s*([^()]*))?\s*\)/g, (_all, name, fallback) => {
    const next = map[name] ?? fallback ?? "";
    return resolve(next, map, depth + 1);
  });
}

// ---------- 颜色换算 ----------
// alpha 有两种合法写法：`rgba(0,0,0,.5)` 和现代语法 `rgb(0 0 0 / 50%)`。
// 直接 parseFloat 会把 50% 读成 50，Figma 的 a 必须落在 0 到 1，赋值会报校验错。
function parseAlpha(token: string | undefined): number {
  if (!token) return 1;
  const t = token.trim();
  if (t === "/" || t === "") return 1;
  const n = t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
  if (Number.isNaN(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

function toColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const v = value.trim();
  const hex = v.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return {
      r: +(parseInt(h.slice(0, 2), 16) / 255).toFixed(4),
      g: +(parseInt(h.slice(2, 4), 16) / 255).toFixed(4),
      b: +(parseInt(h.slice(4, 6), 16) / 255).toFixed(4),
      a: h.length >= 8 ? +(parseInt(h.slice(6, 8), 16) / 255).toFixed(4) : 1,
    };
  }
  const rgb = v.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const p = rgb[1].split(/[,\/\s]+/).filter(Boolean);
    const num = (s: string, max: number) => (s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s) / max);
    return {
      r: +num(p[0], 255).toFixed(4),
      g: +num(p[1] ?? "0", 255).toFixed(4),
      b: +num(p[2] ?? "0", 255).toFixed(4),
      a: p.length > 3 ? +parseAlpha(p[3]).toFixed(4) : 1,
    };
  }
  const hsl = v.match(/^hsla?\(([^)]+)\)$/);
  if (hsl) {
    const p = hsl[1].split(/[,\s]+/).filter(Boolean);
    const h = ((parseFloat(p[0]) % 360) + 360) % 360;
    const s = parseFloat(p[1]) / 100;
    const l = parseFloat(p[2]) / 100;
    const a = p.length > 3 ? parseAlpha(p[3]) : 1;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const seg = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return {
      r: +(seg[0] + m).toFixed(4),
      g: +(seg[1] + m).toFixed(4),
      b: +(seg[2] + m).toFixed(4),
      a: +a.toFixed(4),
    };
  }
  return null;
}

// ---------- 阴影换算 ----------
function toEffects(value: string) {
  const parts: string[] = [];
  let buf = "";
  let paren = 0;
  for (const ch of value) {
    if (ch === "(") paren++;
    if (ch === ")") paren--;
    if (ch === "," && paren === 0) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);

  const effects: any[] = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    const inset = /(^|\s)inset(\s|$)/.test(t);
    const body = t.replace(/\binset\b/g, "").trim();
    const colorMatch = body.match(/(rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]{3,8})/);
    const color = colorMatch ? toColor(colorMatch[1]) : { r: 0, g: 0, b: 0, a: 0.25 };
    const nums = body
      .replace(/(rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]{3,8})/g, "")
      .trim()
      .split(/\s+/)
      .map(parseFloat)
      .filter((n) => !Number.isNaN(n));
    if (!nums.length) continue;
    effects.push({
      type: inset ? "INNER_SHADOW" : "DROP_SHADOW",
      color,
      offset: { x: nums[0] || 0, y: nums[1] || 0 },
      radius: nums[2] || 0,
      spread: nums[3] || 0,
      visible: true,
      blendMode: "NORMAL",
    });
  }
  return effects;
}

// ---------- 分类 ----------
type Token = { name: string; raw: string; resolved: string };
type Kind = "color" | "shadow" | "gradient" | "number" | "other";

function classify(t: Token): Kind {
  const v = t.resolved;
  if (/gradient\(/i.test(v)) return "gradient";
  if (/^(-?\d+(\.\d+)?(px)?\s+){1,4}/.test(v) && /rgba?\(|hsla?\(|#/.test(v)) return "shadow";
  if (toColor(v)) return "color";
  if (/^-?\d+(\.\d+)?(px|rem|%)?$/.test(v)) return "number";
  return "other";
}

function toNumber(value: string): number | null {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return null;
  if (value.trim().endsWith("rem")) return +(n * 16).toFixed(2);
  return n;
}

// ---------- 主流程 ----------
const files = findCssFiles(dir);
if (!files.length) {
  console.error(`没找到 CSS 文件: ${dir}`);
  process.exit(1);
}

const base: Record<string, string> = {};
const themes: Record<string, Record<string, string>> = {};

for (const file of files) {
  const css = readFileSync(file, "utf8");
  for (const rule of parseRules(css)) {
    // 一个规则块可能同时命中 :root 和某个主题，两边都要收
    const targets: Record<string, string>[] = [];
    for (const sel of rule.selectors) {
      const theme = themeNameOf(sel);
      if (theme === null) continue;
      targets.push(theme === "base" ? base : (themes[theme] ??= {}));
    }
    for (const t of targets) Object.assign(t, rule.props);
  }
}

const themeNames = ["base", ...Object.keys(themes).filter((t) => t !== "base")];
const merged: Record<string, Record<string, string>> = {};
for (const name of themeNames) {
  const map = name === "base" ? { ...base } : { ...base, ...themes[name] };
  merged[name] = map;
}

// 以 base 的键为准，主题里只放有差异的值
const tokens: Token[] = Object.keys(base).map((k) => ({
  name: k.replace(/^--/, ""),
  raw: base[k],
  resolved: resolve(base[k], base),
}));

const buckets: Record<Kind, Token[]> = { color: [], shadow: [], gradient: [], number: [], other: [] };
for (const t of tokens) buckets[classify(t)].push(t);

console.log(`项目目录: ${dir}`);
console.log(`CSS 文件: ${files.length} 个`);
console.log(`识别到主题: ${themeNames.join(", ")}`);
console.log(`变量总数 ${tokens.length}｜颜色 ${buckets.color.length}｜数值 ${buckets.number.length}｜阴影 ${buckets.shadow.length}｜渐变 ${buckets.gradient.length}｜其他 ${buckets.other.length}`);

const figma = DRY ? null : await openFigma(CHANNEL);
const report: any = { collection: COLLECTION, themes: {}, effects: 0, skippedGradients: buckets.gradient.map((t) => t.name) };

// 变量索引：色板/xxx → { id, collection, hex }，按集合写到 figma-variables--<集合>.json 供后处理脚本反查
const varIndex: Record<string, any> = {};
const rgbHex = (c: any) => {
  const h = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");
  const a = c.a === undefined ? 1 : c.a;
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a < 1 ? h(a) : ""}`;
};

// 颜色：免费套餐一个集合只能一个模式，所以每个主题一个集合
const sameAsBase = (theme: string) =>
  theme !== "base" &&
  buckets.color.every((t) => merged[theme][`--${t.name}`] === merged.base[`--${t.name}`]);

for (const theme of themeNames) {
  // 值跟 base 完全一样的主题不再单独建集合，避免 :root 与 data-theme 并列时重复
  if (sameAsBase(theme)) {
    console.log(`  主题 ${theme} 与 base 完全一致，跳过`);
    continue;
  }
  const suffix = theme === "base" ? "" : `-${theme}`;
  const collectionName = `${COLLECTION}${suffix}`;
  const vars = buckets.color
    .filter((t) => toColor(merged[theme][`--${t.name}`] ?? t.resolved))
    .map((t) => {
      const c = toColor(resolve(merged[theme][`--${t.name}`] ?? t.raw, merged[theme]))!;
      return { name: `色板/${t.name}`, type: "COLOR", valuesByMode: { [theme]: c } };
    });
  if (!vars.length) continue;
  if (DRY) {
    report.themes[theme] = { collection: collectionName, colors: vars.length };
    console.log(`  [试运行] 颜色变量 ${collectionName}: ${vars.length} 个`);
    continue;
  }
  const res = await figma!.call("create_variable_collection", {
    collectionName,
    modeNames: [theme],
    variables: vars,
  });
  report.themes[theme] = { collection: collectionName, colors: res.variables?.length ?? 0 };
  // 顺手记下"变量名 → 变量 ID + 色值"，图表绑定一类的后处理要用它反查。
  // 两套主题同名同键，必须按集合分开存，否则后写的会把先写的覆盖掉。
  for (const v of res.variables || []) {
    const c = v.valuesByMode?.[theme];
    if (!c) continue;
    const entry = { id: v.id, collection: collectionName, hex: rgbHex(c), a: c.a === undefined ? 1 : c.a };
    varIndex[`${collectionName}/${v.name}`] = entry;
    varIndex[`别名/${v.name}`] = varIndex[`别名/${v.name}`] || {};
    varIndex[`别名/${v.name}`][collectionName] = entry;
  }
  console.log(`  颜色变量 ${collectionName}: ${report.themes[theme].colors} 个`);
}

// 数值：间距、圆角、字号这类做成 FLOAT 变量，跨主题一般不分
const floatVars = buckets.number
  .map((t) => ({ name: t.name, value: toNumber(resolve(merged.base[`--${t.name}`], merged.base)) }))
  .filter((v) => v.value !== null)
  .map((v) => ({ name: `数值/${v.name}`, type: "FLOAT", valuesByMode: { base: v.value } }));
if (floatVars.length) {
  if (DRY) {
    report.floats = floatVars.length;
    console.log(`  [试运行] 数值变量: ${floatVars.length} 个`);
  } else {
    const res = await figma!.call("create_variable_collection", {
      collectionName: `${COLLECTION}-数值`,
      modeNames: ["base"],
      variables: floatVars,
    });
    report.floats = res.variables?.length ?? 0;
    console.log(`  数值变量: ${report.floats} 个`);
  }
}

// 阴影：只能做成效果样式，变量装不下
let effectCount = 0;
for (const t of buckets.shadow) {
  const effects = toEffects(t.resolved);
  if (!effects.length) continue;
  if (DRY) {
    effectCount++;
    continue;
  }
  try {
    await figma!.call("create_local_style", { styleType: "EFFECT", name: stylePath("阴影", t.name), effects });
    effectCount++;
  } catch (e) {
    console.log(`  阴影 ${t.name} 建样式失败: ${(e as Error).message}`);
  }
}
report.effects = effectCount;
console.log(`  阴影样式: ${effectCount} 个`);

// 文字：字号 token 生成文字样式，字重按项目 CSS 里的实际配对统计得出。
// 每个字号取出现最多的一档做默认样式，另有字重且独立出现 3 次以上的补一个变体样式。
const pairs = analyzeFontPairs(dir);
const pairByToken = new Map(pairs.map((p) => [p.token.replace(/_/g, "-"), p]));
let textCount = 0;
const textLog: string[] = [];
for (const t of buckets.number.filter((x) => /^fs[-_]/i.test(x.name))) {
  const size = toNumber(resolve(merged.base[`--${t.name}`], merged.base));
  if (size === null) continue;
  const profile = pairByToken.get(t.name.replace(/_/g, "-"));
  const wanted = profile ? [profile.base, ...profile.variants] : [400];
  for (const weight of wanted) {
    const styleName = styleNameForWeight(weight);
    const name = weight === (profile?.base ?? 400) ? stylePath("文字", t.name) : `${stylePath("文字", t.name)} · ${styleName}`;
    if (DRY) {
      textCount++;
      textLog.push(`${name.padEnd(26)} ${String(size).padStart(4)}px  ${styleName}`);
      continue;
    }
    try {
      await figma!.call("create_local_style", {
        styleType: "TEXT",
        name,
        textStyle: { fontName: { family: DEFAULT_FONT, style: styleName }, fontSize: size },
      });
      textCount++;
      textLog.push(`${name.padEnd(26)} ${String(size).padStart(4)}px  ${styleName}`);
    } catch (e) {
      console.log(`  文字样式 ${name} 失败: ${(e as Error).message}`);
    }
  }
}
report.texts = textCount;
console.log(`  文字样式: ${textCount} 个`);
for (const line of textLog) console.log(`    ${line}`);

if (buckets.gradient.length) {
  console.log(`  渐变 ${buckets.gradient.length} 个本次跳过，值已列在报告里`);
}
if (buckets.other.length) {
  console.log(`  未分类 ${buckets.other.length} 个，例如 ${buckets.other.slice(0, 5).map((t) => t.name).join(", ")}`);
}

figma?.close();
const outFile = join(dir, "figma-tokens-report.json");
await Bun.write(outFile, JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2));
console.log(`\n报告已写入 ${outFile}`);
// 变量索引按集合分文件：多个项目共用一份时，后跑的会把前一个的整个盖掉，
// bind-loose-colors 就查不到另一个项目的颜色变量
const varFile = join(import.meta.dir, `figma-variables--${COLLECTION}.json`);
// 试运行没有真实变量 id，写了就是把好索引覆盖成空的
if (DRY) {
  console.log(`试运行：不写 ${varFile}`);
} else {
  await Bun.write(varFile, JSON.stringify(varIndex, null, 2));
  console.log(`变量索引已写入 ${varFile}（${Object.keys(varIndex).length} 个颜色变量）`);
}
process.exit(0);
