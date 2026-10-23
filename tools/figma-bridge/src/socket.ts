#!/usr/bin/env bun

import { Server, ServerWebSocket } from "bun";
import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { protoSitesPayload } from "./relay-proto-sites.ts";

// ---------------------------------------------------------------------------
// 控制台需要的三份状态：客户端名单、命令流水、日志环形缓冲。
// 只放在内存里，重启中继即清空；页面靠轮询读，不落盘，避免和插件抢磁盘。
// ---------------------------------------------------------------------------

// Store clients by channel
const channels = new Map<string, Set<ServerWebSocket<any>>>();
// Figma 内嵌浏览器不支持 showDirectoryPicker 时，改由本机中继弹 Windows 文件夹选择框，
// 并只允许写入这次选中的目录，避免面板拿到任意路径写文件的权限。
const exportFolders = new WeakMap<object, string>();

type ClientInfo = {
  id: number;
  role: string; // plugin | mcp | unknown
  name: string; // 连接时自报的名字（插件是 "Figma Plugin"）
  client: string; // MCP 客户端工具名，来自 initialize 握手的 clientInfo
  pid: number | string;
  build: string; // 插件自报的构建号（ui.html 顶部的 BUILD 常量），面板拿它核对版本
  channel: string;
  joinedAt: number;
  lastSeen: number;
  lastCommand: string;
};

type EventRow = {
  seq: number;
  ts: number;
  kind: string; // join | cmd | result | error | progress | leave
  client: string;
  detail: string;
  ms?: number;
};

type LogRow = { seq: number; ts: number; level: string; text: string };

const clients = new Map<number, ClientInfo>();
const sockets = new Map<number, ServerWebSocket<any>>();
// ws 与编号的对应关系放这儿：Bun 的 ws.data 在没走 upgrade({data}) 时写进去不一定留得住，
// 早先就是靠 ws.data 传编号，结果注册表一直是空的。
const ids = new WeakMap<object, number>();
let clientSeq = 0;

const LOG_CAP = 600;
const EVENT_CAP = 300;
const logs: LogRow[] = [];
const events: EventRow[] = [];
let rowSeq = 0;

// 进行中的命令：id -> 发出时间、名字、以及是哪个连接发的。
// 必须记住连接号：客户端被杀掉时没人再来收结果，不清理就会永远挂在"进行中"里
// （实测留过三条一小时前的死记录，害得"有没有命令在跑"这个判据彻底失真）。
const inflight = new Map<string, { ts: number; command: string; client: string; cid: number }>();

// 每个频道最近一次进度上报，页面直接读它
const progress = new Map<string, any>();

function pushLog(level: string, text: string) {
  logs.push({ seq: ++rowSeq, ts: Date.now(), level, text: text.slice(0, 600) });
  if (logs.length > LOG_CAP) logs.splice(0, logs.length - LOG_CAP);
}

function pushEvent(kind: string, client: string, detail: string, ms?: number) {
  events.push({ seq: ++rowSeq, ts: Date.now(), kind, client, detail, ms });
  if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP);
}

// 保留原始输出，控制台窗口照常看得见；同时进缓冲给页面
const raw = { log: console.log, info: console.info, warn: console.warn, error: console.error };
function render(args: unknown[]) {
  return args
    .map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
console.log = (...a: unknown[]) => { const t = render(a); if (t) pushLog("log", t); raw.log(...a); };
console.info = (...a: unknown[]) => { const t = render(a); if (t) pushLog("info", t); raw.info(...a); };
console.warn = (...a: unknown[]) => { const t = render(a); if (t) pushLog("warn", t); raw.warn(...a); };
console.error = (...a: unknown[]) => { const t = render(a); if (t) pushLog("error", t); raw.error(...a); };

function safeExportName(name: unknown) {
  const cleaned = String(name || "export")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.\./g, "_")
    .trim();
  return cleaned || "export";
}

async function pickExportFolder(_initialPath = ""): Promise<string> {
  if (process.platform !== "win32") throw new Error("当前只实现了 Windows 文件夹选择");
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class FigmaFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialog { }

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  private const uint FOS_PICKFOLDERS = 0x00000020;
  private const uint FOS_FORCEFILESYSTEM = 0x00000040;
  private const uint SIGDN_FILESYSPATH = 0x80058000;

  public static string Pick(string title) {
    var dialog = (IFileOpenDialog)new FileOpenDialog();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
    dialog.SetTitle(title);
    if (dialog.Show(IntPtr.Zero) != 0) return null;
    IShellItem result;
    dialog.GetResult(out result);
    string path;
    result.GetDisplayName(SIGDN_FILESYSPATH, out path);
    return path;
  }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[FigmaFolderPicker]::Pick('选择 Figma 导出文件夹')
`;
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-STA", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error((stderr || stdout || `PowerShell 退出码 ${code}`).trim());
  const line = stdout.trim().split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() || "";
  return line;
}

function note(id: number, patch: Partial<ClientInfo>) {
  const c = clients.get(id);
  if (!c) return;
  Object.assign(c, patch, { lastSeen: Date.now() });
}

// 推送脚本落盘的批次状态（build-page / build-batch 写的）。
// 上一版这里拼的是同级 figma-mcp，阶段 21 那个目录改名成 figma-collect 之后这条路径就不存在了，
// 而下面 readPushState 的写法是"文件不存在就返回 null"，于是控制台的批次块一直静默空着不报错。
const PUSH_STATE =
  process.env.PUSH_STATE || join(import.meta.dir, "..", "..", "figma-collect", "push-state.json");

function readPushState() {
  try {
    if (!existsSync(PUSH_STATE)) return null;
    return JSON.parse(readFileSync(PUSH_STATE, "utf8"));
  } catch (e) {
    return { error: String(e) };
  }
}

const startedAt = Date.now();

function statusPayload() {
  const byChannel = new Map<string, ClientInfo[]>();
  clients.forEach((c) => {
    if (!c.channel) return;
    if (!byChannel.has(c.channel)) byChannel.set(c.channel, []);
    byChannel.get(c.channel)!.push(c);
  });
  return {
    relay: {
      port: 3055,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      clients: clients.size,
      // 在线与否看套接字开没开，不看最后活动时间：插件空闲时几分钟不发一个字，
      // 用时间窗判会把它误显示成"未连接"。lastSeen 只用于页面上的"最后活动"列。
      pluginOnline: [...clients.values()].some(
        (c) => c.role === "plugin" && sockets.get(c.id)?.readyState === WebSocket.OPEN
      ),
    },
    // 全量客户端（含只连上还没加入频道的），页面按频道分组显示
    allClients: [...clients.values()].map((c) => ({ ...c, now: Date.now() })),
    channels: [...byChannel.entries()].map(([name, list]) => ({
      name,
      clients: list.map((c) => ({ ...c, now: Date.now() })),
    })),
    events: events.slice(-80).reverse(),
    progress: Object.fromEntries(progress.entries()),
    push: readPushState(),
    inflight: [...inflight.entries()]
      .filter(([, v]) => Date.now() - v.ts < 1800000)
      .map(([id, v]) => ({ id, ...v, now: Date.now() })),
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

const CONSOLE_HTML = join(import.meta.dir, "console.html");

function handleConnection(ws: ServerWebSocket<any>) {
  const id = ++clientSeq;
  ids.set(ws, id);
  sockets.set(id, ws);
  clients.set(id, {
    id,
    role: "unknown",
    name: "",
    client: "",
    pid: "",
    build: "",
    channel: "",
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    lastCommand: "",
  });
  raw.log(`New client connected (#${id})`);
  pushLog("log", `客户端接入 #${id}`);

  ws.send(JSON.stringify({ type: "system", message: "Please join a channel to start chatting" }));
}

const server = Bun.serve({
  // 只绑回环。不写 hostname 时 Bun 默认监听所有网卡，同网段任何人都能连上这条通道给画布下命令，
  // 而入口自己一直只监听 127.0.0.1，2026-10-19 把这两处标准对齐。
  hostname: "127.0.0.1",
  port: Number(process.env.PORT || 3055),
  fetch(req: Request, srv: Server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // 先给 WebSocket 升级让路：插件与 MCP 端连的就是 ws://localhost:3055/，路径和页面一样是 "/"，
    // 早先版本把页面路由放在前面，结果所有客户端都升级失败（表现为注册表永远是空的）。
    if (srv.upgrade(req, { headers: { "Access-Control-Allow-Origin": "*" } })) return;

    // 控制台只监听本机，页面与状态接口都走这个进程，不多开端口
    if (url.pathname === "/status") return json(statusPayload());
    if (url.pathname === "/logs") {
      const after = Number(url.searchParams.get("after") || 0);
      return json({ last: logs.length ? logs[logs.length - 1].seq : after, rows: logs.filter((l) => l.seq > after).slice(-200) });
    }
    // 记录标签页的项目单：处理器不改成 async，这里回一个 Promise 给 Bun 就行——
    // 为这一个路由把整个 fetch 头改掉，公开那份同步不过去，漂移体检就会把无关的整页都报出来
    if (url.pathname === "/proto-sites") return protoSitesPayload().then(json);
    if (url.pathname === "/" || url.pathname === "/console") {
      try {
        return new Response(readFileSync(CONSOLE_HTML, "utf8"), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      } catch {
        return new Response("找不到 console.html：" + CONSOLE_HTML, { status: 500 });
      }
    }

    return new Response("WebSocket server running", { headers: { "Access-Control-Allow-Origin": "*" } });
  },
  websocket: {
    open: handleConnection,
    async message(ws: ServerWebSocket<any>, message: string | Buffer) {
      let data: any;
      try {
        data = JSON.parse(message as string);
      } catch {
        return;
      }
      const id = ids.get(ws) as number;
      const self = clients.get(id);
      if (self) self.lastSeen = Date.now();

      // 身份上报：MCP 端连上后自报角色，握手完成后再补工具名
      if (data.type === "hello" || data.type === "identify") {
        note(id, {
          role: data.role || self?.role || "mcp",
          name: data.name || self?.name || "",
          client: data.client || self?.client || "",
          pid: data.pid ?? self?.pid ?? "",
          // 插件（ui.html）自报构建号；原样透传，面板拿它核对"跑的是不是这份代码"
          build: data.build ?? self?.build ?? "",
        });
        const who = clients.get(id);
        raw.log(`client #${id} -> ${who?.role} ${who?.client || who?.name || "?"}`);
        if (data.type === "identify" && who?.client) pushEvent("join", who.client, `识别为 ${who.client}`);
        return;
      }

      if (data.type === "join") {
        const channelName = data.channel;
        if (!channelName || typeof channelName !== "string") {
          ws.send(JSON.stringify({ type: "error", message: "Channel name is required" }));
          return;
        }
        if (!channels.has(channelName)) channels.set(channelName, new Set());
        const channelClients = channels.get(channelName)!;
        channelClients.add(ws);
        // 本 fork 的 MCP 端一连上就会自报 hello，所以"加入频道时还没身份"的那位就是 Figma 插件。
        // 这样判不用改插件、也不用重跑就能把插件认出来；将来 ui.html 也补上 hello 就更稳。
        const inferred = self && self.role === "unknown" ? { role: "plugin", name: "Figma Plugin" } : {};
        note(id, { channel: channelName, ...inferred });
        const who = clients.get(id);
        raw.log(`✓ Client joined channel "${channelName}" (${channelClients.size} total clients)`);
        pushEvent("join", who?.client || who?.role || "?", `加入频道 ${channelName}`);

        ws.send(JSON.stringify({ type: "system", message: `Joined channel: ${channelName}`, channel: channelName }));
        ws.send(JSON.stringify({ type: "system", message: { id: data.id, result: "Connected to channel: " + channelName }, channel: channelName }));
        channelClients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "system", message: "A new user has joined the channel", channel: channelName }));
          }
        });
        return;
      }

      if (data.type === "pick-export-folder") {
        try {
          const path = await pickExportFolder(String(data.initialPath || ""));
          if (!path) {
            ws.send(JSON.stringify({ type: "relay-result", id: data.id, result: { cancelled: true } }));
          } else {
            exportFolders.set(ws, path);
            ws.send(JSON.stringify({ type: "relay-result", id: data.id, result: { path } }));
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: "relay-error", id: data.id, error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      if (data.type === "set-export-folder") {
        try {
          const raw = String(data.path || "").trim();
          if (!raw) {
            exportFolders.delete(ws);
            ws.send(JSON.stringify({ type: "relay-result", id: data.id, result: { path: "" } }));
          } else {
            const path = resolve(raw);
            if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error("文件夹不存在或不是目录");
            exportFolders.set(ws, path);
            ws.send(JSON.stringify({ type: "relay-result", id: data.id, result: { path } }));
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: "relay-error", id: data.id, error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      if (data.type === "write-export-file") {
        try {
          const folder = exportFolders.get(ws);
          if (!folder) throw new Error("还没有选择导出文件夹");
          const name = safeExportName(data.name);
          const buf = Buffer.from(String(data.data || ""), "base64");
          const savedTo = join(folder, name);
          await Bun.write(savedTo, buf);
          ws.send(JSON.stringify({ type: "relay-result", id: data.id, result: { savedTo, bytes: buf.length } }));
        } catch (error) {
          ws.send(JSON.stringify({ type: "relay-error", id: data.id, error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      if (data.type === "message") {
        const channelName = data.channel;
        if (!channelName || typeof channelName !== "string") {
          ws.send(JSON.stringify({ type: "error", message: "Channel name is required" }));
          return;
        }
        const channelClients = channels.get(channelName);
        if (!channelClients || !channelClients.has(ws)) {
          ws.send(JSON.stringify({ type: "error", message: "You must join the channel first" }));
          return;
        }

        const who = clients.get(id);
        const from = who?.client || who?.role || "?";
        const cmd = data.message?.command;
        const respId = data.message?.id || data.id;

        if (cmd) {
          if (who) who.lastCommand = cmd;
          inflight.set(respId, { ts: Date.now(), command: cmd, client: from, cid: id });
          pushEvent("cmd", from, cmd);
        } else if (data.message?.result !== undefined || data.message?.error) {
          const pending = inflight.get(respId);
          if (pending) {
            inflight.delete(respId);
            pushEvent(data.message.error ? "error" : "result", pending.client, pending.command, Date.now() - pending.ts);
            if (data.message.error) pushLog("error", `命令 ${pending.command} 失败：${JSON.stringify(data.message.error).slice(0, 200)}`);
          }
        }

        let broadcastCount = 0;
        channelClients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            broadcastCount++;
            client.send(JSON.stringify({ type: "broadcast", message: data.message, sender: "peer", channel: channelName }));
          }
        });
        if (broadcastCount === 0 && cmd) {
          raw.log(`⚠️  No other clients in channel "${channelName}" to receive message!`);
          pushLog("warn", `频道 ${channelName} 里没有接收方，命令 ${cmd} 无人处理（插件是否连着？）`);
        }
        return;
      }

      // 插件的实时进度：转发给其它客户端的同时，自己留一份给页面
      if (data.type === "progress_update") {
        const channelName = data.channel;
        const p = data.message?.data || data.data || {};
        if (channelName) {
          progress.set(channelName, { ...p, at: Date.now(), id: data.id });
          const channelClients = channels.get(channelName);
          if (channelClients && channelClients.has(ws)) {
            channelClients.forEach((client) => {
              if (client !== ws && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
            });
          }
        }
        if (p.status === "completed" || p.status === "error") {
          const pending = inflight.get(data.id);
          if (pending) {
            inflight.delete(data.id);
            pushEvent(p.status === "error" ? "error" : "result", pending.client, pending.command, Date.now() - pending.ts);
          }
        }
        return;
      }
    },
    close(ws: ServerWebSocket<any>) {
      const id = ids.get(ws) as number;
      const who = clients.get(id);
      channels.forEach((set) => set.delete(ws));
      let dropped = 0;
      inflight.forEach((v, key) => {
        if (v.cid === id) {
          inflight.delete(key);
          dropped++;
        }
      });
      if (who) {
        if (dropped) pushLog("warn", `连接 #${id} 断开，回收它未完成的命令 ${dropped} 条`);
        raw.log(`Client disconnected (#${id} ${who.role} ${who.client || who.name}${dropped ? `，回收 ${dropped} 条未完成命令` : ""})`);
        pushEvent("leave", who.client || who.role || "?", who.channel ? `离开频道 ${who.channel}` : "断开");
      }
      clients.delete(id);
      sockets.delete(id);
    },
  },
});

raw.log(`WebSocket server running on port ${server.port}`);
raw.log(`控制台页面 http://localhost:${server.port}/`);
