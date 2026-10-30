# Pose Studio render host

`VNCCS_PoseStudio` gets its mannequin captures from the Pose Studio widget (three.js) at execution
time. Normally that is the ComfyUI browser tab that queued the prompt. The render host runs the same
widget in headless Chromium next to ComfyUI, so the node works with no browser open (API clients,
scripts, VNCCS Studio).

- Start: `npm install && COMFY_URL=http://127.0.0.1:8188 node server.mjs` (port 8190), or the
  `mcr.microsoft.com/playwright:v1.49.1-noble` image with `/node_modules/playwright` installed.
- ComfyUI: set `VNCCS_RENDER_HOST=http://<host>:8190`. The node then POSTs its sync request
  (`vnccs_req_pose_sync` / `vnccs_apply_sam3d_pose`) with its `pose_data` to `/render`; the widget
  uploads captures to `/vnccs/pose_sync/upload_capture` as in the browser. If the host is
  unreachable the node falls back to the browser tab.
- `GET /vnccs/pose_sync/render_host` on ComfyUI reports whether the host is configured and healthy.
- `POST /render` with `"dry_run": true` returns the captures in the response instead of uploading them.

WebGL runs on SwiftShader (CPU); 12 captures at 640x1536 take about 2.5 s on DGX Spark.
