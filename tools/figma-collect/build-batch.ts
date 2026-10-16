// 批量推送：把 pages/ 里抽好的页面依次推进 Figma，输出一张汇总表。
// 用法：bun build-batch.ts [--src 原型目录] [--channel powerplant] [--dir pages] [--font 字体名] [页面名 ...]
// 不给页面名就推 pages/ 里的全部；同名画板会被整体替换，所以可以反复跑。
import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeState } from "./push-state.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const SRC = flag("src", "");
const CHANNEL = flag("channel", "powerplant");
const DIR = flag("dir", "pages");
const FONT = flag("font", "");
const LIBRARY = flag("library", "");
// 位置参数只收"不是选项、也不是选项取值"的项，否则 --src 后面的目录会被当成页面名
const WITH_VALUE = new Set(["src", "channel", "dir", "font", "parent", "library"]);
const ONLY: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    if (WITH_VALUE.has(a.slice(2)) && argv[i + 1] && !argv[i + 1].startsWith("--")) i++;
    continue;
  }
  ONLY.push(a);
}

if (!existsSync(DIR)) {
  console.error(`找不到目录 ${DIR}，先在浏览器里跑 batch-extract.js 抽取页面`);
  process.exit(1);
}

// 按本地规格里的节点数从小到大排：小页先过、大页最后，
// 中途出问题也不会把最贵的那几页排在最前面白等。
let pages = (
  ONLY.length
    ? ONLY
    : readdirSync(DIR)
        .filter((f) => f.endsWith(".json") && f !== "components.json")
        .map((f) => f.replace(/\.json$/, ""))
);
if (argv.includes("--by-nodes")) {
  const size = (p: string) => {
    try {
      const j = JSON.parse(readFileSync(join(DIR, `${p}.json`), "utf8"));
      return Number(j.stats?.nodes) || 0;
    } catch {
      return 0;
    }
  };
  pages = pages.slice().sort((a, b) => size(a) - size(b) || a.localeCompare(b));
} else {
  pages = pages.slice().sort();
}

const bun = process.execPath;
const rows: any[][] = [];
let failed = 0;
let idx = 0;
const batchStartedAt = Date.now();

// 批次状态落盘：控制台页面靠它显示"第几页 / 共几页 / 当前哪一页"
function sayBatch(current: string, done: number) {
  writeState({
    batch: { dir: DIR, total: pages.length, index: idx, current, startedAt: batchStartedAt, finishedAt: null, done, failed },
  });
}
sayBatch("", 0);

for (const p of pages) {
  idx++;
  sayBatch(p, idx - 1);
  const json = join(DIR, `${p}.json`);
  if (!existsSync(json)) {
    rows.push([p, "缺文件"]);
    failed++;
    continue;
  }

  const args = [bun, join(import.meta.dir, "build-page.ts"), json, "--channel", CHANNEL];
  if (SRC) args.push("--src", SRC);
  if (FONT) args.push("--font", FONT);
  if (LIBRARY) args.push("--library", LIBRARY);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
  // 实时透传子进程输出：整页写入要几十秒，全缓冲到最后的话，
  // 中途被杀掉就一行都看不到，也没法判断卡在哪一页
  let text = "";
  const dec = new TextDecoder();
  for await (const chunk of proc.stdout as any) {
    const s = dec.decode(chunk, { stream: true });
    text += s;
    process.stdout.write(s);
  }
  await proc.exited;

  const line = text.split("\n").find((l) => l.startsWith("__RESULT__"));
  if (!line) {
    rows.push([p, "写入失败"]);
    console.error(`\n[${p}] 没有写入回执（上面是子进程输出）`);
    failed++;
    continue;
  }

  const r = JSON.parse(line.replace("__RESULT__", ""));
  const payload = await Bun.file(json)
    .text()
    .then((t) => JSON.parse(t))
    .catch(() => ({}));
  rows.push([
    r.name || p,
    r.created,
    r.bound,
    r.boundStroke,
    r.textNodes,
    r.pinned,
    r.gradients,
    r.gradientFailed || 0,
    r.replaced,
    r.timeout ? (r.verified ? "回执丢了(画布已确认)" : "回执丢了(未确认)") : `${r.elapsedMs}ms`,
    r.settled ? `子节点 ${r.childCount}/${r.expectChildren}` : (r.childCount >= 0 ? "画板在但还在变" : "画布未见新画板"),
    payload.stats?.warnings ?? "?",
    r.id,
  ]);
  // 判定以画布为准：回执丢了但新画板在、且建完并落定，就算成功
  if (!r.verified) failed++;
  console.error(`  已推 ${p}`);
}

writeState({ batch: { dir: DIR, total: pages.length, index: pages.length, current: "", startedAt: batchStartedAt, finishedAt: Date.now(), done: pages.length - failed, failed } });

const head = ["页面", "节点", "填充绑定", "描边绑定", "文字", "钉位", "渐变", "失败", "替换", "耗时", "画布核对", "抽取警告", "画板ID"];
rows.unshift(head);
const widths = head.map((_, i) => Math.max(...rows.map((row) => String(row[i] ?? "").length)) + 2);
console.log("");
rows.forEach((row, i) => {
  console.log(row.map((c, j) => String(c ?? "").padEnd(widths[j])).join(""));
  if (i === 0) console.log("-".repeat(widths.reduce((a, b) => a + b, 0)));
});

const sum = (idx: number) => rows.slice(1).reduce((a, r) => a + (Number(r[idx]) || 0), 0);
console.log(
  `\n共 ${pages.length} 页，异常 ${failed} 页；累计节点 ${sum(1)}，填充绑定 ${sum(2)}，描边绑定 ${sum(3)}，文字 ${sum(4)}，渐变 ${sum(6)}（失败 ${sum(7)}）`
);
