/**
 * What the Pose Studio editor needs from ComfyUI, set by the node (web/vnccs_pose_studio.js).
 * Outside ComfyUI (VNCCS Studio, tests) both stay null: requests go through plain fetch on the same
 * origin and there is no graph canvas to forward navigation to.
 */
export const comfyHost = { app: null, api: null };

export function comfyFetch(url, options) {
    return comfyHost.api ? comfyHost.api.fetchApi(url, options) : fetch(url, options);
}
