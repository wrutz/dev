/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { UserAreaButton } from "@api/UserArea";
import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { React, Menu, ChannelStore, UserStore, IconUtils, ContextMenuApi, MessageStore, SelectedChannelStore, FluxDispatcher, MessageActions } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

import { addDockButton, removeDockButton, addUserContextEntry, removeUserContextEntry } from "../pluginDock";

function StealthDockIcon({ colorClass, width, height }: { color?: string; colorClass?: string; width?: number; height?: number; }) {
    return (
        <svg className={colorClass} width={width ?? 20} height={height ?? 20} viewBox="0 0 24 24" fill="currentColor">
            <g className="vc-dock-stealth-icon" style={{ transformOrigin: "12px 12px" }}>
                <path fillRule="evenodd" clipRule="evenodd" d="M23.27 12c-.7-1.17-2.33-3.5-4.67-5.18C16.27 5.14 14.14 4 12 4S7.73 5.14 5.4 6.82C3.06 8.5 1.43 10.83.73 12c.7 1.17 2.33 3.5 4.67 5.18C7.73 18.86 9.86 20 12 20s4.27-1.14 6.6-2.82c2.34-1.68 3.97-4.01 4.67-5.18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
            </g>
        </svg>
    );
}

function registerStealthDock() {
    addDockButton("stealth", {
        icon: StealthDockIcon,
        tooltipText: "Stealth",
        glowing: settings.store.active,
        glowColor: "green",
        onClick: () => {
            toggleStealth();
            registerStealthDock();
        },
        onContextMenu: e => {
            e.preventDefault();
            ContextMenuApi.openContextMenu(e, () => <StealthContextMenu />);
        },
    });
}

const PrivateChannelSortStore = findByPropsLazy("getPrivateChannelIds");

let patched = false;
const openedHiddenChannels = new Set<string>();
let origGetMessages: ((channelId: string) => any) | null = null;
let origGetPrivateChannelIds: (() => string[]) | null = null;

const settings = definePluginSettings({
    active: {
        type: OptionType.BOOLEAN,
        description: "Stealth mode active.",
        default: true,
        onChange: () => { try { registerStealthDock(); refresh(); } catch { } },
    },
    hiddenIds: {
        type: OptionType.STRING,
        description: "Hidden channel and user IDs separated by comma.",
        default: "",
    },
    keybind: {
        type: OptionType.STRING,
        description: "Keybind to toggle Stealth.",
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


function getHiddenSet(): Set<string> {
    return new Set(settings.store.hiddenIds.split(",").map(s => s.trim()).filter(Boolean));
}

function isHidden(channelId: string): boolean {
    const hidden = getHiddenSet();
    if (hidden.size === 0) return false;
    const ch = ChannelStore.getChannel(channelId);
    if (!ch || ch.guild_id) return false;
    if (hidden.has(channelId)) return true;
    if (ch.isGroupDM?.()) return false;
    const recipientId = ch.getRecipientId?.();
    return recipientId != null && hidden.has(recipientId);
}

function resolveTargetChannelId(id: string): string | null {
    const ch = ChannelStore.getChannel(id);
    if (ch) return id;
    return ChannelStore.getDMFromUserId?.(id) ?? null;
}

function addHidden(id: string) {
    const set = getHiddenSet();
    set.add(id);
    settings.store.hiddenIds = [...set].join(",");
    if (!settings.store.active) return;
    const targetChannelId = resolveTargetChannelId(id);
    if (targetChannelId) {
        clearStoredMessages(targetChannelId);
        if (SelectedChannelStore.getChannelId?.() === targetChannelId) {
            try {
                FluxDispatcher.dispatch({ type: "CHANNEL_SELECT", channelId: targetChannelId, guildId: null });
            } catch { }
        }
    }
}

function removeHidden(id: string) {
    const set = getHiddenSet();
    set.delete(id);
    openedHiddenChannels.delete(id);
    settings.store.hiddenIds = [...set].join(",");
    if (!settings.store.active) return;
    const targetChannelId = resolveTargetChannelId(id);
    if (targetChannelId) {
        try { MessageActions.fetchMessages({ channelId: targetChannelId }); } catch { }
        if (SelectedChannelStore.getChannelId?.() === targetChannelId) {
            try {
                FluxDispatcher.dispatch({ type: "CHANNEL_SELECT", channelId: targetChannelId, guildId: null });
            } catch { }
        }
    }
}

function isIdHidden(id: string): boolean {
    return getHiddenSet().has(id);
}

function getHiddenUserIds(): Set<string> {
    const hidden = getHiddenSet();
    const userIds = new Set<string>();
    for (const id of hidden) {
        const ch = ChannelStore.getChannel(id);
        const recipientId = ch?.getRecipientId?.();
        if (recipientId) userIds.add(recipientId);
        else if (!ch) userIds.add(id);
    }
    return userIds;
}

function isUserHidden(userId: string): boolean {
    return getHiddenUserIds().has(userId);
}

function createEmptyMessages(channelId: string): any {
    const empty: any[] = [];
    return {
        channelId, ready: true, cached: false, hasFetched: true, error: false,
        hasMoreBefore: false, hasMoreAfter: false, loadingMore: false,
        jumpType: "INSTANT", jumpTargetId: null, jumpTargetOffset: 0,
        jumpSequenceId: 0, jumped: false, jumpedToPresent: true, jumpFlash: false,
        jumpReturnTargetId: null, focusTargetId: null, focusSequenceId: 0,
        initialScrollSequenceId: 0, revealedMessageId: null,
        _array: empty, _map: {},
        _before: { _messages: [], _map: {}, _wasAtEdge: true, _isCacheBefore: false },
        _after: { _messages: [], _map: {}, _wasAtEdge: true, _isCacheBefore: false },
        get length() { return 0; },
        last() { return undefined; },
        get() { return undefined; },
        getByIndex() { return undefined; },
        receiveMessage() { return this; },
        findNewest() { return undefined; },
        findOldest() { return undefined; },
        forEach(cb: any) { empty.forEach(cb); },
        map(cb: any) { return empty.map(cb); },
        filter(cb: any) { return empty.filter(cb); },
        toArray() { return []; },
        [Symbol.iterator]() { return empty[Symbol.iterator](); },
    };
}

function patchMessageStore() {
    if (origGetMessages) return;
    if (typeof MessageStore?.getMessages !== "function") return;
    origGetMessages = MessageStore.getMessages;
    const origMsg = origGetMessages!;
    MessageStore.getMessages = function (channelId: string) {
        if (settings.store.active && isHidden(channelId)) {
            const real = origMsg.call(this, channelId);
            if (real == null) return createEmptyMessages(channelId);
            try {
                const proto = Object.getPrototypeOf(real);
                const copy = Object.create(proto);
                Object.assign(copy, real);
                copy._array = [];
                copy._map = {};
                if (real._before) copy._before = { ...real._before, _messages: [], _map: {} };
                if (real._after) copy._after = { ...real._after, _messages: [], _map: {} };
                copy.hasMoreBefore = false;
                copy.hasMoreAfter = false;
                copy.loadingMore = false;
                copy.ready = true;
                copy.cached = false;
                copy.hasFetched = true;
                return copy;
            } catch {
                return createEmptyMessages(channelId);
            }
        }
        return origMsg.call(this, channelId);
    };
}

function patchSortStore() {
    if (origGetPrivateChannelIds) return;
    if (typeof PrivateChannelSortStore?.getPrivateChannelIds !== "function") return;
    const pcsProto = Object.getPrototypeOf(PrivateChannelSortStore);
    origGetPrivateChannelIds = pcsProto.getPrivateChannelIds ?? PrivateChannelSortStore.getPrivateChannelIds;
    const origPcs = origGetPrivateChannelIds!;
    PrivateChannelSortStore.getPrivateChannelIds = function () {
        const ids: string[] = origPcs.call(this);
        if (!settings.store.active) return ids;
        const currentId = SelectedChannelStore.getChannelId?.();
        if (currentId && isHidden(currentId)) openedHiddenChannels.add(currentId);
        const kept: string[] = [];
        const hiddenOpen: string[] = [];
        for (const id of ids) {
            if (!isHidden(id)) { kept.push(id); continue; }
            if (id === currentId || openedHiddenChannels.has(id)) hiddenOpen.push(id);
        }
        return [...hiddenOpen, ...kept];
    };
}

function patchStore() {
    patchMessageStore();
    patchSortStore();
    patched = !!(origGetMessages && origGetPrivateChannelIds);
}

function reinstallMessageWrapper() {
    if (typeof MessageStore?.getMessages !== "function") return;
    if (origGetMessages) {
        try { MessageStore.getMessages = origGetMessages; } catch { }
    }
    origGetMessages = MessageStore.getMessages;
    const origMsg = origGetMessages!;
    MessageStore.getMessages = function (channelId: string) {
        if (settings.store.active && isHidden(channelId)) {
            const real = origMsg.call(this, channelId);
            if (real == null) return createEmptyMessages(channelId);
            try {
                const proto = Object.getPrototypeOf(real);
                const copy = Object.create(proto);
                Object.assign(copy, real);
                copy._array = [];
                copy._map = {};
                if (real._before) copy._before = { ...real._before, _messages: [], _map: {} };
                if (real._after) copy._after = { ...real._after, _messages: [], _map: {} };
                copy.hasMoreBefore = false;
                copy.hasMoreAfter = false;
                copy.loadingMore = false;
                copy.ready = true;
                copy.cached = false;
                copy.hasFetched = true;
                return copy;
            } catch {
                return createEmptyMessages(channelId);
            }
        }
        return origMsg.call(this, channelId);
    };
}

function ensurePatched() {
    patchSortStore();
    reinstallMessageWrapper();
    patched = !!origGetMessages;
    if (patched && origGetPrivateChannelIds) return;
    let tries = 0;
    const id = window.setInterval(() => {
        patchSortStore();
        reinstallMessageWrapper();
        tries++;
        if ((origGetMessages && origGetPrivateChannelIds) || tries > 20) {
            patched = !!origGetMessages;
            window.clearInterval(id);
        }
    }, 250);
}

function onChannelSelect(payload: { channelId?: string; }) {
    const channelId = payload?.channelId;
    if (!channelId || !settings.store.active || !isHidden(channelId)) return;
    clearStoredMessages(channelId);
}

function onLoadMessagesSuccess(payload: { channelId?: string; }) {
    const channelId = payload?.channelId;
    if (!channelId || !settings.store.active || !isHidden(channelId)) return;
    clearStoredMessages(channelId);
}

function onMessageCreate(payload: { channelId?: string; message?: { channel_id?: string; }; }) {
    const channelId = payload?.channelId ?? payload?.message?.channel_id;
    if (!channelId || !settings.store.active || !isHidden(channelId)) return;
    clearStoredMessages(channelId);
}

function onMessageUpdate(payload: { message?: { channel_id?: string; }; }) {
    const channelId = payload?.message?.channel_id;
    if (!channelId || !settings.store.active || !isHidden(channelId)) return;
    clearStoredMessages(channelId);
}

function clearStoredMessages(channelId: string) {
    if (!origGetMessages) return;
    try {
        const cached = origGetMessages.call(MessageStore, channelId);
        if (cached) {
            cached._array = [];
            cached._map = {};
            if (cached._before) { cached._before._messages = []; cached._before._map = {}; }
            if (cached._after) { cached._after._messages = []; cached._after._map = {}; }
            cached.hasMoreBefore = false;
            cached.hasMoreAfter = false;
        }
        try { MessageStore.emitChange(); } catch { }
    } catch { }
}

function unpatchStore() {
    if (origGetPrivateChannelIds) {
        try { delete PrivateChannelSortStore.getPrivateChannelIds; } catch { }
        if (PrivateChannelSortStore.getPrivateChannelIds !== origGetPrivateChannelIds)
            PrivateChannelSortStore.getPrivateChannelIds = origGetPrivateChannelIds;
        origGetPrivateChannelIds = null;
    }
    if (origGetMessages) {
        MessageStore.getMessages = origGetMessages;
        origGetMessages = null;
    }
    patched = false;
}

function refreshRelationships() {
    const hidden = getHiddenUserIds();
    for (const userId of hidden) {
        try {
            FluxDispatcher.dispatch({
                type: "RELATIONSHIP_UPDATE",
                relationship: { type: settings.store.active ? 0 : 1, id: userId }
            });
        } catch { }
    }
}


function refresh() {
    try { PrivateChannelSortStore.emitChange?.(); } catch { }
    try { MessageStore.emitChange?.(); } catch { }
    refreshRelationships();
}

function applyAllHiddenSideEffects() {
    for (const id of getHiddenSet()) {
        const ch = ChannelStore.getChannel(id);
        const channelId = ch ? id : (ChannelStore.getDMFromUserId?.(id) ?? null);
        if (channelId) clearStoredMessages(channelId);
    }
    const currentId = SelectedChannelStore.getChannelId?.();
    if (currentId && isHidden(currentId)) {
        try { FluxDispatcher.dispatch({ type: "CHANNEL_SELECT", channelId: currentId, guildId: null }); } catch { }
    }
}

function toggleStealth() {
    settings.store.active = !settings.store.active;
    if (settings.store.active) {
        ensurePatched();
        applyAllHiddenSideEffects();
    } else {
        openedHiddenChannels.clear();
    }
    refresh();
    if (!settings.store.active) {
        const channelId = SelectedChannelStore.getChannelId?.();
        if (channelId && isHidden(channelId)) {
            try { MessageActions.fetchMessages({ channelId }); } catch { }
        }
    }
}

function keybind(e: KeyboardEvent) {
    if (matchKb(e, settings.store.keybind)) {
        e.preventDefault();
        toggleStealth();
    }
}

const GroupDMContext: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.channel?.id) return;
    settings.use(["hiddenIds"]);
    const id = props.channel.id;
    const hidden = isIdHidden(id);
    children.push(
        <Menu.MenuGroup>
            <Menu.MenuCheckboxItem
                id="stealth-hide"
                label="Hide Group DM"
                checked={hidden}
                action={() => {
                    if (hidden) removeHidden(id);
                    else addHidden(id);
                    refresh();
                }}
            />
        </Menu.MenuGroup>
    );
};

function StealthButton() {
    const [enabled, setEnabled] = React.useState(settings.store.active);
    return (
        <UserAreaButton
            icon={<StealthIcon enabled={enabled} />}
            tooltipText={`Stealth ${enabled ? "ON" : "OFF"} (Alt+H)`}
            onClick={() => { toggleStealth(); setEnabled(settings.store.active); }}
            onContextMenu={(e: React.MouseEvent) => { e.preventDefault(); ContextMenuApi.openContextMenu(e, () => <StealthContextMenu />); }}
            role="switch"
            aria-checked={enabled}
        />
    );
}

function StealthIcon({ enabled }: { enabled: boolean; }) {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ color: enabled ? "var(--status-positive)" : "var(--channels-default)" }}>
            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
        </svg>
    );
}

function StealthContextMenu() {
    const hidden = [...getHiddenSet()];
    return (
        <Menu.Menu navId="stealth-context" onClose={() => ContextMenuApi.closeContextMenu()}>
            <Menu.MenuItem
                id="stealth-clear"
                label="Clear All"
                color="danger"
                disabled={hidden.length === 0}
                action={() => { settings.store.hiddenIds = ""; refresh(); }}
            />
            <Menu.MenuSeparator />
            <Menu.MenuGroup label="HIDDEN LIST">
                {hidden.length === 0 ? (
                    <Menu.MenuItem id="stealth-empty" label="No users" disabled />
                ) : (
                    hidden.map(id => {
                        const ch = ChannelStore.getChannel(id);
                        const userId = ch?.getRecipientId?.() ?? (ch ? null : id);
                        const user = userId ? UserStore.getUser(userId) : null;
                        const label = ch?.isGroupDM?.() ? "Group DM" : (user?.username ?? id);
                        const src = user ? IconUtils.getUserAvatarURL(user, false, 24) : IconUtils.getDefaultAvatarURL(userId ?? id);
                        return (
                            <Menu.MenuItem
                                key={id}
                                id={`stealth-${id}`}
                                label={label}
                                iconLeft={() => <img src={src} style={{ width: 20, height: 20, borderRadius: "50%" }} />}
                                action={() => { removeHidden(id); refresh(); }}
                            />
                        );
                    })
                )}
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}

export default definePlugin({
    name: "Stealth",
    description: "Hide DMs from the sidebar. Right-click a user or DM to hide. Toggle visibility with Alt+H.",
    authors: [{ name: "gabe", id: 1467949308816003193n }],
    dependencies: ["PluginDock"],

    isUserHidden,
    isStealthEnabled: () => settings.store.active,

    patches: [
        {
            find: "\"RelationshipStore\"",
            replacement: [
                {
                    match: /isFriend\((\i)\)\{/,
                    replace: "isFriend($1){if($self.isStealthEnabled()&&$self.isUserHidden($1))return false;"
                },
                {
                    match: /getRelationshipType\((\i)\)\{/,
                    replace: "getRelationshipType($1){if($self.isStealthEnabled()&&$self.isUserHidden($1))return 0;"
                },
            ]
        },
    ],

    contextMenus: {
        "gdm-context": GroupDMContext,
    },
    settings,
    start() {
        registerStealthDock();
        addUserContextEntry("stealth", (userId) => {
            settings.use(["hiddenIds"]);
            const channelId = ChannelStore.getDMFromUserId(userId);
            const id = channelId ?? userId;
            const user = UserStore.getUser(userId);
            const name = user?.username ?? "User";
            const hidden = isIdHidden(id);
            return (
                <Menu.MenuCheckboxItem
                    id="stealth-hide"
                    label={`Hide ${name}`}
                    checked={hidden}
                    action={() => {
                        if (hidden) removeHidden(id);
                        else addHidden(id);
                        refresh();
                    }}
                />
            );
        });
        ensurePatched();
        if (settings.store.active) refreshRelationships();
        FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onLoadMessagesSuccess);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
        this._onChannelSelect = onChannelSelect;
        this._onLoadMessagesSuccess = onLoadMessagesSuccess;
        this._onMessageCreate = onMessageCreate;
        this._onMessageUpdate = onMessageUpdate;
        const onReady = () => {
            ensurePatched();
            if (settings.store.active) refreshRelationships();
        };
        FluxDispatcher.subscribe("CONNECTION_OPEN", onReady);
        this._onReady = onReady;
        document.addEventListener("keydown", keybind);
    },
    stop() {
        removeDockButton("stealth");
        removeUserContextEntry("stealth");
        document.removeEventListener("keydown", keybind);
        if (this._onReady) FluxDispatcher.unsubscribe("CONNECTION_OPEN", this._onReady);
        if (this._onChannelSelect) FluxDispatcher.unsubscribe("CHANNEL_SELECT", this._onChannelSelect);
        if (this._onLoadMessagesSuccess) FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", this._onLoadMessagesSuccess);
        if (this._onMessageCreate) FluxDispatcher.unsubscribe("MESSAGE_CREATE", this._onMessageCreate);
        if (this._onMessageUpdate) FluxDispatcher.unsubscribe("MESSAGE_UPDATE", this._onMessageUpdate);
        unpatchStore();
        refresh();
    },
});
