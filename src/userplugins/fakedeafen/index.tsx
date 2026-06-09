/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, ContextMenuApi, FluxDispatcher, Menu, React, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

import { addDockButton, removeDockButton } from "../pluginDock";

function FakeDeafenIcon({ colorClass, width, height }: { color?: string; colorClass?: string; width?: number; height?: number; }) {
    return (
        <svg className={colorClass} width={width ?? 20} height={height ?? 20} viewBox="0 0 24 24" fill="none">
            <mask id="vc-fakedeafen-mask">
                <rect fill="white" width="24" height="24" />
                <rect fill="black" x="9.75" y="-2" width="4.5" height="28" rx="2.25" transform="rotate(45 12 12)" />
            </mask>
            <path
                fill="currentColor"
                mask="url(#vc-fakedeafen-mask)"
                d="M12 3a9 9 0 0 0-8.95 10h1.87a5 5 0 0 1 4.1 2.13l1.37 1.97a3.1 3.1 0 0 1-.17 3.78 2.85 2.85 0 0 1-3.55.74 11 11 0 1 1 10.66 0c-1.27.71-2.73.23-3.55-.74a3.1 3.1 0 0 1-.17-3.78l1.38-1.97a5 5 0 0 1 4.1-2.13h1.86A9 9 0 0 0 12 3Z"
            />
            <line x1="21" y1="3" x2="3" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
    );
}

const { toggleSelfMute } = findByPropsLazy("toggleSelfMute");
const { toggleSelfDeaf } = findByPropsLazy("toggleSelfDeaf");
const VoiceStateStore = findByPropsLazy("getVoiceStateForUser");
const StreamStore = findByPropsLazy("getAnyStreamForUser");
let WxvVBFJelK = false;
const settings = definePluginSettings({
    enableFakeDeafen: {
        description: "Enable or disable fake deafen.",
        type: OptionType.BOOLEAN,
        default: true,
        onChange: () => { try { registerDockButton(); applyFakeDeaf(); } catch { } },
    },
    enableFakeMute: {
        description: "Enable or disable fake mute.",
        type: OptionType.BOOLEAN,
        default: true,
        onChange: () => { try { registerDockButton(); applyFakeMute(); } catch { } },
    },
    enableFakeVideo: {
        description: "Enable or disable fake camera.",
        type: OptionType.BOOLEAN,
        default: true,
        onChange: () => { try { registerDockButton(); } catch { } },
    },
    deafenKeybind: {
        description: "Keybind to toggle fake deafen.",
        type: OptionType.STRING,
        default: "",
    },
    muteKeybind: {
        description: "Keybind to toggle fake mute.",
        type: OptionType.STRING,
        default: "",
    },
});

function matchKb(e: KeyboardEvent, str: string): boolean {
    if (!str) return false;
    let ctrl = false, alt = false, shift = false, meta = false, key = "";
    for (const p of str.split("+").map(s => s.trim().toLowerCase()).filter(Boolean)) {
        if (p === "ctrl" || p === "control") ctrl = true;
        else if (p === "alt") alt = true;
        else if (p === "shift") shift = true;
        else if (p === "meta" || p === "cmd" || p === "super") meta = true;
        else key = p;
    }
    return !!key && ctrl === e.ctrlKey && alt === e.altKey && shift === e.shiftKey && meta === e.metaKey && e.key.toLowerCase() === key;
}

function BXaaaxFOZH(e) {
    if (matchKb(e, settings.store.deafenKeybind)) {
        settings.store.enableFakeDeafen = !settings.store.enableFakeDeafen;
        Toasts.show({
            message: `Fake deafen is now: ${settings.store.enableFakeDeafen ? "disabled" : "enabled"}`,
            id: "fake-deafen",
            type: Toasts.Type.FAILURE,
            options: { position: Toasts.Position.BOTTOM }
        });
        WxvVBFJelK = true;
        toggleSelfDeaf();
        toggleSelfDeaf();
        WxvVBFJelK = false;
    }
}

function ZGhRbNJztb(e) {
    if (matchKb(e, settings.store.muteKeybind)) {
        settings.store.enableFakeMute = !settings.store.enableFakeMute;
        Toasts.show({
            message: `Fake mute is now: ${settings.store.enableFakeMute ? "disabled" : "enabled"}`,
            id: "fake-mute",
            type: Toasts.Type.FAILURE,
            options: { position: Toasts.Position.BOTTOM }
        });
        WxvVBFJelK = true;
        toggleSelfMute();
        toggleSelfMute();
        WxvVBFJelK = false;
    }
}

function applyFakeDeaf() {
    WxvVBFJelK = true;
    toggleSelfDeaf();
    toggleSelfDeaf();
    WxvVBFJelK = false;
}

function applyFakeMute() {
    WxvVBFJelK = true;
    toggleSelfMute();
    toggleSelfMute();
    WxvVBFJelK = false;
}

function applyFakeVideo() {
    WxvVBFJelK = true;
    toggleSelfDeaf();
    toggleSelfDeaf();
    WxvVBFJelK = false;
}

function toggleFakeStream() {
    const me = UserStore.getCurrentUser();
    const vs = VoiceStateStore.getVoiceStateForUser(me?.id);
    if (!vs?.channelId) return;

    const existing = StreamStore.getAnyStreamForUser(me.id);
    if (existing) {
        FluxDispatcher.dispatch({ type: "STREAM_CLOSE", streamKey: `guild:${vs.guildId ?? ""}:${vs.channelId}:${me.id}` });
        return;
    }

    const channel = ChannelStore.getChannel(vs.channelId);
    FluxDispatcher.dispatch({
        type: "STREAM_START",
        streamType: "guild",
        guildId: channel?.guild_id,
        channelId: vs.channelId,
    });
}

function isAnyFakeActive() {
    return !settings.store.enableFakeDeafen || !settings.store.enableFakeMute || !settings.store.enableFakeVideo;
}

function FakeDeafenContextMenu() {
    const [, forceUpdate] = React.useState(0);
    return (
        <Menu.Menu navId="fakedeafen-menu" onClose={() => ContextMenuApi.closeContextMenu()}>
            <Menu.MenuGroup label="FAKE STATES">
                <Menu.MenuCheckboxItem
                    id="fake-deafen"
                    label="Fake Deafen"
                    checked={!settings.store.enableFakeDeafen}
                    action={() => {
                        settings.store.enableFakeDeafen = !settings.store.enableFakeDeafen;
                        applyFakeDeaf();
                        registerDockButton();
                        forceUpdate(n => n + 1);
                    }}
                />
                <Menu.MenuCheckboxItem
                    id="fake-mute"
                    label="Fake Mute"
                    checked={!settings.store.enableFakeMute}
                    action={() => {
                        settings.store.enableFakeMute = !settings.store.enableFakeMute;
                        applyFakeMute();
                        registerDockButton();
                        forceUpdate(n => n + 1);
                    }}
                />
                <Menu.MenuCheckboxItem
                    id="fake-video"
                    label="Fake Camera"
                    checked={!settings.store.enableFakeVideo}
                    action={() => {
                        settings.store.enableFakeVideo = !settings.store.enableFakeVideo;
                        applyFakeVideo();
                        registerDockButton();
                        forceUpdate(n => n + 1);
                    }}
                />
                <Menu.MenuItem
                    id="fake-stream"
                    label="Fake Screenshare"
                    action={() => {
                        toggleFakeStream();
                        forceUpdate(n => n + 1);
                    }}
                />
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}

function registerDockButton() {
    addDockButton("fakedeafen", {
        icon: FakeDeafenIcon,
        tooltipText: "Fake Deafen",
        glowing: isAnyFakeActive(),
        glowColor: "green",
        onClick: () => {
            settings.store.enableFakeDeafen = !settings.store.enableFakeDeafen;
            applyFakeDeaf();
            registerDockButton();
        },
        onContextMenu: e => {
            e.preventDefault();
            ContextMenuApi.openContextMenu(e, () => <FakeDeafenContextMenu />);
        },
    });
}

export default definePlugin({
    name: "FakeDeafen",
    description: "Fake deafen, mute, camera, and screenshare. Ctrl+L for deafen, Ctrl+J for mute.",
    authors: [{ name: "gabe", id: 1467949308816003193n }],
    dependencies: ["PluginDock"],
    settings,

    state: (type: string, real: boolean) => {
        if (type === "mute" && !settings.store.enableFakeMute) return true;
        if (type === "deafen" && !settings.store.enableFakeDeafen) return true;
        if (type === "video" && !settings.store.enableFakeVideo) return true;
        return real;
    },

    patches: [
        {
            find: "}voiceStateUpdate(",
            replacement: {
                match: /self_mute:(\i),self_deaf:(\i),self_video:(\i),flags:(\i)\}/,
                replace: "self_mute:$self.state('mute',$1),self_deaf:$self.state('deafen',$2),self_video:$self.state('video',$3),flags:$4}",
            }
        },
    ],

    start() {
        registerDockButton();
        document.addEventListener("keydown", BXaaaxFOZH);
        document.addEventListener("keydown", ZGhRbNJztb);
        SelectedChannelStore.addChangeListener(this.handleVoiceChannelChange);
    },
    stop() {
        removeDockButton("fakedeafen");
        document.removeEventListener("keydown", BXaaaxFOZH);
        document.removeEventListener("keydown", ZGhRbNJztb);
        SelectedChannelStore.removeChangeListener(this.handleVoiceChannelChange);
    },
    handleVoiceChannelChange() { }
});
