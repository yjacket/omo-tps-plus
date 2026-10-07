// Real-TUI QA harness: runs omo in a PTY with the installed extensions, drives it with steps, snapshots via xterm.js in headless Chrome.
// steps: {"wait": text} (anywhere in output), {"waitNew": text} (after the last send), {"idle": ms} (no output for ms),
//        {"send": keys}, {"shot": name}, {"mark": label}, {"rm": path} (delete a fixture path mid-session)
// usage: bun qa/tui-qa.mjs --cwd <dir> --cols N --rows N --steps <json> --out <dir> [--editor <cmd>] [--timeout <s>=120] [--agent-dir <dir>]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OMO_JS = "C:/Users/yjack/.bun/install/global/node_modules/omo-ai/bin/omo.js";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const XTERM = "https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[++i];
}
const cols = Number(args.cols ?? 150), rows = Number(args.rows ?? 45);
const timeoutMs = Number(args.timeout ?? 120) * 1000;
const out = resolve(args.out ?? ".omo/evidence/qa");

class Fail extends Error {}
const fail = (m) => { throw new Fail(m); };

const stripAnsi = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\x1b[@-Z\\-_=>]/g, "")
    .replace(/\r/g, "");

const killTree = (pid) => {
  if (!pid) return;
  try { Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }); } catch {}
};

// ---- state to clean up
let proc = null, chrome = null, server = null, profile = null, browserWs = null;
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  try { browserWs?.send(JSON.stringify({ id: 9999, method: "Browser.close" })); } catch {}
  try { browserWs?.close(); } catch {}
  killTree(proc?.pid);
  killTree(chrome?.pid);
  try { await Promise.all([proc?.exited, chrome?.exited].filter(Boolean)); } catch {}
  try { server?.stop(true); } catch {}
  if (profile) {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
  }
};

// ---- PTY output
const chunks = [];
let plain = "";
let sendMark = 0; // plain.length at the last send; waitNew only searches output after it
let lastData = performance.now();
const decoder = new TextDecoder();
let omoExited = null;
const watchers = new Set();
const notify = () => { for (const w of [...watchers]) w(); };

const waitFor = (text, ms, from = 0) => new Promise((res, rej) => {
  let timer;
  const check = () => {
    if (plain.indexOf(text, from) !== -1) { done(); res(); }
    else if (omoExited !== null) { done(); rej(new Fail(`omo exited (code ${omoExited}) while waiting for "${text}"`)); }
  };
  const done = () => { clearTimeout(timer); watchers.delete(check); };
  watchers.add(check);
  timer = setTimeout(() => { done(); rej(new Fail(`timeout ${ms}ms waiting for "${text}"`)); }, ms);
  check();
});

// Resolves once no PTY output arrived for quietMs (the TUI finished redrawing), bounded by ms.
const waitIdle = (quietMs, ms) => new Promise((res, rej) => {
  const end = performance.now() + ms;
  const tick = () => {
    const now = performance.now();
    if (now - lastData >= quietMs) return res();
    if (now > end) return rej(new Fail(`output never went quiet for ${quietMs}ms`));
    setTimeout(tick, Math.min(quietMs, Math.max(10, quietMs - (now - lastData))));
  };
  tick();
});

// ---- Chrome / CDP
let cdpSeq = 0;
const pending = new Map();
let sessionId = null;
const cdp = (method, params = {}, withSession = true) => new Promise((res, rej) => {
  const id = ++cdpSeq;
  pending.set(id, { res, rej });
  const msg = { id, method, params };
  if (withSession && sessionId) msg.sessionId = sessionId;
  browserWs.send(JSON.stringify(msg));
});
const evalJs = async (expression, awaitPromise = false) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) fail("page eval failed: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
};
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  fail(`timeout waiting for ${what}`);
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${XTERM}css/xterm.css">
<script src="${XTERM}lib/xterm.js"></script>
<style>html,body{margin:0;background:#000}#t{display:inline-block}</style></head>
<body><div id="t"></div><script>
window.term = new Terminal({cols:${cols},rows:${rows},fontSize:14,scrollback:0,allowProposedApi:true,fontFamily:"Consolas, 'Malgun Gothic', monospace"});
term.open(document.getElementById("t"));
window.__ready = true;
</script></body></html>`;

async function ensureBrowser() {
  if (browserWs) return;
  profile = mkdtempSync(join(tmpdir(), "omo-tps-plus-qa-chrome-"));
  server = Bun.serve({ port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) });
  chrome = Bun.spawn([CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=2400,1600", "about:blank"],
    { stdout: "ignore", stderr: "ignore" });
  console.log(`chrome pid ${chrome.pid}`);
  const portFile = join(profile, "DevToolsActivePort");
  await until(() => existsSync(portFile) && readFileSync(portFile, "utf8").split("\n").length >= 2, 30000, "DevToolsActivePort");
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  browserWs = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((res, rej) => { browserWs.onopen = res; browserWs.onerror = () => rej(new Fail("CDP websocket error")); });
  browserWs.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.rej(new Fail("CDP " + m.error.message)) : p.res(m.result);
  };
  const { targetId } = await cdp("Target.createTarget", { url: `http://127.0.0.1:${server.port}/` }, false);
  ({ sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true }, false));
  await cdp("Runtime.enable");
  await until(async () => (await evalJs("window.__ready === true").catch(() => false)), 30000, "xterm page (CDN reachable?)");
}

async function shot(name) {
  await ensureBrowser();
  const bytes = Buffer.concat(chunks);
  writeFileSync(join(out, `${name}.ansi`), bytes);
  await evalJs(`term.reset(); new Promise(r => term.write(Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), c => c.charCodeAt(0)), r))`, true);
  const text = await evalJs(`(() => { const b = term.buffer.active, l = []; for (let i = 0; i < b.length; i++) l.push(b.getLine(i).translateToString(true)); return l.join("\\n"); })()`);
  writeFileSync(join(out, `${name}.txt`), text);
  const rect = await evalJs(`(() => { const r = document.getElementById("t").getBoundingClientRect(); return {x:r.x,y:r.y,width:Math.ceil(r.width),height:Math.ceil(r.height)}; })()`);
  const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...rect, scale: 1 } });
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
}

// ---- main
async function main() {
  if (!args.cwd || !args.steps) fail("--cwd and --steps are required");
  const steps = JSON.parse(readFileSync(resolve(args.steps), "utf8"));
  mkdirSync(out, { recursive: true });

  const cmd = ["bun", OMO_JS, "--no-session"];
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  if (args.editor) env.VISUAL = args.editor;
  if (args["agent-dir"]) env.OMO_CODING_AGENT_DIR = resolve(args["agent-dir"]);

  proc = Bun.spawn(cmd, {
    cwd: resolve(args.cwd), env,
    terminal: {
      cols, rows,
      data(_t, data) {
        chunks.push(Buffer.from(data));
        plain += stripAnsi(decoder.decode(data, { stream: true }));
        lastData = performance.now();
        notify();
      },
    },
  });
  console.log(`omo pid ${proc.pid}`);
  proc.exited.then((c) => { omoExited = c; notify(); });

  const timing = { sends: [], marks: [] };
  const t0 = performance.now();
  let lastSend = null;
  for (const step of steps) {
    if ("wait" in step) {
      await waitFor(step.wait, timeoutMs);
      if (lastSend) {
        timing.sends.push({ send: lastSend.text, wait: step.wait, ms: Math.round(performance.now() - lastSend.t) });
        lastSend = null;
      }
    } else if ("waitNew" in step) {
      await waitFor(step.waitNew, timeoutMs, sendMark);
      if (lastSend) {
        timing.sends.push({ send: lastSend.text, wait: step.waitNew, ms: Math.round(performance.now() - lastSend.t) });
        lastSend = null;
      }
    } else if ("rm" in step) {
      rmSync(resolve(step.rm), { recursive: true, force: true }); // fixture removal mid-session
    } else if ("idle" in step) {
      await waitIdle(Number(step.idle), timeoutMs);
    } else if ("send" in step) {
      sendMark = plain.length;
      lastData = performance.now(); // idle counts quiet time from the keypress, not from older output
      lastSend = { text: step.send, t: performance.now() };
      proc.terminal.write(step.send);
    } else if ("shot" in step) {
      await shot(step.shot);
    } else if ("mark" in step) {
      timing.marks.push({ label: step.mark, ms: Math.round(performance.now() - t0) });
    } else fail("unknown step " + JSON.stringify(step));
  }
  writeFileSync(join(out, "timing.json"), JSON.stringify(timing, null, 2));
}

let code = 0;
try {
  await main();
  await cleanup();
  console.log(`QA_DONE ${out}`);
} catch (e) {
  try { writeFileSync(join(out, "failure-tail.txt"), plain.slice(-4000)); } catch {}
  await cleanup();
  console.log(`QA_FAIL ${e instanceof Fail ? e.message : e?.stack ?? e}`);
  code = 1;
}
process.exit(code);
