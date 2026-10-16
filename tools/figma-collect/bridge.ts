// 复用的 TalkToFigma 通道客户端：起一个 MCP 服务进程，加入频道后按名字调用工具。
// 变量同步器和页面构建器都走这里，避免每个脚本各自实现一遍握手。
import { spawn } from "child_process";
import { join } from "path";

// 默认按仓库布局找 figma-bridge（figma-collect 的同级目录），clone 下来不用改；
// 目录结构不一样时用 FIGMA_MCP_REPO 覆盖。
const REPO = process.env.FIGMA_MCP_REPO || join(import.meta.dir, "..", "figma-bridge");
// bun 在 PATH 上就直接用；不在就设 BUN_PATH 指到绝对路径
const BUN = process.env.BUN_PATH || "bun";
const SERVER = `${REPO}/src/talk_to_figma_mcp/server.ts`;

export type FigmaBridge = {
  call: (tool: string, args?: Record<string, unknown>) => Promise<any>;
  logs: () => string;
  close: () => void;
};

export async function openFigma(channel: string): Promise<FigmaBridge> {
  const child = spawn(BUN, ["run", SERVER], { cwd: REPO });
  let stdoutBuf = "";
  let stderrBuf = "";
  const pending = new Map<number, (msg: any) => void>();
  let seq = 1;

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    let i: number;
    while ((i = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, i).trim();
      stdoutBuf = stdoutBuf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  });

  child.stderr.on("data", (c: Buffer) => {
    stderrBuf += c.toString("utf8");
    if (stderrBuf.length > 200000) stderrBuf = stderrBuf.slice(-100000);
  });

  const rpc = (method: string, params?: unknown) => {
    const id = seq++;
    return new Promise<any>((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });
  };
  const notify = (method: string) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "figma-bridge", version: "1.0.0" },
  });
  if (!init.result) {
    child.kill();
    throw new Error(`MCP 握手失败: ${JSON.stringify(init.error)}`);
  }
  notify("notifications/initialized");
  await sleep(400);

  const join = await rpc("tools/call", {
    name: "join_channel",
    arguments: { channel },
  });
  const joinText = join.result?.content?.[0]?.text ?? "";
  if (!joinText.includes("Successfully")) {
    child.kill();
    throw new Error(`加入频道失败: ${joinText || JSON.stringify(join.error)}`);
  }

  const call: FigmaBridge["call"] = async (tool, args = {}) => {
    const res = await rpc("tools/call", { name: tool, arguments: args });
    if (res.error) throw new Error(`${tool}: ${JSON.stringify(res.error)}`);
    const text: string = res.result?.content?.[0]?.text ?? "";
    // 工具出错时返回的是 "Error xxx: ..." 这样的文本，统一转成异常
    if (/^Error\b/.test(text)) throw new Error(`${tool}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  return {
    call,
    logs: () => stderrBuf,
    close: () => child.kill(),
  };
}
