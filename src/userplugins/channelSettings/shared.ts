/*
 * Equicord, a Discord client mod
 * Copyright (c) 2026 Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { OptionType, Plugin } from "@utils/types";

import Plugins from "~plugins";

export const cl = classNameFactory("vc-chsettings-");

export const MY_AUTHOR_ID = 1467949308816003193n;
export const MY_DISCORD_ID = "1467949308816003193";

export function getMyPlugins(): Plugin[] {
    return Object.values(Plugins)
        .filter(p => p.authors?.some(a => a?.id === MY_AUTHOR_ID))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SettingEntry {
    plugin: Plugin;
    key: string;
    label: string;
    default: string;
}

export function parseStringArray(raw: string | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(x => typeof x === "string") : [];
    } catch {
        return [];
    }
}

export function parseStringMap(raw: string | undefined): Record<string, string> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string") out[k] = v;
        }
        return out;
    } catch {
        return {};
    }
}

export interface ParsedKeybind {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
    key: string;
}

export function parseKeybind(str: string | undefined): ParsedKeybind | null {
    if (!str) return null;
    const parts = str.split("+").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return null;
    const kb: ParsedKeybind = { ctrl: false, alt: false, shift: false, meta: false, key: "" };
    for (const p of parts) {
        if (p === "ctrl" || p === "control") kb.ctrl = true;
        else if (p === "alt") kb.alt = true;
        else if (p === "shift") kb.shift = true;
        else if (p === "meta" || p === "cmd" || p === "super") kb.meta = true;
        else kb.key = p;
    }
    return kb.key ? kb : null;
}

export function matchKeybind(e: KeyboardEvent, kb: ParsedKeybind): boolean {
    return kb.ctrl === e.ctrlKey
        && kb.alt === e.altKey
        && kb.shift === e.shiftKey
        && kb.meta === e.metaKey
        && e.key.toLowerCase() === kb.key;
}

export function getBooleanSettings(): Map<string, SettingEntry[]> {
    const grouped = new Map<string, SettingEntry[]>();
    for (const p of getMyPlugins()) {
        const def = p.settings?.def;
        if (!def) continue;
        for (const key of Object.keys(def)) {
            if (def[key]?.type !== OptionType.BOOLEAN) continue;
            const entry: SettingEntry = {
                plugin: p,
                key,
                label: def[key]?.description ?? key,
                default: String((def[key] as any)?.default ?? false),
            };
            const list = grouped.get(p.name) ?? [];
            list.push(entry);
            grouped.set(p.name, list);
        }
    }
    return grouped;
}

export function getKeybindSettings(): Map<string, SettingEntry[]> {
    const grouped = new Map<string, SettingEntry[]>();
    for (const p of getMyPlugins()) {
        const def = p.settings?.def;
        if (!def) continue;
        for (const key of Object.keys(def)) {
            if (!key.toLowerCase().includes("keybind")) continue;
            const entry: SettingEntry = {
                plugin: p,
                key,
                label: def[key]?.description ?? key,
                default: (def[key] as any)?.default ?? "",
            };
            const list = grouped.get(p.name) ?? [];
            list.push(entry);
            grouped.set(p.name, list);
        }
    }
    return grouped;
}
