// 把 page-tree.json 推送到 Figma。
// 用法：bun build-page.ts [page-tree.json] [--parent 节点ID] [--channel powerplant] [--no-bind]
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { openFigma } from "./bridge.ts";
// 推送状态落盘（给进度页读）。这行导入缺了会在推送之前就抛 ReferenceError，整批全灭：
// 实测 14 页里有 11 页就是这样一页都没推出去，而且日志里只有一句 ReferenceError。
import { writeState } from "./push-state.ts";

const argv = process.argv.slice(2);
// 这个脚本没有 --help，但手滑打一次就会回落到默认文件 page-tree.json 真的推一页出去，
// 而"推错项目"的代价是往当前画布塞一张别的项目的画板，所以显式拦下来。
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("用法：bun build-page.ts <pages/页面.json> [--src 原型目录] [--parent 节点ID] [--channel powerplant] [--no-bind] [--font 字体名] [--keep-fonts] [--name 画板名] [--library 组件库名]");
  process.exit(0);
}
const file = argv[0] && !argv[0].startsWith("--") ? argv[0] : "page-tree.json";
const flag = (name: string, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const CHANNEL = flag("channel", "powerplant");
const PARENT = flag("parent", "");
const BIND = !argv.includes("--no-bind");
const FONT = flag("font", "PingFang SC");
const KEEP_FONTS = argv.includes("--keep-fonts");
const SRC = flag("src", "");
const NAME = flag("name", "");
const LIBRARY = flag("library", "");

const payload = await Bun.file(file)
  .text()
  .then((t) => JSON.parse(t))
  .catch(() => null);
if (!payload || !payload.tree) {
  console.error(`读不到页面树: ${file}，先跑 collect-server 并用浏览器抽取`);
  process.exit(1);
}

// 插件端按"同名替换"保证幂等，所以多个源文件共用一个标题时，后推的会顶掉先推的。
// 给了 --src 就扫一遍原型目录：标题重复的页面自动在画板名后补源文件名，一页占一格。
function htmlFiles(root: string, depth = 2): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    if (d > depth) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || ["node_modules", "assets", "scripts"].includes(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, d + 1);
      else if (/\.html?$/i.test(e.name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

function resolveFrameName(): string {
  const title = payload.tree.name || payload.title || file;
  if (NAME) return NAME;
  if (!SRC || !payload.source) return title;
  const groups = new Map<string, string[]>();
  // 递归找：有的项目页面放在 pages/ 子目录里，只扫一层会漏掉，重名也就检不出来
  for (const full of htmlFiles(SRC)) {
    const m = readFileSync(full, "utf8").match(/<title>([^<]*)<\/title>/i);
    const t = (m ? m[1] : full.replace(/\.html?$/i, "")).trim();
    groups.set(t, [...(groups.get(t) || []), full]);
  }
  return (groups.get(title) || []).length > 1 ? `${title} · ${payload.source}` : title;
}
payload.tree.name = resolveFrameName();

// 浏览器抓到的字体是 CSS 声明的第一项，不代表设计侧要用的字体，这里统一覆盖
let fontRewritten = 0;
function rewriteFont(node: any) {
  if (node?.type === "text" && node.text?.fontFamily && node.text.fontFamily !== FONT) {
    node.text.fontFamily = FONT;
    fontRewritten++;
  }
  for (const c of node?.children || []) rewriteFont(c);
}
if (!KEEP_FONTS) rewriteFont(payload.tree);

console.log(`页面: ${payload.title || file}`);
console.log(`节点数 ${payload.stats?.nodes ?? "?"}，警告 ${payload.stats?.warnings ?? 0} 条`);
console.log(`隐藏跳过 ${payload.stats?.skipped?.hidden ?? 0}，空节点跳过 ${payload.stats?.skipped?.empty ?? 0}，SVG/画布跳过 ${payload.stats?.skipped?.svg ?? 0}`);

const figma = await openFigma(CHANNEL);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 画布快照：find_boards 是子串匹配，这里只留名字完全相等的画板
// 旧版插件没有这条命令，认出来就直接降级回"只看回执"，不要白等
let canvasReady = true;
async function snapshotBoards(name: string) {
  if (!canvasReady) return [];
  try {
    const r: any = await figma.call("find_boards", { names: [name] });
    return ((r?.boards || []).filter((b: any) => b.name === name)) as any[];
  } catch (e) {
    const msg = (e as Error).message;
    if (/unknown command/i.test(msg)) {
      console.log("当前插件版本没有 find_boards 命令，本次只按回执判定（重跑插件后可启用画布核对）");
      canvasReady = false;
    } else {
      console.log(`画布快照失败：${msg}`);
    }
    return [];
  }
}

// 推送完不靠回执判成败，改看画布。两条理由：
// 1) 回执在大页上会丢（插件算完了，话没送到），丢了就当失败会重推一遍；
// 2) 旧版只看 get_document_info 的页面顶层，画板被 Section 收进去就查不到，把"未知"报成"没建成"。
// 同名替换会删掉旧画板，所以"出现一个新 id"才算建过；插件是单线程按队列处理的，
// 上一还没建完时这个查询会在队列里排着，所以轮询本身就是在等，不需要另外猜时间。
async function waitForBoard(name: string, oldIds: string[], opts: { timeoutMs?: number; stableNeeded?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 900000;
  const stableNeeded = opts.stableNeeded ?? 2;
  const deadline = Date.now() + timeoutMs;
  let prev: any = null;
  let stable = 0;
  while (Date.now() < deadline) {
    const cur = (await snapshotBoards(name)).find((b: any) => !oldIds.includes(b.id)) || null;
    if (!cur) {
      prev = null;
      stable = 0;
      await sleep(4000);
      continue;
    }
    const same =
      prev &&
      cur.id === prev.id &&
      cur.childCount === prev.childCount &&
      Math.abs(cur.height - prev.height) < 0.5;
    stable = same ? stable + 1 : 0;
    prev = cur;
    if (stableNeeded <= 1 || stable >= stableNeeded - 1) return { ...cur, settled: true };
    await sleep(2500);
  }
  return prev ? { ...prev, settled: false } : null;
}

const expectedChildren = (payload.tree.children || []).length;

function report(res: any) {
  console.log("\n写入结果:");
  console.log(JSON.stringify(res, null, 2));
  // 给批量脚本用的单行机器可读结果，避免靠正则猜字段顺序
  console.log(`__RESULT__${JSON.stringify(res)}`);
  if (!KEEP_FONTS) console.log(`\n字体统一覆盖为 ${FONT}，共改写 ${fontRewritten} 个文字节点（--keep-fonts 可关闭）`);
  if (Array.isArray(payload.warnings) && payload.warnings.length) {
    console.log(`\n抽取端警告（前 10 条）:`);
    payload.warnings.slice(0, 10).forEach((w: string) => console.log(`  - ${w}`));
  }
}

// 推送前的旧画板 id，用来认出"这次新建的那个"
const oldIds = (await snapshotBoards(payload.tree.name)).map((b: any) => b.id);
const startedAt = Date.now();
writeState({
  page: {
    name: payload.tree.name,
    source: file,
    nodes: payload.stats?.nodes ?? 0,
    status: "running",
    startedAt,
    finishedAt: null,
    elapsedMs: 0,
    verified: false,
    childCount: -1,
    expectChildren: expectedChildren,
    created: 0,
    error: "",
  },
});

try {
  let res: any = null;
  try {
    res = await figma.call("create_layer_tree", {
      tree: payload.tree,
      parentId: PARENT || undefined,
      bindVariables: BIND,
      libraryName: LIBRARY || undefined,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (!/timed out/i.test(msg)) throw e;
    console.log("回执超时，改按画布核对是否建成...");
  }

  // 回执照常返回时插件肯定跑完了，看一眼画布确认内容真在；回执丢了就多等一次稳定
  const board = canvasReady
    ? await waitForBoard(payload.tree.name, oldIds, {
        timeoutMs: res ? 120000 : 900000,
        stableNeeded: res ? 1 : 2,
      })
    : null;
  const out = res ? { ...res } : { name: payload.tree.name, timeout: true, created: 0, bound: 0, boundStroke: 0, textNodes: 0, pinned: 0, gradients: 0, gradientFailed: 0, replaced: 0, elapsedMs: 0 };
  out.id = board?.id || out.id || "";
  out.verified = board?.settled === true;
  out.settled = board?.settled === true;
  out.childCount = board?.childCount ?? -1;
  out.expectChildren = expectedChildren;
  if (board && board.childCount !== expectedChildren) {
    console.log(`注意：画板直接子节点 ${board.childCount}，本地规格 ${expectedChildren}，可能有子树没建完`);
  }
  if (!board) {
    console.log(canvasReady
      ? `未确认：画布上找不到名字为 ${payload.tree.name} 的新画板`
      : `无法核对画布（插件缺 find_boards），请比对 ${payload.tree.name} 的画板 id 是否已变新`);
  } else {
    console.log(board.settled
      ? `画布已确认：${payload.tree.name} -> ${board.id}（位置：${board.parentName || "页面层"}，直接子节点 ${board.childCount}）`
      : `画布上有了新画板 ${board.id}，但子节点数还在变，判定不了是否建完`);
  }
  writeState({
    page: {
      status: out.verified ? "done" : board ? "unverified" : res ? "unverified" : "failed",
      finishedAt: Date.now(),
      elapsedMs: res?.elapsedMs ?? 0,
      verified: out.verified,
      childCount: out.childCount,
      expectChildren: expectedChildren,
      created: out.created ?? 0,
      error: out.verified ? "" : res ? "回执在但画布未确认" : "回执丢失且画布未确认",
    },
  });
  report(out);
} catch (e) {
  writeState({ page: { status: "failed", finishedAt: Date.now(), error: (e as Error).message.slice(0, 200) } });
  throw e;
} finally {
  figma.close();
}
process.exit(0);
