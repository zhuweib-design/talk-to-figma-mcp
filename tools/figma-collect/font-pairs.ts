// 字号与字重配对分析：从项目 CSS 里统计每个 --fs-* 实际搭配的字重，
// 供 sync-tokens.ts 建文字样式时决定字重，不再清一色 Regular。
// 规则来自统计而不是猜：某个字号在 CSS 里没写 font-weight，就按 400 计（浏览器默认），
// 写了就按声明值计；出现次数最多的一档作为该字号的默认字重，
// 另有字重且独立出现 3 次以上的，作为变体另建样式。
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export type WeightUse = { weight: number; count: number; samples: string[]; declared: boolean };
export type FsProfile = {
  token: string;      // 不带前缀 -- 的变量名，如 fs-h1
  px: number | null;
  uses: WeightUse[];
  base: number;
  variants: number[];
};

// 苹方的字重档位：400 Regular，500 与 600 都落 Medium，700 及以上 Bold
export function styleNameForWeight(w: number): string {
  if (w >= 700) return "Bold";
  if (w >= 500) return "Medium";
  return "Regular";
}

// CSS 未必摊在项目根目录：第二个项目全放在 styles/ 子目录，只扫一层会解析出零条
function cssFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) cssFiles(p, out);
    else if (e.name.endsWith(".css")) out.push(p);
  }
  return out;
}

export function collectCustomProps(dir: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const f of cssFiles(dir)) {
    const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
      if (!tokens.has(m[1])) tokens.set(m[1], m[2].trim());
    }
  }
  return tokens;
}

// 规则块粗切：去注释后按大括号配对，跳过 @media / @keyframes 这类外层包装
function ruleBlocks(css: string) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { sel: string; body: string }[] = [];
  let i = 0;
  while (i < clean.length) {
    const open = clean.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < clean.length && depth > 0) {
      if (clean[j] === "{") depth++;
      else if (clean[j] === "}") depth--;
      j++;
    }
    const sel = clean.slice(i, open).trim().replace(/\s+/g, " ");
    const body = clean.slice(open + 1, j - 1);
    if (!/^@/.test(sel)) out.push({ sel, body });
    i = j;
  }
  return out;
}

function weightOf(value: string, tokens: Map<string, string>): number | null {
  const v = value.trim();
  const mv = v.match(/^var\((--[\w-]+)\)/);
  const raw = mv ? tokens.get(mv[1]) || "" : v;
  if (/bold/i.test(raw)) return 700;
  if (/normal/i.test(raw)) return 400;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

export function analyzeFontPairs(dir: string): FsProfile[] {
  const tokens = collectCustomProps(dir);
  const acc = new Map<string, Map<number, { count: number; samples: string[]; declared: boolean }>>();

  for (const f of cssFiles(dir)) {
    const css = readFileSync(f, "utf8");
    for (const b of ruleBlocks(css)) {
      let fs: string | null = null;
      let fw: number | null = null;
      let fwDeclared = false;
      for (const d of b.body.split(";").map((x) => x.trim()).filter(Boolean)) {
        const mFs = d.match(/^font-size\s*:\s*var\((--[\w-]+)\)/);
        if (mFs) fs = mFs[1].replace(/^--/, "");
        const mFw = d.match(/^font-weight\s*:\s*(.+)$/);
        if (mFw) {
          const w = weightOf(mFw[1], tokens);
          if (w !== null) {
            fw = w;
            fwDeclared = true;
          }
        }
      }
      if (!fs) continue;
      if (!acc.has(fs)) acc.set(fs, new Map());
      const weights = acc.get(fs)!;
      // 没声明字重不等于 400，只是这一条规则没写，按浏览器默认计入
      const key = fwDeclared ? (fw as number) : 400;
      const slot = weights.get(key) || { count: 0, samples: [], declared: fwDeclared };
      slot.count++;
      if (slot.samples.length < 3) slot.samples.push(b.sel.slice(0, 40));
      if (!fwDeclared) slot.declared = slot.declared && false;
      weights.set(key, slot);
    }
  }

  const profiles: FsProfile[] = [];
  for (const [token, weights] of acc) {
    const uses: WeightUse[] = [...weights.entries()]
      .map(([weight, v]) => ({ weight, count: v.count, samples: v.samples, declared: v.declared }))
      .sort((a, b) => b.count - a.count || a.weight - b.weight);
    const pxRaw = tokens.get(`--${token}`);
    const px = pxRaw ? parseFloat(pxRaw) : null;
    const base = uses[0].weight;
    const variants = uses.slice(1).filter((u) => u.count >= 3 && u.weight !== base).map((u) => u.weight);
    profiles.push({ token, px: Number.isNaN(px as number) ? null : (px as number), uses, base, variants });
  }
  return profiles.sort((a, b) => (a.px || 0) - (b.px || 0));
}
