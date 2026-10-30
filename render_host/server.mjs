// Pose Studio render host: runs the production Pose Studio widget in headless Chromium next to
// ComfyUI, so VNCCS_PoseStudio executes without a ComfyUI browser tab.
//
// The node POSTs the event it would have sent to the browser (vnccs_req_pose_sync or
// vnccs_apply_sam3d_pose) together with its pose_data to /render. The host opens a page on the
// ComfyUI origin, mounts one Pose Studio node with that pose_data and emits the event; the widget
// renders and uploads its captures to /vnccs/pose_sync/upload_capture exactly as in the browser,
// where the waiting node picks them up. Only ComfyUI's app.js and api.js are replaced by stubs
// (the same approach as tests/browser/pose_studio_readiness.mjs).
//
// Env: COMFY_URL (default http://127.0.0.1:8188), PORT (8190), HOST (0.0.0.0),
//      CHROMIUM_ARGS (extra flags), RENDER_TIMEOUT_MS (240000).

import { createServer } from "node:http";
import { chromium } from "playwright";

const COMFY = (process.env.COMFY_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 8190);
const HOST = process.env.HOST || "0.0.0.0";
const TIMEOUT = Number(process.env.RENDER_TIMEOUT_MS || 240000);
const EXTRA_ARGS = (process.env.CHROMIUM_ARGS || "").split(/\s+/).filter(Boolean);
const PAGE_PATH = "/__vnccs_render_host__";
const EVENTS = new Set(["vnccs_req_pose_sync", "vnccs_apply_sam3d_pose"]);

const APP_STUB = `
const graph = {
  _nodes: [],
  getNodeById(id) { return this._nodes[0] ?? null; },
  setDirtyCanvas() {},
};
export const app = {
  extensions: [],
  graph,
  rootGraph: graph,
  canvas: { setDirty() {}, draw() {}, ds: { scale: 1 } },
  canvasEl: document.createElement("canvas"),
  registerExtension(e) { this.extensions.push(e); },
};`;

const API_STUB = `
const handlers = new Map();
export const api = {
  clientId: "vnccs-render-host",
  addEventListener(name, fn) { handlers.set(name, fn); },
  removeEventListener(name) { handlers.delete(name); },
  fetchApi(url, options) { return fetch(url, options); },
  async emit(name, detail) { const fn = handlers.get(name); if (!fn) throw new Error("No handler for " + name); return fn({ detail }); },
};`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>VNCCS render host</title>
<style>body{margin:0;background:#202024}#host{width:1400px;height:950px}#mount{height:100%;display:flex}#mount>div{flex:1;min-width:0}</style>
<div id="host"><div id="mount"></div></div>
<script type="module">
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
try {
  await import("/extensions/ComfyUI_VNCCS_Utils/vnccs_pose_studio.js");
  const extension = app.extensions.find((e) => e.name === "VNCCS.PoseStudio");
  await extension.setup?.();
  class Node {
    constructor(id, poseData) {
      this.id = id; this.type = "VNCCS_PoseStudio"; this.properties = {}; this.graph = app.graph;
      this.subgraph = app.graph;
      this.widgets = [{ name: "pose_data", value: poseData }];
      this.inputs = []; this.outputs = [{ type: "IMAGE", name: "images", links: [] }];
      this.size = [1400, 950];
    }
    setSize(size) { this.size = [...size]; }
    addInput(name, type) { this.inputs.push({ name, type }); }
    addWidget(type, name, value, callback) { const w = { type, name, value, callback }; this.widgets.push(w); return w; }
    addDOMWidget(name, type, element, options) {
      document.querySelector("#mount").append(element);
      const w = { name, type, element, options, _node: this, triggerDraw() {} };
      this.widgets.push(w); return w;
    }
    setDirtyCanvas() {}
  }
  await extension.beforeRegisterNodeDef(Node, { name: "VNCCS_PoseStudio" });
  window.renderHost = {
    async run(event, detail, poseData) {
      const node = new Node(String(detail.node_id), poseData);
      app.graph._nodes = [node];
      node.onNodeCreated?.();
      node.onConfigure?.({});
      await api.emit(event, detail);
      node.onRemoved?.();
    },
  };
  window.renderHostReady = true;
} catch (e) {
  window.renderHostError = String(e?.stack || e);
}
</script>`;

let browserPromise = null;
function browser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", ...EXTRA_ARGS] })
      .then((b) => {
        b.on("disconnected", () => { browserPromise = null; rendererPromise = null; });
        return b;
      })
      .catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

// WebGL renderer string (GPU or SwiftShader), measured once per browser.
let rendererPromise = null;
function webglRenderer(b) {
  if (!rendererPromise) {
    rendererPromise = (async () => {
      const page = await b.newPage();
      try {
        return await page.evaluate(() => {
          const gl = document.createElement("canvas").getContext("webgl2");
          if (!gl) return "no WebGL";
          const ext = gl.getExtension("WEBGL_debug_renderer_info");
          return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        });
      } finally {
        await page.close().catch(() => {});
      }
    })().catch((e) => { rendererPromise = null; throw e; });
  }
  return rendererPromise;
}

// One render at a time: each needs a WebGL context and the CPU rasterizer is the bottleneck.
let queue = Promise.resolve();
function serialized(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

// dry_run: keep the captures in the response instead of uploading them to ComfyUI
// (checks and pose previews without a waiting node).
async function render({ event, detail, pose_data, dry_run }) {
  const started = Date.now();
  const page = await (await browser()).newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  const uploads = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  try {
    if (dry_run) {
      await page.route(`${COMFY}/vnccs/pose_sync/upload_capture`, (r) => {
        uploads.push(JSON.parse(r.request().postData() || "{}"));
        return r.fulfill({ contentType: "application/json", body: '{"status":"ok"}' });
      });
    }
    await page.route(`${COMFY}/scripts/app.js`, (r) => r.fulfill({ contentType: "text/javascript", body: APP_STUB }));
    await page.route(`${COMFY}/scripts/api.js`, (r) => r.fulfill({ contentType: "text/javascript", body: API_STUB }));
    await page.route(`${COMFY}${PAGE_PATH}`, (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
    await page.goto(`${COMFY}${PAGE_PATH}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.renderHostReady || window.renderHostError, null, { timeout: 60000 });
    const loadError = await page.evaluate(() => window.renderHostError);
    if (loadError) throw new Error(`Pose Studio did not load: ${loadError}`);
    await page.evaluate(([ev, d, p]) => window.renderHost.run(ev, d, p), [event, detail, pose_data]);
    return { ok: true, ms: Date.now() - started, errors: errors.slice(0, 20), ...(dry_run ? { uploads } : {}) };
  } finally {
    await page.close().catch(() => {});
  }
}

function readJson(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("Request too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const send = (res, status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      const b = await browser();
      return send(res, 200, { ok: true, comfy: COMFY, chromium: b.version(), webgl: await webglRenderer(b) });
    }
    if (req.method === "POST" && req.url === "/render") {
      const body = await readJson(req);
      if (!EVENTS.has(body?.event)) return send(res, 400, { error: `Unknown event ${body?.event}` });
      if (!body.detail?.node_id || !body.detail?.sync_token) return send(res, 400, { error: "detail.node_id and detail.sync_token are required" });
      if (typeof body.pose_data !== "string") return send(res, 400, { error: "pose_data must be the node's pose_data string" });
      const result = await serialized(() =>
        Promise.race([
          render(body),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Render timed out after ${TIMEOUT} ms`)), TIMEOUT)),
        ]),
      );
      console.log(`[render-host] ${body.event} node ${body.detail.node_id}: ${result.ms} ms${result.errors.length ? `, page errors: ${result.errors.length}` : ""}`);
      return send(res, 200, result);
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("[render-host]", e);
    send(res, 500, { error: String(e?.message || e) });
  }
}).listen(PORT, HOST, () => console.log(`[render-host] listening on ${HOST}:${PORT}, ComfyUI ${COMFY}`));
