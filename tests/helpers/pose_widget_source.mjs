// The Pose Studio editor reaches ComfyUI only through web/pose_studio/comfy_host.mjs. A test that
// evaluates the widget class on its own in a vm sandbox maps that onto the sandbox's app and api.
export const COMFY_HOST_PRELUDE = `const comfyHost = {
    get app() { return typeof app === "undefined" ? null : app; },
    get api() { return typeof api === "undefined" ? null : api; },
};
const comfyFetch = (url, options) => comfyHost.api ? comfyHost.api.fetchApi(url, options) : fetch(url, options);
`;

// Source-text checks see the editor (pose_studio/widget.mjs) and its ComfyUI node registration
// (vnccs_pose_studio.js) as one text, as they did when both lived in vnccs_pose_studio.js.
import { readFile } from "node:fs/promises";

export const poseStudioSource = (await readFile(new URL("../../web/pose_studio/widget.mjs", import.meta.url), "utf8"))
    + "\n" + (await readFile(new URL("../../web/vnccs_pose_studio.js", import.meta.url), "utf8"));
