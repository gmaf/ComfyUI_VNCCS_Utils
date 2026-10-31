/**
 * VNCCS Pose Studio - the ComfyUI node: registers VNCCS_PoseStudio and hosts the editor
 * (pose_studio/widget.mjs) in it. The editor module itself does not import ComfyUI.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { comfyHost } from "./pose_studio/comfy_host.mjs";
import { PoseStudioWidget, profilePoseStudioResize } from "./pose_studio/widget.mjs";

comfyHost.app = app;
comfyHost.api = api;

// === ComfyUI Extension Registration ===
app.registerExtension({
    name: "VNCCS.PoseStudio",

    setup() {
        (() => {
            if (window.__vnccsPoseStudioCharacterCreatorSync) {
                return window.__vnccsPoseStudioCharacterCreatorSync;
            }

            const parseSource = (node) => {
                if (!node || node.type !== "CharacterCreatorV2") return null;
                const dataWidget = node.widgets?.find(w => w.name === "widget_data");
                if (dataWidget?.value) {
                    try {
                        const parsed = JSON.parse(dataWidget.value);
                        const info = parsed?.character_info || {};
                        const age = Number(info.age);
                        const sex = String(info.sex || "").toLowerCase();
                        const gender = sex === "male" ? 1.0 : (sex === "female" ? 0.0 : NaN);
                        return {
                            age: Number.isFinite(age) ? age : NaN,
                            gender,
                            signature: `${Number.isFinite(age) ? Math.round(age) : "?"}|${Number.isFinite(gender) ? gender : "?"}`
                        };
                    } catch (_) {
                        // Fall back to ordinary widgets below.
                    }
                }

                const ageWidget = node.widgets?.find(w => w.name === "age");
                const sexWidget = node.widgets?.find(w => w.name === "sex" || w.name === "gender");
                const age = Number(ageWidget?.value);
                const sex = String(sexWidget?.value || "").toLowerCase();
                const gender = sex === "male" ? 1.0 : (sex === "female" ? 0.0 : NaN);
                if (!Number.isFinite(age) && !Number.isFinite(gender)) return null;
                return {
                    age: Number.isFinite(age) ? age : NaN,
                    gender,
                    signature: `${Number.isFinite(age) ? Math.round(age) : "?"}|${Number.isFinite(gender) ? gender : "?"}`
                };
            };

            const api = {
                studios: new Set(),
                sourceSignatures: new WeakMap(),
                findSourceNode() {
                    const nodes = app.graph?._nodes || [];
                    return nodes.find(n => n?.type === "CharacterCreatorV2") || null;
                },
                applyToStudio(studio, values, options = {}) {
                    if (!studio || !values) return;
                    studio.applyExternalCharacterCreatorValues?.(values, options);
                },
                applySource(node, options = {}) {
                    const values = parseSource(node);
                    if (!values) return;
                    if (!options.initial) {
                        const previous = this.sourceSignatures.get(node);
                        if (previous === values.signature) return;
                    }
                    this.sourceSignatures.set(node, values.signature);
                    for (const studio of this.studios) {
                        this.applyToStudio(studio, values, options);
                    }
                },
                registerStudio(studio) {
                    if (!studio) return;
                    this.studios.add(studio);
                    this.scan();
                    const source = this.findSourceNode();
                    if (source) this.applyToStudio(studio, parseSource(source), { initial: true });
                },
                unregisterStudio(studio) {
                    this.studios.delete(studio);
                },
                hookNode(node) {
                    if (!node || node.type !== "CharacterCreatorV2") return;
                    const dataWidget = node.widgets?.find(w => w.name === "widget_data");
                    if (dataWidget && !dataWidget._vnccsPoseStudioValueHooked) {
                        let currentValue = dataWidget.value;
                        Object.defineProperty(dataWidget, "value", {
                            configurable: true,
                            get() {
                                return currentValue;
                            },
                            set: (value) => {
                                currentValue = value;
                                queueMicrotask(() => this.applySource(node));
                            }
                        });
                        dataWidget._vnccsPoseStudioValueHooked = true;
                    }

                    for (const name of ["age", "sex", "gender"]) {
                        const widget = node.widgets?.find(w => w.name === name);
                        if (!widget || widget._vnccsPoseStudioCallbackHooked) continue;
                        const original = widget.callback;
                        widget.callback = (...args) => {
                            const result = original?.apply(widget, args);
                            queueMicrotask(() => this.applySource(node));
                            return result;
                        };
                        widget._vnccsPoseStudioCallbackHooked = true;
                    }

                    this.applySource(node, { initial: true });
                },
                scan() {
                    const nodes = app.graph?._nodes || [];
                    for (const node of nodes) this.hookNode(node);
                }
            };

            window.__vnccsPoseStudioCharacterCreatorSync = api;
            return api;
        })();

        const waitForPoseStudioSyncIdle = async (widget, timeoutMs = 5000) => {
            await widget?.awaitReadyForCompositeCapture?.(Math.max(timeoutMs, 120000));
            const deadline = Date.now() + timeoutMs;
            while (widget?._isSyncing && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 16));
            }
            if (widget?._isSyncing) {
                throw new Error("Pose Studio is still synchronizing another capture.");
            }
        };

        const findPoseStudioSyncNode = (nodeId) => {
            let graph = app.rootGraph ?? app.graph;
            let node;
            for (const id of String(nodeId).split(":")) {
                node = graph?.getNodeById?.(id);
                if (!node) return null;
                graph = node.subgraph;
            }
            return node;
        };

        const poseStudioSyncGuard = (node) => {
            const widget = node.studioWidget;
            const restoreToken = widget._poseDataRestoreToken;
            const loadToken = widget._libraryLoadToken;
            const characterId = widget.activeCharacterId;
            const tab = widget.activeTab;
            return () => {
                if (widget._disposed || node.studioWidget !== widget
                    || restoreToken !== widget._poseDataRestoreToken || loadToken !== widget._libraryLoadToken
                    || characterId !== widget.activeCharacterId || tab !== widget.activeTab) {
                    throw new Error("Pose Studio scene changed while execution was preparing. Run the workflow again.");
                }
            };
        };

        const uploadPoseStudioSync = async (node, nodeId, syncToken = "") => {
            const poseWidget = node.widgets.find(w => w.name === "pose_data");
            if (!poseWidget) throw new Error("Pose Studio pose_data widget is unavailable. Reload the workflow and retry.");
            const widget = node.studioWidget;
            const assertCurrent = poseStudioSyncGuard(node);
            const widgetData = JSON.parse(poseWidget.value);
            const syncFileId = syncToken ? `${nodeId}_${syncToken}` : nodeId;
            const capturedImages = (widget._executionCaptureSnapshot
                || widget.poseCaptures
                || []).slice();
            const capturedLightingPrompts = (widget._executionLightingPromptSnapshot
                || widget.lightingPrompts
                || []).slice();
            widget._executionCaptureSnapshot = null;
            widget._executionLightingPromptSnapshot = null;
            const animationCacheReady = await widget.flushAnimationCacheUpload();
            assertCurrent();
            const payload = {
                ...widgetData,
                node_id: syncFileId,
                sync_token: syncToken || undefined,
                // Normal execution stays compact and lets Python hydrate the
                // server cache. If the cache upload failed, include the live
                // state once so execution still cannot lose the animation.
                animation: animationCacheReady
                    ? widgetData.animation
                    : widget.buildSceneAnimationCachePayload(),
                captured_images: capturedImages,
                lighting_prompts: capturedLightingPrompts
            };

            return api.fetchApi('/vnccs/pose_sync/upload_capture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        };

        const requirePoseStudioSyncResponse = async (response) => {
            if (!response.ok) {
                let message = `Pose Studio sync failed (HTTP ${response.status})`;
                try {
                    const errorPayload = await response.json();
                    if (errorPayload?.error) message = String(errorPayload.error);
                } catch (_) { }
                throw new Error(message);
            }
        };

        const reportPoseStudioSyncFailure = async (nodeId, syncToken, error) => {
            const syncFileId = syncToken ? `${nodeId}_${syncToken}` : nodeId;
            try {
                const response = await api.fetchApi('/vnccs/pose_sync/upload_capture', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        node_id: syncFileId,
                        sync_token: syncToken || undefined,
                        sync_error: String(error?.message || error || "Pose Studio sync failed").slice(0, 2048),
                    }),
                });
                await requirePoseStudioSyncResponse(response);
            } catch (error) {
                console.error("[VNCCS] Failed to report Pose Studio sync error:", error);
            }
        };

        api.addEventListener("vnccs_req_pose_sync", async (event) => {
            const nodeId = event.detail.node_id;
            const cameraPrompt = String(event.detail.camera_prompt ?? "");
            const syncToken = String(event.detail.sync_token ?? "");
            const node = findPoseStudioSyncNode(nodeId);
            if (node && node.studioWidget) {
                try {
                    const widget = node.studioWidget;
                    const assertCurrent = poseStudioSyncGuard(node);
                    if (widget._animationCacheRestorePending) {
                        const restored = await widget._animationCacheRestorePromise;
                        assertCurrent();
                        if (!restored) throw new Error("Animation cache could not be restored before execution.");
                    }
                    // Safe mode: ensure viewer is initialized
                    if (!widget.viewer || !widget.viewer.isInitialized()) {
                        await widget.loadModel();
                        assertCurrent();
                    }
                    await widget.ensureDebugLibraryReady();
                    assertCurrent();

                    // Update lights and state before capture
                    if (widget.viewer) {
                        widget.viewer.updateLights(
                            widget.exportParams.keepOriginalLighting
                                ? [{ type: "ambient", color: "#ffffff", intensity: 1.0 }]
                                : widget.lightParams,
                        );
                    }
                    await waitForPoseStudioSyncIdle(widget);
                    assertCurrent();
                    widget.applyEditorMode();
                    widget.syncToNode(true, {
                        cameraPrompt,
                        executionCapture: true,
                    });

                    // Build payload from widget metadata + in-memory captures
                    // (captured_images are no longer stored in the widget to keep workflow size small)
                    const response = await uploadPoseStudioSync(node, nodeId, syncToken);
                    await requirePoseStudioSyncResponse(response);
                } catch (e) {
                    await reportPoseStudioSyncFailure(nodeId, syncToken, e);
                    console.error("[VNCCS] Batch Sync Error:", e);
                }
            } else {
                await reportPoseStudioSyncFailure(nodeId, syncToken,
                    new Error("Pose Studio widget is unavailable. Keep the executing workflow open and reload ComfyUI before retrying."));
            }
        });

        api.addEventListener("vnccs_apply_sam3d_pose", async (event) => {
            const nodeId = event.detail.node_id;
            const poseData = event.detail.pose_data;
            const cameraPrompt = String(event.detail.camera_prompt ?? "");
            const applyMode = String(event.detail.apply_mode ?? "pose");
            const syncToken = String(event.detail.sync_token ?? "");
            const node = findPoseStudioSyncNode(nodeId);
            if (!node?.studioWidget || !poseData) {
                await reportPoseStudioSyncFailure(nodeId, syncToken,
                    new Error(!poseData ? "SAM 3D Body pose data is unavailable."
                        : "Pose Studio widget is unavailable. Keep the executing workflow open and reload ComfyUI before retrying."));
                return;
            }

            try {
                const widget = node.studioWidget;
                const assertCurrent = poseStudioSyncGuard(node);
                widget.applyCapturedImageSize(
                    Number(event.detail.image_width),
                    Number(event.detail.image_height),
                );
                if (!widget.viewer || !widget.viewer.isInitialized()) {
                    await widget.loadModel();
                    assertCurrent();
                }

                if (applyMode === "manager_proportions") {
                    await widget.applySAM3DProportionsToPoseManager(poseData);
                    assertCurrent();
                    widget.setSkydomeFromCameraPrompt(cameraPrompt, { force: true });
                    // Committing fitted character state can invalidate the
                    // first card refresh. Wait for the current scene's cards.
                    await waitForPoseStudioSyncIdle(widget);
                    assertCurrent();
                    widget.syncToNode(true, {
                        cameraPrompt,
                        executionCapture: true,
                    });
                    const response = await uploadPoseStudioSync(node, nodeId, syncToken);
                    await requirePoseStudioSyncResponse(response);
                    return;
                }

                const fitData = await widget.prepareSAM3DRenderFit(poseData);
                assertCurrent();
                const poseForImport = fitData?.poseData || poseData;

                const ok = widget.viewer.applySAM3DImport(
                    poseForImport,
                    widget._shoulderYOffset || 0
                );
                if (!ok) {
                    throw new Error("Failed to apply SAM 3D Body pose to Pose Studio.");
                }
                widget._lastSAM3DPoseData = poseForImport;
                widget._lastSAM3DMeshData = fitData?.meshData || null;
                if (fitData?.meshData) {
                    widget.applySAM3DMeshOverlayFit(fitData.meshData, poseForImport);
                } else {
                    await widget.refreshSAMMeshOverlay(poseForImport);
                    assertCurrent();
                }
                widget.syncMeshProportionSlidersFromViewer();
                widget.applySAM3DFrameCameraParams(poseForImport, fitData?.meshData || null);
                widget.setSkydomeFromCameraPrompt(cameraPrompt, { force: true });

                widget.updateTabs();
                await widget.ensureDebugLibraryReady();
                assertCurrent();
                await waitForPoseStudioSyncIdle(widget);
                assertCurrent();
                widget.commitViewerPoseToCurrentEditor({
                    fullCapture: true,
                    syncOptions: {
                        cameraPrompt,
                        executionCapture: true,
                    },
                });
                const response = await uploadPoseStudioSync(node, nodeId, syncToken);
                await requirePoseStudioSyncResponse(response);
            } catch (e) {
                await reportPoseStudioSyncFailure(nodeId, syncToken, e);
                console.error("[VNCCS] SAM3D pose_image apply error:", e);
            }
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== "VNCCS_PoseStudio") return;

        const socketAcceptsType = (socketType, valueType) => {
            const accepted = String(socketType || "")
                .split(",")
                .map(type => type.trim())
                .filter(Boolean);
            return accepted.includes("*") || accepted.includes(valueType);
        };

        const setAnimationOutputMode = (node, animation, imageBatch = false) => {
            const output = node?.outputs?.[0];
            if (!output) return;
            if (!("_vnccsImageOutputShape" in node)) {
                node._vnccsImageOutputShape = output.shape;
            }

            const useVideo = animation && !imageBatch;
            const nextType = useVideo ? "VIDEO" : "IMAGE";
            const nextName = useVideo
                ? "video"
                : animation && imageBatch ? "IMAGE" : "images";
            const typeChanged = output.type !== nextType;

            if (typeChanged && Array.isArray(output.links)) {
                for (const linkId of [...output.links]) {
                    const link = app.graph?.links?.[linkId] ?? app.graph?.links?.get?.(linkId);
                    const target = link ? app.graph?.getNodeById?.(link.target_id) : null;
                    const input = target?.inputs?.[link?.target_slot];
                    if (!input || !socketAcceptsType(input.type, nextType)) {
                        app.graph?.removeLink?.(linkId);
                    } else if (link) {
                        link.type = nextType;
                    }
                }
            }

            output.type = nextType;
            output.name = nextName;
            output.label = nextName;
            const liteGraph = globalThis.LiteGraph;
            const nextShape = useVideo || (animation && imageBatch)
                ? liteGraph?.CIRCLE_SHAPE
                : node._vnccsImageOutputShape ?? liteGraph?.GRID_SHAPE;
            if (nextShape !== undefined) {
                output.shape = nextShape;
            }
            node.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
        };

        const ensurePoseImageInput = (node) => {
            if (!node) return;
            const inputIndex = node.inputs?.findIndex(input => input?.name === "pose_image") ?? -1;
            if (inputIndex < 0 && typeof node.addInput === "function") {
                node.addInput("pose_image", "IMAGE");
            }
            node.setDirtyCanvas?.(true, true);
        };

        const setCameraPromptInputDisabled = (node, disabled) => {
            if (!node) return;
            const inputIndex = node.inputs?.findIndex(input => input?.name === "camera_prompt") ?? -1;
            if (disabled) {
                if (inputIndex >= 0) {
                    if (node.graph) {
                        if (typeof node.disconnectInput === "function") node.disconnectInput(inputIndex);
                        if (typeof node.removeInput === "function") node.removeInput(inputIndex);
                        else node.inputs.splice(inputIndex, 1);
                    } else {
                        node.inputs.splice(inputIndex, 1);
                    }
                }
                node._vnccsCameraPromptInputDisabled = true;
                node.setDirtyCanvas?.(true, true);
                return;
            }

            if (inputIndex < 0 && typeof node.addInput === "function") {
                node.addInput("camera_prompt", "STRING");
            }
            node._vnccsCameraPromptInputDisabled = false;
            node.setDirtyCanvas?.(true, true);
        };

        const syncStudioDOMWidgetWidth = (node) => {
            const widget = node?.widgets?.find(w => w.name === "pose_studio_ui");
            const nodeWidth = Number(node?.size?.[0]);
            if (widget && Number.isFinite(nodeWidth) && nodeWidth > 0) {
                if (!widget._vnccsWidthBound) {
                    Object.defineProperty(widget, "width", {
                        configurable: true,
                        get() {
                            const width = Number(this._node?.size?.[0]);
                            return Number.isFinite(width) && width > 0 ? width : undefined;
                        },
                        set(_value) {
                            // ComfyUI may restore a stale widget.width from older DOM layouts.
                            // Keep this DOM widget tied to the node width instead.
                        }
                    });
                    widget._vnccsWidthBound = true;
                }
                if (typeof widget.triggerDraw === "function") widget.triggerDraw();
            }
        };

        const scheduleStudioDOMWidgetWidth = (node) => {
            if (!node || node._vnccsPoseWidthFrame) return;
            node._vnccsPoseWidthFrame = requestAnimationFrame(() => {
                node._vnccsPoseWidthFrame = null;
                profilePoseStudioResize("Comfy DOM widget triggerDraw", () => {
                    syncStudioDOMWidgetWidth(node);
                });
            });
        };

        const hideInternalWidget = (node, name) => {
            const widget = node?.widgets?.find(candidate => candidate.name === name);
            if (!widget) return;
            if (name === "pose_data") {
                widget.options = { ...widget.options, dynamicPrompts: false };
            }
            widget.type = "hidden";
            widget.computeSize = () => [0, -4];
            widget.hidden = true;
            if (widget.element) widget.element.style.display = "none";
        };

        const ensureAnimationImageBatchWidget = (node) => {
            let widget = node?.widgets?.find(candidate => candidate.name === "animation_image_batch");
            if (!widget && typeof node?.addWidget === "function") {
                widget = node.addWidget(
                    "toggle",
                    "animation_image_batch",
                    false,
                    value => {
                        if (!node.studioWidget) return;
                        node.studioWidget.exportParams.animation_image_batch = value === true;
                    },
                );
            }
            return widget;
        };

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onCreated) onCreated.apply(this, arguments);
            this._vnccsPoseAwaitingRestore = true;

            // pose_data is internal state, never user-facing UI. Hide it before
            // constructing the DOM widget so a later initialization exception
            // cannot expand megabytes of JSON across the ComfyUI canvas.
            hideInternalWidget(this, "pose_data");
            ensureAnimationImageBatchWidget(this);
            hideInternalWidget(this, "animation_image_batch");
            this.setSize([900, 740]);

            // Create widget
            this._vnccsSetAnimationOutputMode = (animation, imageBatch = false) => (
                setAnimationOutputMode(this, animation, imageBatch)
            );
            this.studioWidget = new PoseStudioWidget(this);
            this.studioWidget.container.inert = true;
            this._vnccsEnsurePoseImageInput = () => ensurePoseImageInput(this);
            this._vnccsSetCameraPromptInputDisabled = (disabled) => setCameraPromptInputDisabled(this, disabled);
            this._vnccsEnsurePoseImageInput();
            this.studioWidget.applyDirectionalSkydomeSetting();

            const studioDOMWidget = this.addDOMWidget("pose_studio_ui", "ui", this.studioWidget.container, {
                serialize: false,
                hideOnZoom: false
            });
            this.studioDOMWidget = studioDOMWidget;
            syncStudioDOMWidgetWidth(this);
            requestAnimationFrame(() => syncStudioDOMWidgetWidth(this));

            // Pre-load library for random functionality
            this._vnccsPoseLibraryWarmupTimer = setTimeout(() => {
                if (this.studioWidget) {
                    this.studioWidget.refreshLibrary(false);
                    this.studioWidget.autoRefreshEnabledPoseRepositories();
                }
            }, 1000);

            // Load model after initialization
            this._vnccsPoseInitTimer = setTimeout(() => {
                this.studioWidget.loadFromNode();
                this._vnccsEnsurePoseImageInput?.();
                window.__vnccsPoseStudioCharacterCreatorSync?.registerStudio(this.studioWidget);
                this.studioWidget.loadModel().then(() => {
                    if (this.studioWidget.viewer) {
                        this.studioWidget.updateCaptureCameraPreview();
                        // Force resize again after model load to ensure Three.js matches container
                        this.studioWidget.resize();
                    }
                });
                // Force a resize after initialization to fix stretching
                this.onResize(this.size);
            }, 800);
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const result = onResize?.apply(this, arguments);
            if (this.studioWidget) {
                // DON'T set container dimensions - let it fill naturally
                // Coalesce ComfyUI DOM-widget redraws to one per display frame.
                scheduleStudioDOMWidgetWidth(this);
                clearTimeout(this.resizeTimer);
                this.resizeTimer = setTimeout(() => {
                    syncStudioDOMWidgetWidth(this);
                    this.studioWidget.scheduleMainUIScaleCommit({ force: true });
                }, 50);
            }
            return result;
        };

        // Save state on configure
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);

            if (this.studioWidget) {
                syncStudioDOMWidgetWidth(this);
                clearTimeout(this._vnccsPoseInitTimer);
                clearTimeout(this._vnccsPoseConfigureTimer);
                this.studioWidget.loadFromNode();
                this._vnccsEnsurePoseImageInput?.();
                window.__vnccsPoseStudioCharacterCreatorSync?.registerStudio(this.studioWidget);
                this._vnccsPoseConfigureTimer = setTimeout(() => {
                    syncStudioDOMWidgetWidth(this);
                    this.studioWidget.refreshLibrary(false); // Pre-load library meta only
                    this.studioWidget.autoRefreshEnabledPoseRepositories();
                    this.onResize(this.size); // Force correct aspect ratio on config
                }, 500);
            }
        };

        // Re-capture with fresh random params on each execution when Debug Mode is enabled
        const onExecutionStart = nodeType.prototype.onExecutionStart;
        nodeType.prototype.onExecutionStart = function () {
            if (onExecutionStart) onExecutionStart.apply(this, arguments);

            // Removed redundant syncToNode(true) to avoid race conditions with vnccs_req_pose_sync
        };

        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (workflow) {
            const result = onSerialize?.apply(this, arguments);
            const poseWidget = this.widgets?.find(widget => widget.name === "pose_data");
            if (poseWidget && this.studioWidget) {
                const previous = poseWidget.value;
                this.studioWidget.syncToNode(false, {
                    skipCapture: true, skipCaptureUpload: true,
                    skipAnimationHistory: true, notify: false,
                });
                if (Array.isArray(workflow?.widgets_values)) {
                    workflow.widgets_values = workflow.widgets_values.map(value => value === previous ? poseWidget.value : value);
                }
            }
            return result;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            window.__vnccsPoseStudioCharacterCreatorSync?.unregisterStudio(this.studioWidget);
            clearTimeout(this.resizeTimer);
            clearTimeout(this._vnccsPoseLibraryWarmupTimer);
            clearTimeout(this._vnccsPoseInitTimer);
            clearTimeout(this._vnccsPoseConfigureTimer);
            if (this._vnccsPoseWidthFrame) {
                cancelAnimationFrame(this._vnccsPoseWidthFrame);
                this._vnccsPoseWidthFrame = null;
            }
            if (this.studioWidget) {
                this.studioWidget.dispose();
            }
            if (onRemoved) onRemoved.apply(this, arguments);
        };
    },

    nodeCreated(node) {
        window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node);
        if (node?.type === "CharacterCreatorV2") {
            setTimeout(() => window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node), 0);
            setTimeout(() => window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node), 500);
        }
    },

    loadedGraphNode(node) {
        window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node);
    },

    loadedGraph() {
        window.__vnccsPoseStudioCharacterCreatorSync?.scan();
    }
});

// Shared editor surface for hosts such as UniCanvas. Node registration stays unchanged.
export { PoseStudioWidget };
