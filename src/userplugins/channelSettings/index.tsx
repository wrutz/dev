/*
 * Equicord, a Discord client mod
 * Copyright (c) 2026 Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings, Settings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings/tabs/plugins/PluginModal";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, FluxDispatcher, NavigationRouter, ScrollerThin, useEffect, useRef, useState } from "@webpack/common";

import { addDockButton, removeDockButton, setDockOverride } from "../pluginDock";
import { AboutTab } from "./AboutTab";
import { DockTab } from "./DockTab";
import { KeybindsTab } from "./KeybindsTab";
import { PluginsTab } from "./PluginsTab";
import { cl, matchKeybind, parseKeybind, parseStringArray, parseStringMap } from "./shared";

const enum Tab {
    PLUGINS = "plugins",
    KEYBINDS = "keybinds",
    DOCK = "dock",
    ABOUT = "about",
}

const TAB_LABELS: Record<Tab, string> = {
    [Tab.PLUGINS]: "Plugins",
    [Tab.KEYBINDS]: "Keybinds",
    [Tab.DOCK]: "Dock",
    [Tab.ABOUT]: "About",
};

const settings = definePluginSettings({
    channelId: {
        type: OptionType.STRING,
        description: "Channel ID to hijack as the settings page. Leave empty to disable.",
        default: "",
    },
    dockOrder: {
        type: OptionType.STRING,
        description: "JSON array of dock button IDs in display order.",
        default: "[]",
    },
    dockHidden: {
        type: OptionType.STRING,
        description: "JSON array of dock button IDs to hide.",
        default: "[]",
    },
    keybindMap: {
        type: OptionType.STRING,
        description: "JSON map of plugin.settingKey to keybind string for boolean toggles.",
        default: "{}",
    },
});

function getChannelId(): string {
    return settings.store.channelId?.trim() ?? "";
}

export function navigateToSettings() {
    const id = getChannelId();
    if (!id) return;
    const ch = ChannelStore.getChannel(id);
    NavigationRouter.transitionTo(`/channels/${ch?.guild_id ?? "@me"}/${id}`);
}

function SettingsCogIcon({ width = 20, height = 20 }: { width?: number; height?: number; }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
        </svg>
    );
}

function registerCogButton() {
    addDockButton("channelSettings", {
        icon: SettingsCogIcon,
        tooltipText: "Channel Settings",
        onClick: () => {
            const id = getChannelId();
            if (!id) {
                const self = Object.values((globalThis as any).Vencord?.Plugins?.plugins ?? {}).find((p: any) => p?.name === "ChannelSettings");
                if (self) openPluginModal(self as any, () => { });
                return;
            }
            navigateToSettings();
        },
        onContextMenu: e => {
            e.preventDefault();
            const self = Object.values((globalThis as any).Vencord?.Plugins?.plugins ?? {}).find((p: any) => p?.name === "ChannelSettings");
            if (self) openPluginModal(self as any, () => { });
        },
    });
}

function SettingsPageInner() {
    const [activeTab, setActiveTab] = useState<Tab>(Tab.PLUGINS);

    return (
        <div className={cl("page")}>
            <div className={cl("header")}>
                <div className={cl("title-main")}>Channel Settings</div>
                <div className={cl("title-sub")}>Manage your plugins, keybinds, dock, and more</div>
            </div>

            <div className={cl("tab-bar")}>
                {(Object.keys(TAB_LABELS) as Tab[]).map(tab => (
                    <button
                        key={tab}
                        type="button"
                        className={classes(cl("tab"), activeTab === tab && cl("tab-active"))}
                        onClick={() => setActiveTab(tab)}
                    >
                        {TAB_LABELS[tab]}
                    </button>
                ))}
            </div>

            <ScrollerThin fade className={cl("scroller")}>
                <div className={cl("content")}>
                    {activeTab === Tab.PLUGINS && <PluginsTab />}
                    {activeTab === Tab.KEYBINDS && <KeybindsTab />}
                    {activeTab === Tab.DOCK && <DockTab settings={settings.store} />}
                    {activeTab === Tab.ABOUT && <AboutTab />}
                </div>
            </ScrollerThin>
        </div>
    );
}

const SettingsPage = ErrorBoundary.wrap(SettingsPageInner, { noop: true });

function hiddenSet(): Set<string> {
    return new Set(parseStringArray(settings.store.dockHidden));
}

function orderArr(): string[] {
    return parseStringArray(settings.store.dockOrder);
}

function handleKeybind(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (target) {
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        if (target.isContentEditable) return;
    }

    const map = parseStringMap(settings.store.keybindMap);
    for (const [id, kbStr] of Object.entries(map)) {
        const kb = parseKeybind(kbStr);
        if (!kb) continue;
        if (!matchKeybind(e, kb)) continue;

        const dot = id.indexOf(".");
        if (dot < 0) continue;
        const pluginName = id.slice(0, dot);
        const key = id.slice(dot + 1);
        const bucket = Settings.plugins[pluginName];
        if (!bucket) continue;

        bucket[key] = !bucket[key];
        e.preventDefault();
        e.stopPropagation();
        return;
    }
}

export default definePlugin({
    name: "ChannelSettings",
    description: "Turns a configurable Discord channel into a settings page for all your plugins.",
    authors: [{ name: "gabe", id: 1467949308816003193n }],
    dependencies: ["PluginDock"],
    settings,

    patches: [
        {
            find: "Missing channel in Channel.renderHeaderToolbar",
            replacement: [
                {
                    match: /(?<=renderChat\(\){)/,
                    replace: "if(this.props.channel?.id&&this.props.channel.id===$self.getChannelId())return $self.SettingsPage();",
                },
                {
                    match: /(?<=renderSidebar\(\){)/,
                    replace: "if(this.props.channel?.id&&this.props.channel.id===$self.getChannelId())return null;",
                },
            ],
        },
    ],

    start() {
        setDockOverride({ getHidden: hiddenSet, getOrder: orderArr });
        registerCogButton();
        document.addEventListener("keydown", handleKeybind, true);
    },

    stop() {
        setDockOverride(null);
        removeDockButton("channelSettings");
        document.removeEventListener("keydown", handleKeybind, true);
    },

    getChannelId,
    SettingsPage: () => <SettingsPage />,
});
