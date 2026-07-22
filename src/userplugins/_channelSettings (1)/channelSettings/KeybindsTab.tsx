/*
 * Equicord, a Discord client mod
 * Copyright (c) 2026 Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";
import { Plugin } from "@utils/types";
import { TextInput, useMemo, useState } from "@webpack/common";

import { cl, getBooleanSettings, getKeybindSettings, parseStringMap, SettingEntry } from "./shared";

interface Row {
    id: string;
    label: string;
    value: string;
    defaultVal: string;
    placeholder: string;
    onChange: (v: string) => void;
}

function makePluginOwnedRow(e: SettingEntry): Row {
    return {
        id: `${e.plugin.name}::${e.key}`,
        label: e.label,
        value: (Settings.plugins[e.plugin.name]?.[e.key] as string) ?? e.default,
        defaultVal: e.default,
        placeholder: "",
        onChange: v => { Settings.plugins[e.plugin.name][e.key] = v; },
    };
}

function makeCentralRow(e: SettingEntry, map: Record<string, string>): Row {
    const mapKey = `${e.plugin.name}.${e.key}`;
    return {
        id: `${e.plugin.name}::toggle::${e.key}`,
        label: `Toggle: ${e.label}`,
        value: map[mapKey] ?? "",
        defaultVal: "",
        placeholder: "",
        onChange: v => {
            const current = parseStringMap(Settings.plugins.ChannelSettings?.keybindMap);
            if (v) current[mapKey] = v;
            else delete current[mapKey];
            Settings.plugins.ChannelSettings.keybindMap = JSON.stringify(current);
        },
    };
}

function KeybindRow({ row }: { row: Row; }) {
    const [value, setValue] = useState(row.value);

    const commit = (v: string) => {
        setValue(v);
        row.onChange(v);
    };

    return (
        <div className={cl("keybind-row")}>
            <div className={cl("keybind-label")}>{row.label}</div>
            <div className={cl("keybind-controls")}>
                <div className={cl("keybind-input")}>
                    <TextInput
                        value={value}
                        onChange={commit}
                        placeholder={row.placeholder}
                    />
                </div>
                <button
                    type="button"
                    className={cl("keybind-reset")}
                    onClick={() => commit(row.defaultVal)}
                    disabled={value === row.defaultVal}
                >
                    Reset
                </button>
            </div>
        </div>
    );
}

export function KeybindsTab() {
    const { groups, hasAny } = useMemo(() => {
        const keybindGroups = getKeybindSettings();
        const booleanGroups = getBooleanSettings();
        const map = parseStringMap(Settings.plugins.ChannelSettings?.keybindMap);

        const seen = new Set<string>([...keybindGroups.keys(), ...booleanGroups.keys()]);
        const plugins: Plugin[] = [];
        for (const name of seen) {
            const entry = keybindGroups.get(name)?.[0]?.plugin ?? booleanGroups.get(name)?.[0]?.plugin;
            if (entry) plugins.push(entry);
        }
        plugins.sort((a, b) => a.name.localeCompare(b.name));

        const groups = plugins.map(plugin => {
            const rows: Row[] = [
                ...(keybindGroups.get(plugin.name) ?? []).map(makePluginOwnedRow),
                ...(booleanGroups.get(plugin.name) ?? []).map(e => makeCentralRow(e, map)),
            ];
            return { name: plugin.name, rows };
        }).filter(g => g.rows.length);

        return { groups, hasAny: groups.length > 0 };
    }, []);

    if (!hasAny) {
        return <div className={cl("empty")}>No toggleable settings or keybinds found.</div>;
    }

    return (
        <div className={cl("keybinds-list")}>
            <div className={cl("keybind-hint")}>Bindings are checked globally. Leave a field empty to unbind. Format: Alt+K, Ctrl+Shift+P, etc.</div>
            {groups.map(g => (
                <div key={g.name} className={cl("keybind-group")}>
                    <div className={cl("keybind-group-header")}>{g.name}</div>
                    {g.rows.map(r => <KeybindRow key={r.id} row={r} />)}
                </div>
            ))}
        </div>
    );
}
