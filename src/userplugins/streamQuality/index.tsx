/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings, migrateSettingsFromPlugin } from "@api/Settings";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { Button, Forms, React, TabBar, TextInput, Toasts, useState } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

import { addDockButton, removeDockButton } from "../pluginDock";

const MediaEngineStore = findByPropsLazy("getMediaEngine");
const cl = classNameFactory("vc-sq-");

const MAX_PREVIEW_KB = 200;
const MAX_PREVIEW_BYTES = MAX_PREVIEW_KB * 1024;
const PREVIEW_OUT_W = 1280;
const PREVIEW_OUT_H = 720;
const CROP_STAGE_W = 560;
const CROP_STAGE_H = 360;
const CROP_FRAME_W = 480;
const CROP_FRAME_H = Math.round(CROP_FRAME_W * 9 / 16);
const CROP_FRAME_LEFT = (CROP_STAGE_W - CROP_FRAME_W) / 2;
const CROP_FRAME_TOP = (CROP_STAGE_H - CROP_FRAME_H) / 2;

function applyQualityNow() {
    const engine = MediaEngineStore?.getMediaEngine?.();
    if (!engine?.eachConnection) return false;
    let applied = false;
    engine.eachConnection((conn: any) => {
        if (conn.context === "stream" && conn.hasDesktopSource?.() && conn.setDesktopEncodingOptions) {
            const w = parse(settings.store.resolution) ?? 1080;
            const h = Math.round(w * 16 / 9);
            const f = parse(settings.store.fps) ?? 60;
            conn.setDesktopEncodingOptions(h, w, f);
            applied = true;
        }
    });
    return applied;
}

function StreamQualityIcon({ colorClass, width, height }: { color?: string; colorClass?: string; width?: number; height?: number; }) {
    return (
        <svg className={colorClass} width={width ?? 20} height={height ?? 20} viewBox="0 0 24 24" fill="currentColor">
            <path d="M2 5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5Zm5 2c0-1.1.9-2 2-2h3a2 2 0 0 1 2 2v.36c0-.21.14-.4.34-.47l2-.67a.5.5 0 0 1 .66.47v4.62a.5.5 0 0 1-.66.47l-2-.67a.5.5 0 0 1-.34-.47V11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V7Z" />
            <path d="M13 19.5c0 .28.22.5.5.5H15a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h1.5a.5.5 0 0 0 .5-.5v-2c0-.28.22-.5.5-.5h1c.28 0 .5.22.5.5v2Z" />
        </svg>
    );
}

migrateSettingsFromPlugin("StreamQuality", "StreamPreview", "streamPreview", "fakePreview");

const settings = definePluginSettings({
    active: {
        description: "Stream quality override active.",
        type: OptionType.BOOLEAN,
        default: true,
    },
    resolution: {
        description: "Stream resolution height (0 for default).",
        type: OptionType.STRING,
        default: "0",
    },
    fps: {
        description: "Stream FPS (0 for default).",
        type: OptionType.STRING,
        default: "0",
    },
    bitrate: {
        description: "Stream bitrate in kbps (0 for default).",
        type: OptionType.STRING,
        default: "0",
    },
    spoofResolution: {
        description: "Spoof stream resolution badge (0 to disable).",
        type: OptionType.STRING,
        default: "0",
    },
    spoofFps: {
        description: "Spoof stream FPS badge (0 to disable).",
        type: OptionType.STRING,
        default: "0",
    },
    streamPreview: {
        description: "Replace screenshare thumbnail with a custom image.",
        type: OptionType.BOOLEAN,
        default: false,
    },
    fakePreview: {
        description: "Custom preview image (base64 data URL).",
        type: OptionType.STRING,
        default: "",
    },
});

function readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
    });
}

function CropPanel({ srcDataUrl, onSave, onCancel }: { srcDataUrl: string; onSave: (dataUrl: string) => void; onCancel: () => void; }) {
    const viewportRef = React.useRef<HTMLDivElement>(null);
    const [imgSize, setImgSize] = React.useState({ w: 0, h: 0 });
    const [scale, setScale] = React.useState(1);
    const [pos, setPos] = React.useState({ x: 0, y: 0 });
    const minScaleRef = React.useRef(1);
    const dragRef = React.useRef<{ startX: number; startY: number; origX: number; origY: number; } | null>(null);

    React.useEffect(() => {
        const img = new Image();
        img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
        img.src = srcDataUrl;
    }, [srcDataUrl]);

    React.useEffect(() => {
        if (imgSize.w === 0 || imgSize.h === 0) return;
        const cover = Math.max(CROP_FRAME_W / imgSize.w, CROP_FRAME_H / imgSize.h);
        minScaleRef.current = cover;
        setScale(cover);
        setPos({
            x: (CROP_STAGE_W - imgSize.w * cover) / 2,
            y: (CROP_STAGE_H - imgSize.h * cover) / 2,
        });
    }, [imgSize.w, imgSize.h]);

    const clampPos = (x: number, y: number, s: number) => {
        const iw = imgSize.w * s;
        const ih = imgSize.h * s;
        const maxX = CROP_FRAME_LEFT;
        const minX = CROP_FRAME_LEFT + CROP_FRAME_W - iw;
        const maxY = CROP_FRAME_TOP;
        const minY = CROP_FRAME_TOP + CROP_FRAME_H - ih;
        return {
            x: Math.max(minX, Math.min(maxX, x)),
            y: Math.max(minY, Math.min(maxY, y)),
        };
    };

    const onMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    };
    const onMouseMove = (e: React.MouseEvent) => {
        if (!dragRef.current) return;
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setPos(clampPos(dragRef.current.origX + dx, dragRef.current.origY + dy, scale));
    };
    const endDrag = () => { dragRef.current = null; };

    const onWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const rect = viewportRef.current?.getBoundingClientRect();
        if (!rect) return;
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const minS = minScaleRef.current;
        const newScale = Math.max(minS, Math.min(minS * 3, scale * factor));
        const dx = (cx - pos.x) / scale;
        const dy = (cy - pos.y) / scale;
        setScale(newScale);
        setPos(clampPos(cx - dx * newScale, cy - dy * newScale, newScale));
    };

    const handleSave = () => {
        if (imgSize.w === 0) return;
        const sx = (CROP_FRAME_LEFT - pos.x) / scale;
        const sy = (CROP_FRAME_TOP - pos.y) / scale;
        const sw = CROP_FRAME_W / scale;
        const sh = CROP_FRAME_H / scale;
        const canvas = document.createElement("canvas");
        canvas.width = PREVIEW_OUT_W;
        canvas.height = PREVIEW_OUT_H;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const img = new Image();
        img.onload = () => {
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, PREVIEW_OUT_W, PREVIEW_OUT_H);
            let quality = 0.85;
            let result = canvas.toDataURL("image/jpeg", quality);
            while (result.length > MAX_PREVIEW_BYTES * 1.36 && quality > 0.25) {
                quality -= 0.1;
                result = canvas.toDataURL("image/jpeg", quality);
            }
            onSave(result);
        };
        img.src = srcDataUrl;
    };

    const sliderValue = minScaleRef.current > 0 ? scale / minScaleRef.current : 1;

    return (
        <div className={cl("crop")}>
            <div
                ref={viewportRef}
                className={cl("crop-viewport")}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={endDrag}
                onMouseLeave={endDrag}
                onWheel={onWheel}
                style={{ width: CROP_STAGE_W, height: CROP_STAGE_H }}
            >
                <img
                    className={cl("crop-img")}
                    src={srcDataUrl}
                    draggable={false}
                    style={{
                        transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
                        transformOrigin: "0 0",
                        width: imgSize.w || "auto",
                        height: imgSize.h || "auto",
                    }}
                />
                <div
                    className={cl("crop-frame")}
                    style={{
                        left: CROP_FRAME_LEFT,
                        top: CROP_FRAME_TOP,
                        width: CROP_FRAME_W,
                        height: CROP_FRAME_H,
                    }}
                />
            </div>
            <div className={cl("crop-controls")}>
                <span className={cl("crop-hint")}>Drag image to reposition</span>
                <input
                    type="range"
                    min={1}
                    max={3}
                    step={0.02}
                    value={sliderValue}
                    onChange={e => {
                        const t = parseFloat(e.target.value);
                        const newScale = minScaleRef.current * t;
                        setScale(newScale);
                        setPos(p => clampPos(p.x, p.y, newScale));
                    }}
                    className={cl("crop-zoom")}
                    style={{ "--vc-sq-zoom-pct": `${((sliderValue - 1) / 2) * 100}%` } as React.CSSProperties}
                />
            </div>
            <div className={cl("crop-actions")}>
                <Button look={Button.Looks.OUTLINED} onClick={onCancel}>Cancel</Button>
                <Button color={Button.Colors.BRAND} onClick={handleSave}>Use this crop</Button>
            </div>
        </div>
    );
}

function QualityTab({ refresh }: { refresh: () => void; }) {
    return (
        <div className={cl("wrap")}>
            <div className={cl("status")}>
                <div className={classes(cl("status-dot"), settings.store.active ? cl("status-dot-active") : cl("status-dot-inactive"))} />
                <span className={cl("status-text")}>
                    {settings.store.active ? "Overrides active" : "Overrides disabled"}
                </span>
                <button
                    className={cl("status-toggle")}
                    onClick={() => { settings.store.active = !settings.store.active; registerDock(); refresh(); }}
                >
                    {settings.store.active ? "Disable" : "Enable"}
                </button>
            </div>

            <div className={cl("section")}>
                <div className={cl("section-header")}>
                    <span className={cl("section-title")}>Stream Override</span>
                    <div className={cl("section-line")} />
                </div>
                <div className={cl("grid")}>
                    <div className={cl("field")}>
                        <span className={cl("field-label")}>Resolution</span>
                        <TextInput value={settings.store.resolution} onChange={v => { settings.store.resolution = v; refresh(); }} placeholder="1080" />
                    </div>
                    <div className={cl("field")}>
                        <span className={cl("field-label")}>FPS</span>
                        <TextInput value={settings.store.fps} onChange={v => { settings.store.fps = v; refresh(); }} placeholder="60" />
                    </div>
                    <div className={cl("field")}>
                        <span className={cl("field-label")}>Bitrate (kbps)</span>
                        <TextInput value={settings.store.bitrate} onChange={v => { settings.store.bitrate = v; refresh(); }} placeholder="8000" />
                    </div>
                </div>
                <span className={cl("info")}>Set to 0 to use Discord defaults. Changes apply on next stream start.</span>
            </div>

            <div className={cl("section")}>
                <div className={cl("section-header")}>
                    <span className={cl("section-title")}>Badge Spoof</span>
                    <div className={cl("section-line")} />
                </div>
                <div className={cl("spoof-grid")}>
                    <div className={cl("field")}>
                        <span className={cl("field-label")}>Resolution</span>
                        <TextInput value={settings.store.spoofResolution} onChange={v => { settings.store.spoofResolution = v; refresh(); }} placeholder="0 = off" />
                    </div>
                    <div className={cl("field")}>
                        <span className={cl("field-label")}>FPS</span>
                        <TextInput value={settings.store.spoofFps} onChange={v => { settings.store.spoofFps = v; refresh(); }} placeholder="0 = off" />
                    </div>
                </div>
                <span className={cl("info")}>Spoofs the quality badge others see on your stream. Separate from actual quality.</span>
            </div>
        </div>
    );
}

function PreviewTab({ onPickFile, refresh }: { onPickFile: () => void; refresh: () => void; }) {
    const preview = settings.store.fakePreview;
    const enabled = settings.store.streamPreview;
    return (
        <div className={cl("wrap")}>
            <div className={cl("status")}>
                <div className={classes(cl("status-dot"), enabled ? cl("status-dot-active") : cl("status-dot-inactive"))} />
                <span className={cl("status-text")}>
                    {enabled ? "Preview override active" : "Preview override disabled"}
                </span>
                <button
                    className={cl("status-toggle")}
                    onClick={() => { settings.store.streamPreview = !settings.store.streamPreview; refresh(); }}
                >
                    {enabled ? "Disable" : "Enable"}
                </button>
            </div>

            <div className={cl("section")}>
                <div className={cl("section-header")}>
                    <span className={cl("section-title")}>Preview Image</span>
                    <div className={cl("section-line")} />
                </div>
                {preview ? (
                    <>
                        <div className={cl("preview-frame")}>
                            <img className={cl("preview-img")} src={preview} alt="Stream preview" />
                        </div>
                        <div className={cl("preview-actions")}>
                            <Button look={Button.Looks.OUTLINED} onClick={onPickFile}>Change image</Button>
                            <Button color={Button.Colors.RED} look={Button.Looks.OUTLINED} onClick={() => { settings.store.fakePreview = ""; refresh(); }}>Remove</Button>
                        </div>
                    </>
                ) : (
                    <div className={cl("dropzone")} onClick={onPickFile}>
                        <span className={cl("dropzone-text")}>Click to choose an image</span>
                        <span className={cl("dropzone-hint")}>Cropped to 16:9 · output {PREVIEW_OUT_W}×{PREVIEW_OUT_H} · max {MAX_PREVIEW_KB}KB</span>
                    </div>
                )}
                <span className={cl("info")}>
                    Replaces your screenshare thumbnail. Crop to 16:9 for a perfect fit, no black bars.
                </span>
            </div>
        </div>
    );
}

function StreamQualityModal({ modalProps }: { modalProps: ModalProps; }) {
    const [, forceUpdate] = useState(0);
    const refresh = () => forceUpdate(n => n + 1);
    const [tab, setTab] = useState<"quality" | "preview">("quality");
    const [cropSrc, setCropSrc] = useState<string | null>(null);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const startUpload = async (file: File) => {
        if (!file.type.startsWith("image/")) {
            Toasts.show({ id: Toasts.genId(), message: "Please choose an image file", type: Toasts.Type.FAILURE });
            return;
        }
        try {
            const dataUrl = await readFileAsDataURL(file);
            setCropSrc(dataUrl);
        } catch {
            Toasts.show({ id: Toasts.genId(), message: "Failed to read image", type: Toasts.Type.FAILURE });
        }
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader className={cl("modal-header")}>
                <Forms.FormTitle tag="h2" className={cl("modal-title")}>Stream Quality</Forms.FormTitle>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <div className={cl("tabs-row")}>
                <TabBar
                    type="top"
                    look="brand"
                    selectedItem={tab}
                    onItemSelect={(t: string) => setTab(t as typeof tab)}
                >
                    <TabBar.Item id="quality" className={cl("tab-item")}>Quality</TabBar.Item>
                    <TabBar.Item id="preview" className={cl("tab-item")}>Preview</TabBar.Item>
                </TabBar>
            </div>
            <ModalContent className={cl("modal-content")}>
                {tab === "quality" && <QualityTab refresh={refresh} />}
                {tab === "preview" && (
                    cropSrc ? (
                        <CropPanel
                            srcDataUrl={cropSrc}
                            onSave={dataUrl => {
                                settings.store.fakePreview = dataUrl;
                                setCropSrc(null);
                                refresh();
                                Toasts.show({ id: Toasts.genId(), message: "Preview image set", type: Toasts.Type.SUCCESS });
                            }}
                            onCancel={() => setCropSrc(null)}
                        />
                    ) : (
                        <PreviewTab onPickFile={() => fileInputRef.current?.click()} refresh={refresh} />
                    )
                )}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/jpg,image/gif,image/webp"
                    style={{ display: "none" }}
                    onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) startUpload(file);
                        e.target.value = "";
                    }}
                />
            </ModalContent>
            <ModalFooter className={cl("modal-footer")}>
                {tab === "quality" && (
                    <Button
                        look={Button.Looks.OUTLINED}
                        onClick={() => {
                            if (applyQualityNow()) {
                                Toasts.show({ id: Toasts.genId(), message: "Quality applied to active stream", type: Toasts.Type.SUCCESS });
                            } else {
                                Toasts.show({ id: Toasts.genId(), message: "No active stream found", type: Toasts.Type.FAILURE });
                            }
                        }}
                    >
                        Apply Now
                    </Button>
                )}
                <Button color={Button.Colors.BRAND} onClick={modalProps.onClose}>Done</Button>
            </ModalFooter>
        </ModalRoot>
    );
}

function registerDock() {
    addDockButton("streamquality", {
        icon: StreamQualityIcon,
        tooltipText: "Stream Quality",
        glowing: settings.store.active,
        glowColor: "green",
        onClick: () => {
            settings.store.active = !settings.store.active;
            registerDock();
        },
        onContextMenu: e => {
            e.preventDefault();
            openModal(mp => <StreamQualityModal modalProps={mp} />);
        },
    });
}

function parse(val: string) {
    const v = parseInt(val);
    return isFinite(v) && v > 0 ? v : undefined;
}

export default definePlugin({
    name: "StreamQuality",
    description: "Override stream resolution, FPS, and bitrate. Spoof quality badges and screenshare thumbnail. Right-click the dock icon to configure.",
    authors: [{ name: "gabe", id: 1467949308816003193n }],
    dependencies: ["PluginDock"],
    settings,

    start() { registerDock(); },
    stop() { removeDockButton("streamquality"); },

    get spoofRes() { return parse(settings.store.spoofResolution); },
    get spoofFps() { return parse(settings.store.spoofFps); },

    getActualFps() { return settings.store.active ? parse(settings.store.fps) : undefined; },
    getActualResolution() { return settings.store.active ? parse(settings.store.resolution) : undefined; },
    getActualWidth() { const h = this.getActualResolution(); return h ? Math.round(h * 16 / 9) : undefined; },
    getActualBitrate() { const v = settings.store.active ? parse(settings.store.bitrate) : undefined; return v ? v * 1000 : undefined; },

    getStreamFps() { return this.getActualFps() ?? 60; },
    getStreamWidth() { return this.getActualWidth() ?? 1920; },
    getStreamHeight() { return this.getActualResolution() ?? 1080; },
    getStreamPixelCount() { return this.getStreamWidth() * this.getStreamHeight(); },
    getStreamBitrateTarget() { return this.getActualBitrate() ?? 8000000; },
    getStreamBitrateMin() { const br = this.getActualBitrate(); return br ? Math.round(br * 0.5) : 3500000; },
    getStreamBitrateMax() { return this.getStreamBitrateTarget(); },

    normalizeGoLiveQuality(quality: any) {
        if (!this.getActualFps() && !this.getActualResolution() && !this.getActualBitrate()) return quality;
        const w = this.getStreamWidth(), h = this.getStreamHeight(), f = this.getStreamFps();
        return {
            ...quality,
            bitrateTarget: this.getActualBitrate() ?? quality?.bitrateTarget,
            capture: { ...quality?.capture, width: w, height: h, framerate: f },
            encode: { ...quality?.encode, width: w, height: h, framerate: f, pixelCount: w * h },
        };
    },

    coerceResolution(value: any) {
        if (!this.getActualResolution() || typeof value !== "object" || value == null) return value;
        const next = { ...value };
        if ((next.width ?? 0) <= 0) next.width = this.getStreamWidth();
        if ((next.height ?? 0) <= 0) next.height = this.getStreamHeight();
        return next;
    },

    coerceFrameRate(value: any) {
        if (!this.getActualFps()) return value;
        return (typeof value === "number" && value > 0) ? value : this.getStreamFps();
    },

    makeSelfResolution(settingValue: any) {
        if (!this.getActualResolution()) return { height: settingValue ?? 1080, width: 0, type: 0 };
        return { height: this.getStreamHeight(), width: this.getStreamWidth(), type: 0 };
    },

    getDisplayResolution(value: any) {
        if (typeof value !== "object" || value == null) return 0;
        const h = value.height ?? 0, w = value.width ?? 0;
        return h > 0 && w > 0 ? Math.max(h, Math.round(w * 9 / 16)) : h;
    },

    spoofQuality(real: any) {
        const v = this.spoofRes;
        if (!v) return real;
        return { type: 1, width: Math.round(v * 16 / 9), height: v };
    },

    spoofFpsVal(real: number) { return this.spoofFps ?? real; },

    patchStreamParams(params: any) {
        const res = this.spoofRes, fps = this.spoofFps;
        if (!res && !fps) return params;
        if (!Array.isArray(params)) return params;
        for (const p of params) {
            if (res && p.maxResolution) p.maxResolution = { ...p.maxResolution, width: Math.round(res * 16 / 9), height: res };
            if (fps) p.maxFrameRate = fps;
        }
        return params;
    },

    preview(input: string) {
        if (!settings.store.streamPreview) return input;
        const custom = settings.store.fakePreview?.trim();
        return custom || input;
    },

    patches: [
        {
            find: "setDesktopEncodingOptions(",
            replacement: {
                match: /setDesktopEncodingOptions\((\i),(\i),(\i)\)\{/,
                replace: "setDesktopEncodingOptions($1,$2,$3){if(this.destroyed)return;$1=$self.getStreamWidth();$2=$self.getStreamHeight();$3=$self.getStreamFps();",
            }
        },
        {
            find: "captureVideoFrameRate=n.capture.framerate",
            replacement: {
                match: /remoteSinkWantsMaxFramerate=\i\.encode\.framerate/,
                replace: "remoteSinkWantsMaxFramerate=$self.getStreamFps()",
            }
        },
        {
            find: "updateRemoteWantsFramerate(){",
            replacement: {
                match: /updateRemoteWantsFramerate\(\)\{/,
                replace: "$&this.connection.remoteSinkWantsMaxFramerate=$self.getStreamFps(),",
            }
        },
        {
            find: "setSDP(e){}setRemoteVideoSinkWants(",
            replacement: {
                match: /setRemoteVideoSinkWants\((\i)\)\{.{0,80}updateVideoQuality\((\i)\.(\i)\)\}/,
                replace: "setRemoteVideoSinkWants($1){this.remoteVideoSinkWants=$1,this.remoteSinkWantsMaxFramerate=$self.getStreamFps(),this.updateVideoQuality($2.$3)}",
            }
        },
        {
            find: "videoCapture.width",
            replacement: {
                match: /width:this\.options\.videoCapture\.width,height:this\.options\.videoCapture\.height,framerate:this\.options\.videoCapture\.framerate/,
                replace: "capture:{width:$self.getStreamWidth(),height:$self.getStreamHeight(),framerate:$self.getStreamFps()}",
            }
        },
        {
            find: "setGoliveQuality(",
            replacement: {
                match: /setGoliveQuality\((\i)\)\{/,
                replace: "setGoliveQuality($1){$1=$self.normalizeGoLiveQuality($1);",
            }
        },
        {
            find: "mediaEngineConnectionId=`WebRTC-",
            replacement: {
                match: /maxFrameRate:\i\.capture\?\.framerate,maxResolution:\{type:(\i)\.(\i)\.FIXED.{0,40}\}/,
                replace: "maxFrameRate:$self.getStreamFps(),maxResolution:{type:$1.$2.FIXED,width:$self.getStreamWidth(),height:$self.getStreamHeight()}",
            }
        },
        {
            find: "remoteSinkWantsPixelCount&&0!==",
            replacement: [
                {
                    match: /(\i)\.remoteSinkWantsPixelCount=\i\.encode\.pixelCount/,
                    replace: "$1.remoteSinkWantsPixelCount=$self.getStreamPixelCount()",
                },
                {
                    match: /null!=\i\.bitrateTarget\?(\i)\.encodingVideoBitRate=\i\.bitrateTarget:\1\.encodingVideoBitRate=\i\.bitrateMax/,
                    replace: "$1.encodingVideoBitRate=$self.getStreamBitrateTarget()",
                },
                {
                    match: /(\i)\.encodingVideoMinBitRate=\i\.bitrateMin/,
                    replace: "$1.encodingVideoMinBitRate=$self.getStreamBitrateMin()",
                },
                {
                    match: /(\i)\.encodingVideoMaxBitRate=\i\.bitrateMax/,
                    replace: "$1.encodingVideoMaxBitRate=$self.getStreamBitrateMax()",
                },
            ],
        },
        {
            find: "canUseQuestOrbMultiplier",
            replacement: {
                match: /function (\i)\((\i),(\i)\)\{return"high"===\2.{0,40}:"mid"===\2&&.{0,40}\}/,
                replace: "function $1($2,$3){return true}",
            }
        },
        {
            find: "\"canStreamWithSettings\"",
            replacement: {
                match: /\}\)\.allowAutoQuality;/,
                replace: "$&return!0;",
            }
        },
        {
            find: "#{intl::XjXqzh::raw}):h.intl.formatToPlainString(h.t#{intl::TEOC0I::raw}",
            replacement: {
                match: /maxFrameRate:\i\.fps,maxResolution:\{height:\i\.resolution.{0,50}\}/,
                replace: "maxFrameRate:$self.getStreamFps(),maxResolution:$self.makeSelfResolution(t.resolution)",
            }
        },
        {
            find: "intl.formatToPlainString(h.t#{intl::TEOC0I::raw},{resolution:",
            replacement: {
                match: /resolution:(\i)\.height/,
                replace: "resolution:$self.getDisplayResolution($1)",
            }
        },
        {
            find: "ChannelRTCStore\");",
            replacement: {
                match: /maxResolution:(\i),maxFrameRate:(\i),context:(\i)/,
                replace: "maxResolution:$self.coerceResolution($1),maxFrameRate:$self.coerceFrameRate($2),context:$3",
            }
        },
        {
            find: "ChannelRTCStore\");",
            replacement: {
                match: /updateParticipantQuality\((\i),(\i),(\i)\)/,
                replace: "updateParticipantQuality($1,$self.coerceResolution($2),$self.coerceFrameRate($3))",
            }
        },
        {
            find: "Attempting to downgrade to LQ simulcast stream",
            replacement: {
                match: /"LQ"===\i&&!\i&&\i&&\(/,
                replace: "false&&(",
            }
        },
        {
            find: "VideoSourceQualityChanged,this.guildId",
            replacement: [
                {
                    match: /this\.sendVideo\((\i)\?\?0,(\i)\?\?0,(\i)\?\?0,(\i)\)/,
                    replace: "this.sendVideo($1??0,$2??0,$3??0,$self.patchStreamParams($4))",
                },
                {
                    match: /(\i)\.maxResolution,(\i)\.maxFrameRate,this\.context\)/,
                    replace: "$self.spoofQuality($1.maxResolution),$self.spoofFpsVal($2.maxFrameRate),this.context)",
                },
            ],
        },
        {
            find: "case 1440:return 1440;case 0:return 0;default:",
            replacement: {
                match: /default:throw Error\(`Unknown resolution: \${(\i)}`\)/,
                replace: "return $1",
            }
        },
        {
            find: "\"ApplicationStreamPreviewUploadManager\"",
            replacement: {
                match: /thumbnail:([^,}]+)/,
                replace: "thumbnail:$self.preview($1)",
            },
        },
        {
            find: "\"ApplicationStreamPreviewUploadManager\"",
            replacement: [
                {
                    match: /(let \w+=)(\w+\.toDataURL\("image\/jpeg"\));/,
                    replace: "$1$self.preview($2);",
                },
                {
                    match: /(let \w+=)(\w+\.toDataURL\('image\/jpeg'\));/,
                    replace: "$1$self.preview($2);",
                },
            ],
        },
    ],
});
