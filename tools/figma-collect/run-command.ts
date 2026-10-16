// 通用命令入口：加入频道后按名字调用插件的任意指令，参数用一段 JSON 传。
// 用途是"看状态 / 做核对"这类零散查询，省得每个查询都写一个脚本。
// 用法：bun run-command.ts <指令名> ['{"json":"参数"}']
// 删除类指令必须额外带 --yes，否则只打印目标信息不执行（防止手滑）。
import { openFigma } from "./bridge.ts";

// 会改动画布的指令里，删除是不可逆的，单独拦一道
const DESTRUCTIVE = ["delete_node", "delete_multiple_nodes"];

const argv = process.argv.slice(2);
const confirmed = argv.includes("--yes");
const pos = argv.filter((a) => a !== "--yes");
const command = pos[0];
if (!command) {
  console.error('用法：bun run-command.ts <指令名> [\'{"json":"参数"}\'] [--yes]');
  console.error(`删除类指令需要 --yes，例如：bun run-command.ts delete_node '{"nodeId":"99:1"}' --yes`);
  process.exit(1);
}

let args: Record<string, unknown> = {};
if (pos[1]) {
  try {
    args = JSON.parse(pos[1]);
  } catch {
    console.error("参数不是合法 JSON：" + pos[1]);
    process.exit(1);
  }
}

const isDel = DESTRUCTIVE.includes(command);
if (isDel && !confirmed) {
  console.error(`已拦截：${command} 是不可逆删除。核对目标后加 --yes 再执行。`);
  process.exit(2);
}

const CHANNEL = process.env.FIGMA_CHANNEL || "powerplant";
const figma = await openFigma(CHANNEL);
try {
  // 删除前先读一次目标，把名字和类型打在日志上，留下证据
  if (isDel && args.nodeId) {
    const before: any = await figma.call("get_node_info", { nodeId: String(args.nodeId) });
    console.log(
      `目标核对：${before?.id} ${before?.name} ${before?.type} 子节点 ${(before?.children || []).length}`
    );
  }

  const result = await figma.call(command, args);
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));

  if (isDel && args.nodeId) {
    const gone: any = await figma
      .call("get_node_info", { nodeId: String(args.nodeId) })
      .catch(() => null);
    console.log(gone ? `警告：删除后仍读得到 ${args.nodeId}` : `已确认删除：${args.nodeId} 读不到了`);
  }
} catch (e: any) {
  console.error("失败：" + e.message);
  figma.logs();
  process.exit(1);
} finally {
  figma.close();
}
process.exit(0);
