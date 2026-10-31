# Pose Studio render host

`VNCCS_PoseStudio` gets its mannequin captures from the Pose Studio widget (three.js) at execution
time. Normally that is the ComfyUI browser tab that queued the prompt. The render host runs the same
widget in headless Chromium next to ComfyUI, so the node works with no browser open (API clients,
scripts, VNCCS Studio).

- Start: `npm install && COMFY_URL=http://127.0.0.1:8188 node server.mjs` (port 8190), or the
  `mcr.microsoft.com/playwright:v1.49.1-noble` image with `/node_modules/playwright` installed.
- The host connects to ComfyUI (`COMFY_URL`) like a browser tab: it long-polls
  `POST /vnccs/pose_sync/render_host/poll` for the node's sync request (`vnccs_req_pose_sync` /
  `vnccs_apply_sam3d_pose`) with its `pose_data`; the widget uploads captures to
  `/vnccs/pose_sync/upload_capture` as in the browser, and a failed render is reported to
  `/vnccs/pose_sync/render_host/result`. ComfyUI needs no setting and never calls the host (the
  security scan forbids network clients and environment access in node code). While no host has
  polled for 60 s the node asks the browser tab instead.
- `GET /vnccs/pose_sync/render_host` on ComfyUI reports whether a host is attached and its browser.
- `POST /render` with `"dry_run": true` returns the captures in the response instead of uploading them.

WebGL: with `CHROMIUM_ARGS="--use-gl=angle --use-angle=gl-egl"`, `--gpus all`,
`NVIDIA_DRIVER_CAPABILITIES=all` and the host's `/usr/share/glvnd/egl_vendor.d/10_nvidia.json`
mounted, Chromium renders on the NVIDIA GPU (EGL); otherwise on SwiftShader (CPU), with the same
images. 12 captures at 640x1536 on DGX Spark: about 1.7 s on the GPU, 2.4 s on SwiftShader.
`GET /health` reports the WebGL renderer in use.
