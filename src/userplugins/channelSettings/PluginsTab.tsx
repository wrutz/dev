/*
 * Equicord, a Discord client mod
 * Copyright (c) 2026 Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled, pluginRequiresRestart, startDependenciesRecursive, startPlugin, stopPlugin } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { openPluginModal } from "@components/settings/tabs/plugins/PluginModal";
import { classes } from "@utils/misc";
import { Plugin } from "@utils/types";
import { Select, TextInput, useMemo, useState } from "@webpack/common";

import { cl, getMyPlugins } from "./shared";

const enum SortMode {
    AZ = "az",
    ZA = "za",
    ENABLED = "enabled",
    HAS_SETTINGS = "hasSettings",
}

function CogIcon() {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.26.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" />
        </svg>
    );
}

function OpenExternalIcon() {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 9.00001L21 3.00001M21 3.00001H15M21 3.00001L12 12M10 3H7.8C6.11984 3 5.27976 3 4.63803 3.32698C4.07354 3.6146 3.6146 4.07354 3.32698 4.63803C3 5.27976 3 6.11984 3 7.8V16.2C3 17.8802 3 18.7202 3.32698 19.362C3.6146 19.9265 4.07354 20.3854 4.63803 20.673C5.27976 21 6.11984 21 7.8 21H16.2C17.8802 21 18.7202 21 19.362 20.673C19.9265 20.3854 20.3854 19.9265 20.673 19.362C21 18.7202 21 17.8802 21 16.2V14"/>
        </svg>
    );
}

function togglePlugin(plugin: Plugin) {
    const wasEnabled = isPluginEnabled(plugin.name);
    const pluginSettings = Settings.plugins[plugin.name];
    if (!wasEnabled) {
        const { failures } = startDependenciesRecursive(plugin);
        if (failures.length) return;
    }
    if (pluginRequiresRestart(plugin)) {
        pluginSettings.enabled = !wasEnabled;
        return;
    }
    if (wasEnabled && !plugin.started) {
        pluginSettings.enabled = !wasEnabled;
        return;
    }
    const ok = wasEnabled ? stopPlugin(plugin) : startPlugin(plugin);
    pluginSettings.enabled = ok ? !wasEnabled : wasEnabled;
}

function PluginCard({ plugin, onChange }: { plugin: Plugin; onChange(): void; }) {
    const enabled = isPluginEnabled(plugin.name);
    const hasCustomModal = typeof (plugin as any).openSettingsModal === "function";
    const hasSettings = !!(plugin.settings && Object.keys(plugin.settings.def ?? {}).length > 0);

    return (
        <div className={classes(cl("plugin-card"), enabled ? cl("plugin-card-enabled") : cl("plugin-card-disabled"))}>
            <div className={cl("plugin-card-info")}>
                <div className={cl("plugin-card-name")}>{plugin.name}</div>
                <div className={cl("plugin-card-desc")}>{plugin.description}</div>
            </div>
            <div className={cl("plugin-card-actions")}>
                {hasCustomModal && (
                    <button
                        type="button"
                        className={cl("plugin-card-cog")}
                        onClick={() => (plugin as any).openSettingsModal()}
                        aria-label={`Open ${plugin.name} UI`}
                        title={`Open ${plugin.name}`}
                    >
                        <OpenExternalIcon />
                    </button>
                )}
                {hasSettings && (
                    <button
                        type="button"
                        className={cl("plugin-card-cog")}
                        onClick={() => openPluginModal(plugin, () => { })}
                        aria-label={`${plugin.name} settings`}
                        title="Settings"
                    >
                        <CogIcon />
                    </button>
                )}
                <button
                    type="button"
                    className={classes(cl("plugin-toggle"), enabled && cl("plugin-toggle-on"))}
                    onClick={() => { togglePlugin(plugin); onChange(); }}
                    aria-label={`Toggle ${plugin.name}`}
                >
                    <div className={cl("plugin-toggle-knob")} />
                </button>
            </div>
        </div>
    );
}

export function PluginsTab() {
    const allPlugins = useMemo(getMyPlugins, []);
    const [search, setSearch] = useState("");
    const [sort, setSort] = useState<SortMode>(SortMode.AZ);
    const [, force] = useState(0);

    const plugins = useMemo(() => {
        let list = allPlugins;
        if (search) {
            const q = search.toLowerCase();
            list = list.filter(p =>
                p.name.toLowerCase().includes(q) ||
                p.description?.toLowerCase().includes(q),
            );
        }
        if (sort === SortMode.ZA) return [...list].sort((a, b) => b.name.localeCompare(a.name));
        if (sort === SortMode.ENABLED) {
            return [...list].sort((a, b) => Number(isPluginEnabled(b.name)) - Number(isPluginEnabled(a.name)));
        }
        if (sort === SortMode.HAS_SETTINGS) {
            return [...list].sort((a, b) => {
                const aHas = typeof (a as any).openSettingsModal === "function" ? 1 : 0;
                const bHas = typeof (b as any).openSettingsModal === "function" ? 1 : 0;
                return bHas - aHas;
            });
        }
        return list;
    }, [allPlugins, search, sort]);

    if (!allPlugins.length) {
        return (
            <div className={cl("empty")}>No plugins match your author filter.</div>
        );
    }

    return (
        <div className={cl("plugins-wrap")}>
            <div className={cl("plugins-toolbar")}>
                <div className={cl("plugins-search")}>
                    <TextInput
                        value={search}
                        onChange={setSearch}
                        placeholder="Search plugins..."
                    />
                </div>
                <Select
                    options={[
                        { label: "A → Z", value: SortMode.AZ, default: true },
                        { label: "Z → A", value: SortMode.ZA },
                        { label: "Enabled first", value: SortMode.ENABLED },
                        { label: "Has settings", value: SortMode.HAS_SETTINGS },
                    ]}
                    serialize={String}
                    select={v => setSort(v)}
                    isSelected={v => v === sort}
                    closeOnSelect
                    className={cl("plugins-sort")}
                />
            </div>
            {plugins.length ? (
                <div className={cl("plugins-grid")}>
                    {plugins.map(p => <PluginCard key={p.name} plugin={p} onChange={() => force(x => x + 1)} />)}
                </div>
            ) : (
                <div className={cl("empty")}>No plugins match your search.</div>
            )}
        </div>
    );
}
