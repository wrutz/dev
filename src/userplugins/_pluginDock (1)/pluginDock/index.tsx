/*
 * Equicord, a modification for Discord's desktop app
 * Copyright (c) 2026 Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Menu, useCallback, useEffect, useRef, useState } from "@webpack/common";
import type { ComponentType, MouseEventHandler, ReactNode } from "react";

const cl = classNameFactory("vc-plugin-dock-");
const logger = new Logger("PluginDock");

const PanelButton = findComponentByCodeLazy("tooltipPositionKey", "positionKeyStemOverride");

export interface DockButtonProps {
    icon: ComponentType<{ width?: number; height?: number; size?: string; color?: string; colorClass?: string; }>;
    tooltipText: string;
    onClick: MouseEventHandler;
    onContextMenu?: MouseEventHandler;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    glowing?: boolean;
    glowColor?: "red" | "green";
    priority?: number;
}

export interface DockEntry {
    props: DockButtonProps;
    priority: number;
}

const dockItems = new Map<string, DockEntry>();
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach(fn => fn());
}

export function addDockButton(id: string, props: DockButtonProps) {
    dockItems.set(id, { props, priority: props.priority ?? 0 });
    notify();
}

export function removeDockButton(id: string) {
    dockItems.delete(id);
    notify();
}

export function getDockItems(): Array<[string, DockEntry]> {
    return Array.from(dockItems);
}

export function addDockMutationListener(fn: () => void) {
    listeners.add(fn);
}

export function removeDockMutationListener(fn: () => void) {
    listeners.delete(fn);
}

interface DockOverride {
    getHidden(): Set<string>;
    getOrder(): string[];
}

let dockOverride: DockOverride | null = null;

export function setDockOverride(override: DockOverride | null) {
    dockOverride = override;
    notify();
}

export function refreshDock() {
    notify();
}

export type UserContextEntryRenderer = (userId: string, channelId?: string) => ReactNode | null;

const userContextEntries = new Map<string, UserContextEntryRenderer>();

export function addUserContextEntry(id: string, render: UserContextEntryRenderer) {
    userContextEntries.set(id, render);
}

export function removeUserContextEntry(id: string) {
    userContextEntries.delete(id);
}

const userContextPatch: NavContextMenuPatchCallback = (children, props) => {
    try {
    if (!props) return;
    if (!props.user?.id) return;
    if (userContextEntries.size === 0) return;

    const userId = props.user.id;
    const channelId = props.channel?.id;

    const items = Array.from(userContextEntries).map(([, render]) => {
        try { return render(userId, channelId); } catch { return null; }
    }).filter(Boolean);

    if (items.length === 0) return;

    children.unshift(
        <Menu.MenuGroup>
            <Menu.MenuItem id="plugin-dock-menu" label="Plugins">
                {items}
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
    } catch { }
};

export type MessageContextEntryRenderer = (message: any, channelId?: string) => ReactNode | null;
const messageContextEntries = new Map<string, MessageContextEntryRenderer>();
export function addMessageContextEntry(id: string, render: MessageContextEntryRenderer) {
    messageContextEntries.set(id, render);
}
export function removeMessageContextEntry(id: string) {
    messageContextEntries.delete(id);
}
const messageContextPatch: NavContextMenuPatchCallback = (children, props) => {
    try {
        if (!props?.message) return;
        if (messageContextEntries.size === 0) return;
        const message = props.message;
        const channelId = message.channel_id ?? props.channel?.id;
        const items = Array.from(messageContextEntries).map(([, render]) => {
            try { return render(message, channelId); } catch { return null; }
        }).filter(Boolean);
        if (items.length === 0) return;
        children.push(
            <Menu.MenuGroup>
                <Menu.MenuItem id="plugin-dock-message-menu" label="Plugins">
                    {items}
                </Menu.MenuItem>
            </Menu.MenuGroup>
        );
    } catch { }
};

export type GuildContextEntryRenderer = (guild: any) => ReactNode | null;
const guildContextEntries = new Map<string, GuildContextEntryRenderer>();
export function addGuildContextEntry(id: string, render: GuildContextEntryRenderer) {
    guildContextEntries.set(id, render);
}
export function removeGuildContextEntry(id: string) {
    guildContextEntries.delete(id);
}
const guildContextPatch: NavContextMenuPatchCallback = (children, props) => {
    try {
        if (!props?.guild) return;
        if (guildContextEntries.size === 0) return;
        const items = Array.from(guildContextEntries).map(([, render]) => {
            try { return render(props.guild); } catch { return null; }
        }).filter(Boolean);
        if (items.length === 0) return;
        children.push(
            <Menu.MenuGroup>
                <Menu.MenuItem id="plugin-dock-guild-menu" label="Plugins">
                    {items}
                </Menu.MenuItem>
            </Menu.MenuGroup>
        );
    } catch { }
};

export type ChatInputContextEntryRenderer = () => ReactNode | null;
const chatInputContextEntries = new Map<string, ChatInputContextEntryRenderer>();
export function addChatInputContextEntry(id: string, render: ChatInputContextEntryRenderer) {
    chatInputContextEntries.set(id, render);
}
export function removeChatInputContextEntry(id: string) {
    chatInputContextEntries.delete(id);
}
const chatInputContextPatch: NavContextMenuPatchCallback = (children) => {
    try {
        if (chatInputContextEntries.size === 0) return;
        const items = Array.from(chatInputContextEntries).map(([, render]) => {
            try { return render(); } catch { return null; }
        }).filter(Boolean);
        if (items.length === 0) return;
        children.push(
            <Menu.MenuGroup>
                <Menu.MenuItem id="plugin-dock-chat-input-menu" label="Plugins">
                    {items}
                </Menu.MenuItem>
            </Menu.MenuGroup>
        );
    } catch { }
};

function DockItem({ props }: { props: DockButtonProps; }) {
    const [pressed, setPressed] = useState(false);
    const [animating, setAnimating] = useState(false);
    const cooldown = useRef(false);
    const itemRef = useRef<HTMLDivElement>(null);

    const handleMouseDown = useCallback(() => setPressed(true), []);

    const handleMouseEnter = useCallback(() => {
        itemRef.current?.classList.add(cl("hovered"));
        props.onMouseEnter?.();
    }, [props.onMouseEnter]);

    const handleMouseLeave = useCallback(() => {
        props.onMouseLeave?.();
        itemRef.current?.classList.remove(cl("hovered"));
    }, [props.onMouseLeave]);

    const handleContextMenu = useCallback<MouseEventHandler>(e => {
        if (!props.onContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        props.onContextMenu(e);
    }, [props.onContextMenu]);

    const handleClick = useCallback<MouseEventHandler>(e => {
        if (cooldown.current) return;
        cooldown.current = true;
        setAnimating(true);
        props.onClick(e);
        setTimeout(() => { setAnimating(false); cooldown.current = false; }, 400);
    }, [props.onClick]);

    useEffect(() => {
        const up = () => setPressed(false);
        window.addEventListener("mouseup", up);
        return () => { window.removeEventListener("mouseup", up); };
    }, []);

    return (
        <div
            ref={itemRef}
            className={classes(
                cl("item"),
                props.glowing ? cl("glowing") : "",
                props.glowing && props.glowColor === "green" ? cl("glow-green") : "",
                pressed ? cl("pressed") : "",
                animating ? cl("pop") : ""
            )}
            onMouseDown={handleMouseDown}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onContextMenu={handleContextMenu}
        >
            <PanelButton
                icon={props.icon}
                tooltipText={props.tooltipText}
                onClick={handleClick}
            />
        </div>
    );
}

let globalCollapsed = false;
let globalHidden = false;
const collapseListeners = new Set<() => void>();

function setCollapsed(val: boolean) {
    globalCollapsed = val;
    collapseListeners.forEach(fn => fn());
}

function setHidden(val: boolean) {
    globalHidden = val;
    collapseListeners.forEach(fn => fn());
}

function PluginDockComponent() {
    const [, forceUpdate] = useState(0);
    const [collapsed, setLocalCollapsed] = useState(globalCollapsed);
    const [hidden, setLocalHidden] = useState(globalHidden);
    const dragging = useRef(false);
    const startY = useRef(0);
    const sepRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const listener = () => forceUpdate(n => n + 1);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }, []);

    useEffect(() => {
        const listener = () => {
            setLocalCollapsed(globalCollapsed);
            setLocalHidden(globalHidden);
        };
        collapseListeners.add(listener);
        return () => { collapseListeners.delete(listener); };
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.altKey && e.key.toLowerCase() === "h") {
                e.preventDefault();
                setHidden(!globalHidden);
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, []);

    const onMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragging.current = true;
        startY.current = e.clientY;
        sepRef.current?.classList.add(cl("dragging"));

        const onMove = (ev: MouseEvent) => {
            if (!dragging.current) return;
            const delta = ev.clientY - startY.current;
            if (delta > 20 && !globalCollapsed) {
                setCollapsed(true);
                dragging.current = false;
                sepRef.current?.classList.remove(cl("dragging"));
            } else if (delta < -20 && globalCollapsed) {
                setCollapsed(false);
                dragging.current = false;
                sepRef.current?.classList.remove(cl("dragging"));
            }
        };

        const onUp = () => {
            dragging.current = false;
            sepRef.current?.classList.remove(cl("dragging"));
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, []);

    if (dockItems.size === 0) return null;

    const overrideHidden = dockOverride?.getHidden() ?? new Set<string>();
    const order = dockOverride?.getOrder() ?? [];
    const orderIndex = new Map(order.map((id, i) => [id, i]));
    const sorted = Array.from(dockItems)
        .filter(([id]) => !overrideHidden.has(id))
        .sort(([aId, a], [bId, b]) => {
            const ai = orderIndex.get(aId);
            const bi = orderIndex.get(bId);
            if (ai != null && bi != null) return ai - bi;
            if (ai != null) return -1;
            if (bi != null) return 1;
            return a.priority - b.priority;
        });

    if (sorted.length === 0) return null;

    return (
        <div className={classes(cl("container"), hidden ? cl("hidden") : "")}>
            <div
                ref={sepRef}
                className={cl("separator")}
                onMouseDown={onMouseDown}
            />
            <div className={classes(cl("buttons-wrapper"), collapsed ? cl("collapsed") : "")}>
                <div className={cl("buttons")}>
                    {sorted.map(([id, { props }]) => (
                        <ErrorBoundary noop key={id} onError={e => logger.error(`Failed to render dock button ${id}`, e.error)}>
                            <DockItem props={props} />
                        </ErrorBoundary>
                    ))}
                </div>
            </div>
        </div>
    );
}

export default definePlugin({
    name: "PluginDock",
    description: "Adds a dock section below the user panel for plugin quick-access buttons.",
    authors: [{ name: "gabe", id: 1467949308816003193n }],

    contextMenus: {
        "user-context": userContextPatch,
        "message": messageContextPatch,
        "guild-context": guildContextPatch,
        "guild-header-popout": guildContextPatch,
        "textarea-context": chatInputContextPatch,
    },

    patches: [
        {
            find: "dismissTooltips:this.dismissTooltips",
            replacement: {
                match: /dismissTooltips:this\.dismissTooltips\}\)\]\}\)\}\),/,
                replace: "$&$self.renderDock(),"
            }
        }
    ],

    renderDock: ErrorBoundary.wrap(PluginDockComponent, { noop: true }),
});
