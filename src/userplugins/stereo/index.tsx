/*
MIT License

Copyright (c) 2024 Xicord

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Card } from "@components/Card";
import { FormSwitch } from "@components/FormSwitch";
import { Span } from "@components/Span";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import { ModalCloseButton, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { React, Slider, TabBar, UserStore } from "@webpack/common";
import { useCallback, useEffect, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.Stereo as PluginNative<typeof import("./native")>;

import { addDockButton, removeDockButton } from "../pluginDock";

const cl = classNameFactory("vc-stereo-");

const MediaEngineStore = findStoreLazy("MediaEngineStore");
const VoiceStateStore = findStoreLazy("VoiceStateStore");
let ActiveConnection: any;
let lastTransportOptions: Record<string, any> | null = null;

const settings = definePluginSettings({
    enabled: {
        description: "Master toggle.",
        type: OptionType.BOOLEAN,
        default: true,
    },
    forceMono: {
        description: "Force all incoming audio to mono.",
        type: OptionType.BOOLEAN,
        default: false,
        onChange() { applyTransport(); },
    },
    bitrate: {
        description: "Audio bitrate in kbps.",
        type: OptionType.NUMBER,
        default: 510,
        onChange() { applyTransport(); },
    },
    channels: {
        description: "Number of audio channels (1 = mono, 2 = stereo).",
        type: OptionType.NUMBER,
        default: 2,
        onChange() { applyTransport(); },
    },
});

function getEffectiveBitrate() {
    const { bitrate, enabled } = settings.store;
    return (enabled && bitrate ? bitrate : 510) * 1000;
}

function getEncoderOptions() {
    const { channels, bitrate, enabled } = settings.store;
    const ch = enabled && channels ? channels : 2;
    const rate = (enabled && bitrate ? bitrate : 510) * 1000;
    return {
        type: 120,
        name: "opus",
        freq: 48000,
        channels: ch,
        rate,
        pacsize: 960,
        params: {
            stereo: ch >= 2 ? "1" : "0",
            usedtx: "0",
            useinbandfec: "0",
            cbr: enabled ? "1" : "0",
            maxaveragebitrate: String(rate),
        },
    };
}

function getDecoderOptions() {
    return {
        channels: 2,
        freq: 48000,
        params: { stereo: settings.store.forceMono ? "0" : "1" },
        type: 120,
        name: "opus",
    };
}

function applyTransport() {
    if (!ActiveConnection?.conn || !lastTransportOptions) return;
    let copy: Record<string, any>;
    try {
        copy = typeof structuredClone === "function"
            ? structuredClone(lastTransportOptions)
            : JSON.parse(JSON.stringify(lastTransportOptions));
    } catch {
        copy = { ...lastTransportOptions };
    }
    ActiveConnection.conn.setTransportOptions(copy);
}

function openStereoModal() {
    openModal(modalProps => <StereoModal modalProps={modalProps} />);
}

function StereoIcon({ colorClass, width, height }: { color?: string; colorClass?: string; width?: number; height?: number; }) {
    return (
        <svg className={colorClass} width={width ?? 20} height={height ?? 20} viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 2a1 1 0 0 0-1 1v18a1 1 0 1 0 2 0V3a1 1 0 0 0-1-1ZM11 6a1 1 0 1 1 2 0v12a1 1 0 1 1-2 0V6ZM1 8a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V8ZM16 5a1 1 0 1 1 2 0v14a1 1 0 1 1-2 0V5ZM22 8a1 1 0 0 0-1 1v6a1 1 0 1 0 2 0V9a1 1 0 0 0-1-1Z" />
        </svg>
    );
}

function formatBitrate(v: number): string {
    return v >= 1000 ? `${(v / 1000).toFixed(1)}Mbps` : `${v}kbps`;
}

function SettingsPanel() {
    const [forceMono, setForceMono] = useState(settings.store.forceMono);
    const [bitrate, setBitrate] = useState(settings.store.bitrate);
    const [channels, setChannels] = useState(settings.store.channels);
    const [liveBitrate, setLiveBitrate] = useState(settings.store.bitrate);
    const [liveChannels, setLiveChannels] = useState(settings.store.channels);

    useEffect(() => setLiveBitrate(bitrate), [bitrate]);
    useEffect(() => setLiveChannels(channels), [channels]);

    const renderBitrate = useCallback((v: number) => formatBitrate(Math.round(v)), []);
    const renderBitrateMarker = useCallback((v: number) => String(Math.round(v)), []);
    const renderChannels = useCallback((v: number) => Math.round(v) === 1 ? "Mono" : "Stereo", []);

    return (
        <div className={cl("content")}>
            <Card className={cl("control")} variant="primary" outline>
                <div className={cl("control-header")}>
                    <Span size="md" weight="semibold" color="text-default">Bitrate</Span>
                    <Span size="lg" weight="bold" color="text-default" className={cl("control-value")}>
                        {renderBitrate(liveBitrate)}
                    </Span>
                </div>
                <div className={cl("control-slider")}>
                    <Slider
                        initialValue={bitrate}
                        minValue={8}
                        maxValue={510}
                        markers={[8, 32, 64, 128, 256, 384, 510]}
                        stickToMarkers
                        asValueChanges={v => setLiveBitrate(Math.round(v))}
                        onValueChange={v => {
                            const n = Math.round(v);
                            settings.store.bitrate = n;
                            setBitrate(n);
                        }}
                        onValueRender={renderBitrate}
                        onMarkerRender={renderBitrateMarker}
                    />
                </div>
            </Card>

            <Card className={cl("control")} variant="primary" outline>
                <div className={cl("control-header")}>
                    <Span size="md" weight="semibold" color="text-default">Channels</Span>
                    <Span size="lg" weight="bold" color="text-default" className={cl("control-value")}>
                        {renderChannels(liveChannels)}
                    </Span>
                </div>
                <div className={cl("control-slider")}>
                    <Slider
                        initialValue={channels}
                        minValue={1}
                        maxValue={2}
                        markers={[1, 2]}
                        stickToMarkers
                        asValueChanges={v => setLiveChannels(Math.round(v))}
                        onValueChange={v => {
                            const n = Math.round(v);
                            settings.store.channels = n;
                            setChannels(n);
                        }}
                        onValueRender={renderChannels}
                        onMarkerRender={renderChannels}
                    />
                </div>
            </Card>

            <Card className={cl("control")} variant="primary" outline>
                <FormSwitch
                    title="Force Mono on Others"
                    description="Force all incoming audio to mono."
                    value={forceMono}
                    onChange={v => { settings.store.forceMono = v; setForceMono(v); }}
                    hideBorder
                />
            </Card>
        </div>
    );
}

const PATCH_LABELS: { key: string; label: string; }[] = [
    { key: "stereoCmovae", label: "Stereo cmovae flags" },
    { key: "audioChannels", label: "Audio frame channels 1→2" },
    { key: "applyConfigKills", label: "HPF/AEC/NS/AGC kills" },
    { key: "multiChannelCapture", label: "multi_channel_capture" },
    { key: "audioNetworkAdaptor", label: "Audio Network Adaptor killed" },
    { key: "opusAudioMode", label: "Opus AUDIO mode" },
];

function PatchStatusIcon({ state }: { state: boolean | null | undefined; }) {
    if (state === true) return <span style={{ color: "#23a559", fontWeight: 700 }}>✓</span>;
    if (state === false) return <span style={{ color: "#f23f42", fontWeight: 700 }}>✗</span>;
    return <span style={{ color: "#949ba4", fontWeight: 700 }}>?</span>;
}

interface InstallInfo {
    install: string;
    label: string;
    voiceDir: string | null;
    nodePath: string | null;
    indexPath: string | null;
    hasNodeBackup: boolean;
    hasIndexBackup: boolean;
    error?: string;
    nodeSize?: number;
    bakSize?: number;
    patches: Record<string, boolean | null>;
}

function getCurrentInstallName(): string {
    const ch = (window as any).GLOBAL_ENV?.RELEASE_CHANNEL
        ?? (window as any).DiscordNative?.app?.getReleaseChannel?.();
    if (ch === "canary") return "discordcanary";
    if (ch === "ptb") return "discordptb";
    return "discord";
}

function PatchesPanel() {
    const [state, setState] = useState<InstallInfo | null>(null);
    const [loading, setLoading] = useState(false);
    const targetInstall = getCurrentInstallName();

    const refresh = useCallback(() => {
        setLoading(true);
        Native.getPatchStates()
            .then(r => {
                const all = r as InstallInfo[];
                setState(all.find(s => s.install === targetInstall) ?? null);
            })
            .catch(() => setState(null))
            .finally(() => setLoading(false));
    }, [targetInstall]);

    useEffect(() => { refresh(); }, [refresh]);

    const patchCount = state ? PATCH_LABELS.filter(p => state.patches[p.key] === true).length : 0;
    const totalDetectable = PATCH_LABELS.length;

    return (
        <div className={cl("content")}>
            {state ? (
                <Card className={cl("install")} variant="primary" outline>
                    <div className={cl("install-header")}>
                        <div>
                            <Span size="lg" weight="bold" color="text-default">{state.label}</Span>
                            <div style={{ marginTop: 2 }}>
                                <Span size="xs" color="text-muted">
                                    {state.hasNodeBackup ? "Patcher backup present" : "No backup yet"}
                                </Span>
                            </div>
                        </div>
                        <div className={cl("install-actions")}>
                            <span className={cl("patch-count")}>{patchCount}/{totalDetectable}</span>
                            <button className={cl("refresh-btn")} onClick={refresh} disabled={loading} aria-label="Refresh">
                                {loading ? "…" : "↻"}
                            </button>
                        </div>
                    </div>
                    {state.error && <Span size="xs" color="text-danger">{state.error}</Span>}
                    {state.nodePath && (
                        <div className={cl("patch-grid")}>
                            {PATCH_LABELS.map(p => (
                                <div key={p.key} className={cl("patch-row")} data-state={state.patches[p.key] === true ? "on" : state.patches[p.key] === false ? "off" : "unknown"}>
                                    <PatchStatusIcon state={state.patches[p.key]} />
                                    <Span size="sm" color="text-default">{p.label}</Span>
                                </div>
                            ))}
                        </div>
                    )}
                    {!state.nodePath && (
                        <Span size="sm" color="text-muted">discord_voice.node not found in this install.</Span>
                    )}
                </Card>
            ) : (
                <Span size="sm" color="text-muted">{loading ? "Scanning…" : "Could not find your Discord install."}</Span>
            )}
            <div className={cl("patches-legend")}>
                <span><span style={{ color: "#23a559" }}>✓</span> patched</span>
                <span><span style={{ color: "#f23f42" }}>✗</span> not patched</span>
                <span><span style={{ color: "#949ba4" }}>?</span> cannot detect</span>
            </div>
        </div>
    );
}

function StereoModal({ modalProps }: { modalProps: { onClose(): void; transitionState: number; }; }) {
    const [tab, setTab] = useState<"settings" | "patches">("settings");

    return (
        <ModalRoot {...modalProps} size={ModalSize.SMALL} className={cl("modal")}>
            <ModalHeader className={cl("header")}>
                <div className={cl("title-row")}>
                    <div className={cl("title-icon")}>
                        <StereoIcon width={20} height={20} />
                    </div>
                    <div className={cl("title-text")}>
                        <Span size="lg" weight="bold" color="text-default">Stereo Audio</Span>
                    </div>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <div className={cl("tabs-row")}>
                <TabBar
                    type="top"
                    look="brand"
                    selectedItem={tab}
                    onItemSelect={(t: string) => setTab(t as typeof tab)}
                >
                    <TabBar.Item id="settings" className={cl("tab-item")}>Settings</TabBar.Item>
                    <TabBar.Item id="patches" className={cl("tab-item")}>Patches</TabBar.Item>
                </TabBar>
            </div>

            <div className={cl("body")}>
                {tab === "settings" && <SettingsPanel />}
                {tab === "patches" && <PatchesPanel />}
            </div>
        </ModalRoot>
    );
}

function registerDock() {
    addDockButton("stereo", {
        icon: StereoIcon,
        tooltipText: "Stereo Audio",
        glowing: settings.store.enabled,
        glowColor: "green",
        onClick: () => {
            settings.store.enabled = !settings.store.enabled;
            applyTransport();
            registerDock();
        },
        onContextMenu: e => {
            e.preventDefault();
            openStereoModal();
        },
    });
}

export default definePlugin({
    name: "Stereo",
    openSettingsModal: openStereoModal,
    description: "Set audio bitrate and channel count. Optionally force mono on incoming audio.",
    authors: [{ name: "gabe", id: 1467949308816003193n }],
    dependencies: ["PluginDock"],
    settings,

    start() {
        registerDock();
        const emitter = MediaEngineStore.getMediaEngine().emitter;

        emitter.on("connection", (connection: any) => {
            if (connection.context !== "default") return;

            const originalSetTransport = connection.conn.setTransportOptions;
            connection.conn.setTransportOptions = function (this: any, options: Record<string, any>) {
                lastTransportOptions = { ...options };
                for (const key in options) {
                    if (key === "encodingVoiceBitRate") options[key] = getEffectiveBitrate();
                    else if (key === "audioEncoder") options[key] = getEncoderOptions();
                    else if (key === "audioDecoders") options[key][0] = getDecoderOptions();
                }
                return Reflect.apply(originalSetTransport, this, [options]);
            };

            ActiveConnection = connection;
        });
    },

    stop() {
        removeDockButton("stereo");
        ActiveConnection = undefined;
        lastTransportOptions = null;
    },
});
