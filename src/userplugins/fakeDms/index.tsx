/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { addDockButton, addMessageContextEntry, addUserContextEntry, removeDockButton, removeMessageContextEntry, removeUserContextEntry } from "../pluginDock";

function FakeDmIcon({ colorClass, width, height }: { color?: string; colorClass?: string; width?: number; height?: number; }) {
    return (
        <svg className={colorClass} width={width ?? 20} height={height ?? 20} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 5.92 2 10.66c0 2.75 1.5 5.2 3.84 6.82-.1 1.17-.5 2.8-1.84 4.02 0 0 3.1-.35 5.28-2.08.88.17 1.79.24 2.72.24 5.52 0 10-3.92 10-8.66S17.52 2 12 2Z" />
        </svg>
    );
}

function registerFakeDmsDock() {
    addDockButton("fakedms", {
        icon: FakeDmIcon,
        tooltipText: "Fake DMs",
        glowing: settings.store.indicatorMode,
        glowColor: "green",
        onClick: () => {
            settings.store.indicatorMode = !settings.store.indicatorMode;
            if (settings.store.indicatorMode) {
                document.body.classList.add("vc-fakedms-indicator-active");
                refreshMessages();
                setTimeout(markFakeMessageElements, 50);
                indicatorInterval = window.setInterval(markFakeMessageElements, 500);
            } else {
                if (indicatorInterval != null) {
                    window.clearInterval(indicatorInterval);
                    indicatorInterval = null;
                }
                document.body.classList.remove("vc-fakedms-indicator-active");
                unmarkFakeMessageElements();
                refreshMessages();
            }
            registerFakeDmsDock();
        },
        onContextMenu: e => {
            e.preventDefault();
            openFakeMessageModal();
        },
    });
}
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import definePlugin, { OptionType } from "@utils/types";
import { classNameFactory } from "@utils/css";
import { definePluginSettings } from "@api/Settings";
import { findByCodeLazy, findByPropsLazy, findComponentByCodeLazy, findCssClassesLazy } from "@webpack";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { DBSchema, IDBPDatabase, openDB } from "idb";
import {
    Avatar,
    ChannelStore,
    FluxDispatcher,
    Forms,
    GuildMemberStore,
    IconUtils,
    Menu,
    MessageStore,
    moment,
    React,
    ScrollerThin,
    SearchableSelect,
    SelectedChannelStore,
    TabBar,
    TextArea,
    TextInput,
    UserStore,
    useMemo,
    useState,
} from "@webpack/common";
import { findStoreLazy } from "@webpack";
import type { Message } from "discord-types/general";
import { RelationshipType } from "@vencord/discord-types/enums";

const cl = classNameFactory("vc-fakedms-");

const ICON_PROPS = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const MicOnIcon = () => <svg {...ICON_PROPS}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>;
const MicOffIcon = () => <svg {...ICON_PROPS}><path d="m2 2 20 20M9 9v2a3 3 0 0 0 4.8 2.4M15 9.3V6a3 3 0 0 0-5.6-1.5" /><path d="M19 11a7 7 0 0 1-.7 3.1M5 11a7 7 0 0 0 10.2 6.2M12 18v3M9 21h6" /></svg>;
const HeadOnIcon = () => <svg {...ICON_PROPS}><path d="M3 13v-1a9 9 0 0 1 18 0v1" /><path d="M21 14v3a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 1ZM3 14v3a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 1Z" /></svg>;
const HeadOffIcon = () => <svg {...ICON_PROPS}><path d="m2 2 20 20" /><path d="M21 14a9 9 0 0 0-12.7-8.2M3.6 7.6A9 9 0 0 0 3 12v2" /><path d="M21 14v3a2 2 0 0 1-2 2h-1v-6M6 13v6H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h.5" /></svg>;
const VidOnIcon = () => <svg {...ICON_PROPS}><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m22 8-6 4 6 4Z" /></svg>;
const VidOffIcon = () => <svg {...ICON_PROPS}><path d="m2 2 20 20" /><path d="M10.7 6H14a2 2 0 0 1 2 2v3.3l6-3.3v8M16 16v.2a2 2 0 0 1-2 1.8H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1.8-2" /></svg>;
const ScrOnIcon = () => <svg {...ICON_PROPS}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
const ScrOffIcon = () => <svg {...ICON_PROPS}><path d="m2 2 20 20" /><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
const logger = new Logger("FakeDMs");

const settings = definePluginSettings({
    indicatorMode: {
        description: "Show fake message indicators.",
        type: OptionType.BOOLEAN,
        default: false,
    },
    keybind: {
        type: OptionType.STRING,
        description: "Keybind to open the Fake DMs modal.",
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


const createBotMessage = findByCodeLazy('username:"Clyde"');
const MessageRecord = findByCodeLazy("isEdited(){");
const ChannelMessage = findComponentByCodeLazy("childrenExecutedCommand:", ".hideAccessories");
const messageClasses = findCssClassesLazy("message", "groupStart", "cozyMessage");
const DiscordIcons = findByPropsLazy("MicrophoneIcon", "HeadphonesIcon", "VideoIcon", "ScreenIcon");
const relationshipStore = findStoreLazy("RelationshipStore");
const privateChannelSortStore = findStoreLazy("PrivateChannelSortStore");
const friendsStore = findStoreLazy("FriendsStore");

let originalGetVoiceChannelId: (() => string | null) | null = null;
const VOICE_OVERRIDE_MARK = Symbol("fakedms-voice-override");

const rtcConnectionStore = findStoreLazy("RTCConnectionStore") as unknown as {
    getState: () => string;
    isConnected: () => boolean;
    isDisconnected: () => boolean;
    getChannelId: () => string | null;
    emitChange?: () => void;
};
let originalRtcGetState: (() => string) | null = null;
let originalRtcIsConnected: (() => boolean) | null = null;
let originalRtcIsDisconnected: (() => boolean) | null = null;
let originalRtcGetChannelId: (() => string | null) | null = null;

function isFakeVoiceConnected(): boolean {
    return findFakeVoiceChannelIdForCurrentUser() != null;
}

function applyRtcConnectionOverride(): void {
    const cur = rtcConnectionStore.getState;
    if ((cur as unknown as { [VOICE_OVERRIDE_MARK]?: boolean })?.[VOICE_OVERRIDE_MARK]) return;
    originalRtcGetState = cur.bind(rtcConnectionStore);
    originalRtcIsConnected = rtcConnectionStore.isConnected.bind(rtcConnectionStore);
    originalRtcIsDisconnected = rtcConnectionStore.isDisconnected.bind(rtcConnectionStore);
    originalRtcGetChannelId = rtcConnectionStore.getChannelId.bind(rtcConnectionStore);

    const realIsDisconnected = originalRtcIsDisconnected!;

    const wrappedGetState = function () {
        const real = originalRtcGetState!();
        if (!realIsDisconnected()) return real;
        if (isFakeVoiceConnected()) return "RTC_CONNECTED";
        return real;
    };
    const wrappedIsConnected = function () {
        if (originalRtcIsConnected!()) return true;
        if (!realIsDisconnected()) return false;
        return isFakeVoiceConnected();
    };
    const wrappedIsDisconnected = function () {
        if (!realIsDisconnected()) return false;
        return !isFakeVoiceConnected();
    };
    const wrappedGetChannelId = function () {
        const real = originalRtcGetChannelId!();
        if (real != null) return real;
        return findFakeVoiceChannelIdForCurrentUser();
    };
    for (const fn of [wrappedGetState, wrappedIsConnected, wrappedIsDisconnected, wrappedGetChannelId]) {
        (fn as unknown as { [VOICE_OVERRIDE_MARK]: boolean })[VOICE_OVERRIDE_MARK] = true;
    }
    rtcConnectionStore.getState = wrappedGetState;
    rtcConnectionStore.isConnected = wrappedIsConnected;
    rtcConnectionStore.isDisconnected = wrappedIsDisconnected;
    rtcConnectionStore.getChannelId = wrappedGetChannelId;
}

function removeRtcConnectionOverride(): void {
    if (originalRtcGetState) {
        rtcConnectionStore.getState = originalRtcGetState;
        originalRtcGetState = null;
    }
    if (originalRtcIsConnected) {
        rtcConnectionStore.isConnected = originalRtcIsConnected;
        originalRtcIsConnected = null;
    }
    if (originalRtcIsDisconnected) {
        rtcConnectionStore.isDisconnected = originalRtcIsDisconnected;
        originalRtcIsDisconnected = null;
    }
    if (originalRtcGetChannelId) {
        rtcConnectionStore.getChannelId = originalRtcGetChannelId;
        originalRtcGetChannelId = null;
    }
}

function emitRtcConnectionChange(): void {
    try {
        rtcConnectionStore.emitChange?.();
    } catch { }
}

function findFakeVoiceChannelIdForCurrentUser(): string | null {
    const myId = UserStore.getCurrentUser()?.id;
    if (!myId) return null;
    for (const [channelId, participants] of activeFakeCalls.entries()) {
        if (participants.has(myId)) return channelId;
    }
    return null;
}

function applyVoiceChannelIdOverride(): void {
    const current = SelectedChannelStore.getVoiceChannelId;
    if ((current as unknown as { [VOICE_OVERRIDE_MARK]?: boolean })?.[VOICE_OVERRIDE_MARK]) return;
    originalGetVoiceChannelId = current.bind(SelectedChannelStore);
    const wrapped = function () {
        const real = originalGetVoiceChannelId!();
        if (real != null) return real;
        return findFakeVoiceChannelIdForCurrentUser();
    };
    (wrapped as unknown as { [VOICE_OVERRIDE_MARK]: boolean })[VOICE_OVERRIDE_MARK] = true;
    SelectedChannelStore.getVoiceChannelId = wrapped as typeof SelectedChannelStore.getVoiceChannelId;
}

function removeVoiceChannelIdOverride(): void {
    if (originalGetVoiceChannelId) {
        SelectedChannelStore.getVoiceChannelId = originalGetVoiceChannelId;
        originalGetVoiceChannelId = null;
    }
}

function emitVoiceChannelChange(): void {
    try {
        (SelectedChannelStore as unknown as { emitChange?: () => void; }).emitChange?.();
    } catch { }
}

let originalGetPrivateChannelIds: (() => string[]) | null = null;
const channelsWithFakes = new Set<string>();

let originalGetMessages: typeof MessageStore.getMessages;
let keydownHandler: (e: KeyboardEvent) => void;
let keyupHandler: (e: KeyboardEvent) => void;
let fluxInterceptor: ((e: { type: string; channelId?: string; messages?: unknown[]; }) => void) | null = null;
let originalFluxDispatch: typeof FluxDispatcher.dispatch | null = null;

let indicatorTimer: number | null = null;
let indicatorInterval: number | null = null;
let ctrlDown = false;
let shiftDown = false;

let originalGetFriendIDs: (() => string[]) | null = null;
let originalGetRelationshipType: ((userId: string) => number) | null = null;
let originalIsFriend: ((userId: string) => boolean) | null = null;
let originalGetFriendCount: (() => number) | null = null;
let originalFriendsGetState: (() => any) | null = null;

const fakeFriends = new Set<string>();

function refreshMessages(): void {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

    removeMessageStorePatch();
    setTimeout(() => {
        applyMessageStorePatch();
        try {
            (MessageStore as unknown as { emitChange?: () => void; }).emitChange?.();
        } catch { }
        if (settings.store.indicatorMode) markFakeMessageElements();
    }, 10);
}

function markFakeMessageElements(): void {
    if (!settings.store.indicatorMode) return;
    const container = document.querySelector("[class*='messagesWrapper']") ?? document.body;
    const idPrefix = "chat-messages-";
    container.querySelectorAll(`[id^='${idPrefix}']`).forEach((el) => {
        if (!(el instanceof HTMLElement)) return;
        const rest = el.id.slice(idPrefix.length);
        const lastDash = rest.lastIndexOf("-");
        if (lastDash === -1) return;
        const channelId = rest.slice(0, lastDash);
        const messageId = rest.slice(lastDash + 1);
        if (!channelId || !messageId) return;
        const cached = channelFakeCache.get(channelId);
        const isFake = cached?.some((m) => m.id === messageId);
        el.classList.toggle("vc-fakedms-fake-highlight", !!isFake);
    });
}

function unmarkFakeMessageElements(): void {
    document.querySelectorAll(".vc-fakedms-fake-highlight").forEach((el) => {
        el.classList.remove("vc-fakedms-fake-highlight");
    });
}

const VencordNative = globalThis.VencordNative as unknown as {
    fakedms?: {
        get?: () => Promise<unknown[]>;
        set?: (data: unknown[]) => Promise<void>;
    };
};

type FakeAttachment = {
    id: string;
    filename: string;
    url: string;
    proxy_url?: string;
    size?: number;
    width?: number;
    height?: number;
    content_type?: string;
};

type FakeEmbed = {
    title?: string;
    description?: string;
    url?: string;
    color?: number;
    author?: { name?: string; url?: string; icon_url?: string; };
    footer?: { text?: string; icon_url?: string; };
    image?: { url?: string; };
    thumbnail?: { url?: string; };
    fields?: { name: string; value: string; inline?: boolean; }[];
};

type FakeSticker = {
    id: string;
    name: string;
    format_type: number;
};

type PersistedFakeMessage = {
    channelId: string;
    id: string;
    timestamp: string;
    content: string;
    authorId: string;
    authorUsername?: string;
    authorGlobalName?: string | null;
    authorAvatarUrl?: string;
    recipientUserId?: string;
    attachments?: FakeAttachment[];
    embeds?: FakeEmbed[];
    stickerItems?: FakeSticker[];
    messageType?: number;
    call?: {
        participants?: string[];
        endedTimestamp?: string;
        duration?: number;
    };
};

function isPersistedFakeMessage(x: unknown): x is PersistedFakeMessage {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    return typeof o.channelId === "string"
        && typeof o.id === "string"
        && typeof o.timestamp === "string"
        && typeof o.content === "string"
        && typeof o.authorId === "string";
}

const channelFakeCache = new Map<string, PersistedFakeMessage[]>();

async function ensureChannelCacheLoaded(channelId: string): Promise<void> {
    if (!channelId) {
        logger.warn(`[ensureChannelCacheLoaded] Called with empty channelId`);
        return;
    }
    if (channelFakeCache.has(channelId)) {
        logger.info(`[ensureChannelCacheLoaded] Channel ${channelId} already in cache, skipping`);
        return;
    }

    logger.info(`[ensureChannelCacheLoaded] Loading fake messages for channel ${channelId}`);
    try {
        const fakes = await getFakesForChannel(channelId);
        logger.info(`[ensureChannelCacheLoaded] Found ${fakes.length} fake messages for channel ${channelId}`);
        channelFakeCache.set(channelId, fakes);
    } catch (err) {
        logger.error(`[ensureChannelCacheLoaded] Error loading fakes for channel ${channelId}:`, err);
        channelFakeCache.set(channelId, []);
    }

    logger.info(`[ensureChannelCacheLoaded] Emitting MessageStore change for channel ${channelId}`);
    MessageStore.emitChange?.();
}

function isValidDateMs(ms: number): boolean {
    // JS Date valid range is roughly +/- 8.64e15 ms
    return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;
}

function safeIsoTimestamp(raw: string): string {
    const ms = Date.parse(raw);
    if (!isValidDateMs(ms)) return new Date().toISOString();
    try {
        return new Date(ms).toISOString();
    } catch {
        return new Date().toISOString();
    }
}

function safeIsoFromMs(ms: number): string {
    if (!isValidDateMs(ms)) return new Date().toISOString();
    try {
        return new Date(ms).toISOString();
    } catch {
        return new Date().toISOString();
    }
}

function clampMsForSnowflake(rawMs: number): number {
    const DISCORD_EPOCH_MS = 1420070400000;
    if (!isValidDateMs(rawMs)) return Date.now();
    if (rawMs < DISCORD_EPOCH_MS) return DISCORD_EPOCH_MS;
    return rawMs;
}

function hydratePersistedMessage(p: PersistedFakeMessage): Message {
    const tsMs = Date.parse(p.timestamp);
    const safeTsMs = isValidDateMs(tsMs) ? tsMs : Date.now();
    const base = createBotMessage({
        channelId: p.channelId,
        content: p.content || "\u200b",
        embeds: p.embeds || [],
    });

    const storeUser = UserStore.getUser(p.authorId);
    const author = storeUser ?? ({
        id: p.authorId,
        username: p.authorUsername ?? p.authorId,
        global_name: p.authorGlobalName ?? null,
        getAvatarURL: () => p.authorAvatarUrl ?? "",
    } as unknown as Message["author"]);

    return new MessageRecord({
        ...base,
        id: p.id,
        channel_id: p.channelId,
        timestamp: new Date(safeTsMs),
        edited_timestamp: null,
        flags: 0,
        author,
        attachments: p.attachments || [],
        embeds: p.embeds || [],
        stickerItems: p.stickerItems || [],
        components: [],
        type: p.messageType || 0,
        call: p.call ? {
            participants: p.call.participants ?? [],
            endedTimestamp: p.call.endedTimestamp ? new Date(p.call.endedTimestamp) : null,
            duration: moment.duration(typeof p.call.duration === "number" ? p.call.duration : 0),
        } : undefined,
        mentions: [],
        mentionRoles: [],
        mentionChannels: [],
        mentionEveryone: false,
        tts: false,
    });
}

function serializeMessage(channelId: string, message: Message): PersistedFakeMessage {
    const authorId = (message.author as { id?: string; } | undefined)?.id ?? "";
    const timestamp = (message.timestamp as any)?.toISOString?.()
        ?? (message.timestamp instanceof Date ? message.timestamp.toISOString() : String(message.timestamp));

    const channel = ChannelStore.getChannel(channelId);
    const currentUserId = UserStore.getCurrentUser()?.id;
    let recipientUserId: string | undefined;

    if (channel?.recipients && Array.isArray(channel.recipients)) {
        const recipients = channel.recipients as string[];
        recipientUserId = recipients.find(id => id !== currentUserId);
    }

    const result: PersistedFakeMessage = {
        channelId,
        id: message.id,
        timestamp,
        content: message.content ?? "\u200b",
        authorId,
        authorUsername: (message.author as { username?: string; } | undefined)?.username,
        authorGlobalName: (message.author as { global_name?: string | null; } | undefined)?.global_name,
        authorAvatarUrl: (message.author as { getAvatarURL?: (a?: unknown, s?: number) => string; } | undefined)?.getAvatarURL?.(undefined, 32),
        recipientUserId,
    };

    if (message.attachments?.length) {
        result.attachments = message.attachments as FakeAttachment[];
    }
    if (message.embeds?.length) {
        result.embeds = message.embeds as FakeEmbed[];
    }
    if (message.stickerItems?.length) {
        result.stickerItems = message.stickerItems as FakeSticker[];
    }
    if (message.type) {
        result.messageType = message.type;
    }
    const msgCall = (message as any).call;
    if (msgCall) {
        const endedTs = msgCall.endedTimestamp;
        const dur = msgCall.duration;
        const durationMs = typeof dur === "number" ? dur : (typeof dur?.asMilliseconds === "function" ? dur.asMilliseconds() : undefined);
        result.call = {
            participants: msgCall.participants ?? [],
            endedTimestamp: endedTs instanceof Date
                ? endedTs.toISOString()
                : (typeof endedTs === "string" ? endedTs : undefined),
            duration: durationMs,
        };
    }

    return result;
}

interface FakeDmDb extends DBSchema {
    messages: {
        key: string;
        value: PersistedFakeMessage;
        indexes: {
            by_channel_id: string;
            by_channel_id_and_timestamp: [string, string];
        };
    };
    friends: {
        key: string;
        value: { userId: string; };
    };
    fakeCalls: {
        key: string;
        value: { channelId: string; participants: string[]; };
    };
}

let db: IDBPDatabase<FakeDmDb>;

async function initDb(): Promise<void> {
    if (db) return;
    db = await openDB<FakeDmDb>("VencordFakeDMs", 4, {
        upgrade(db, oldVersion) {
            if (oldVersion < 1) {
                const store = db.createObjectStore("messages", { keyPath: "id" });
                store.createIndex("by_channel_id", "channelId");
                store.createIndex("by_channel_id_and_timestamp", ["channelId", "timestamp"]);
            }
            if (oldVersion < 2) {
                db.createObjectStore("friends", { keyPath: "userId" });
            }
            if (oldVersion < 4) {
                if (!db.objectStoreNames.contains("fakeCalls")) {
                    db.createObjectStore("fakeCalls", { keyPath: "channelId" });
                }
            }
        }
    });
}

async function putFakeToDb(p: PersistedFakeMessage): Promise<void> {
    await initDb();
    await db.put("messages", p);
}

async function deleteFakeFromDb(id: string): Promise<void> {
    await initDb();
    await db.delete("messages", id);
}

function removeFakeFromCache(channelId: string, messageId: string): void {
    const cached = channelFakeCache.get(channelId);
    if (!cached?.length) return;
    const idx = cached.findIndex(m => m.id === messageId);
    if (idx !== -1) cached.splice(idx, 1);
}

async function deleteFake(channelId: string, messageId: string): Promise<void> {
    try {
        await deleteFakeFromDb(messageId);
    } catch { }
    removeFakeFromCache(channelId, messageId);

    const cached = channelFakeCache.get(channelId);
    if (cached && cached.length === 0) {
        channelsWithFakes.delete(channelId);
        privateChannelSortStore.emitChange?.();
    }

    FluxDispatcher.dispatch({
        type: "MESSAGE_DELETE",
        channelId,
        id: messageId,
        isBulk: false,
    });
    refreshMessages();
}

async function loadChannelsWithFakes(): Promise<void> {
    await initDb();
    const rows = await db.getAll("messages");
    channelsWithFakes.clear();
    for (const r of rows) {
        channelsWithFakes.add(r.channelId);
    }
}

function applyPrivateChannelSortStorePatch(): void {
    if (!originalGetPrivateChannelIds) {
        originalGetPrivateChannelIds = privateChannelSortStore.getPrivateChannelIds?.bind(privateChannelSortStore);
    }

    privateChannelSortStore.getPrivateChannelIds = function () {
        const ids = originalGetPrivateChannelIds?.() ?? [];
        if (!channelsWithFakes.size) return ids;

        const validFakeChannels = Array.from(channelsWithFakes).filter(channelId => {
            return ChannelStore.getChannel(channelId) != null;
        });

        return [...new Set([...ids, ...validFakeChannels])];
    };
}

function removePrivateChannelSortStorePatch(): void {
    if (originalGetPrivateChannelIds) {
        privateChannelSortStore.getPrivateChannelIds = originalGetPrivateChannelIds;
    }
}

async function loadFakeFriends(): Promise<void> {
    await initDb();
    const friends = await db.getAll("friends");
    fakeFriends.clear();
    friends.forEach(f => fakeFriends.add(f.userId));
}

async function addFakeFriend(userId: string): Promise<void> {
    await initDb();
    await db.put("friends", { userId });
    fakeFriends.add(userId);
    relationshipStore.emitChange?.();
    friendsStore.emitChange?.();
}

async function removeFakeFriend(userId: string): Promise<void> {
    await initDb();
    await db.delete("friends", userId);
    fakeFriends.delete(userId);
    relationshipStore.emitChange?.();
    friendsStore.emitChange?.();
}

function isFakeFriend(userId: string): boolean {
    return fakeFriends.has(userId);
}

let originalRelationshipEmitChange: (() => void) | undefined;
let fakedmsFriendsGetStateWrapperRef: (() => unknown) | null = null;

const FAKEDMS_WRAPPER = Symbol("fakedms-wrapper");

function applyRelationshipStorePatches(): void {
    const currentGetFriendIDs = relationshipStore.getFriendIDs;
    const currentGetRelationshipType = relationshipStore.getRelationshipType;
    const currentIsFriend = relationshipStore.isFriend;
    const currentGetFriendCount = relationshipStore.getFriendCount;
    const currentFriendsGetState = friendsStore.getState;

    if (!(currentGetFriendIDs as unknown as { [FAKEDMS_WRAPPER]?: boolean })?.[FAKEDMS_WRAPPER]) {
        originalGetFriendIDs = currentGetFriendIDs?.bind(relationshipStore);
        originalGetRelationshipType = currentGetRelationshipType?.bind(relationshipStore);
        originalIsFriend = currentIsFriend?.bind(relationshipStore);
        originalGetFriendCount = currentGetFriendCount?.bind(relationshipStore);
        originalFriendsGetState = currentFriendsGetState?.bind(friendsStore);
    }

    function getFriendIDsWrapper() {
        const realFriends = originalGetFriendIDs?.() ?? [];
        return [...new Set([...realFriends, ...Array.from(fakeFriends)])];
    }
    function getRelationshipTypeWrapper(userId: string) {
        if (isFakeFriend(userId)) return RelationshipType.FRIEND;
        return originalGetRelationshipType?.(userId) ?? 0;
    }
    function isFriendWrapper(userId: string) {
        if (isFakeFriend(userId)) return true;
        return originalIsFriend?.(userId) ?? false;
    }
    (getFriendIDsWrapper as unknown as { [FAKEDMS_WRAPPER]: boolean })[FAKEDMS_WRAPPER] = true;
    (getRelationshipTypeWrapper as unknown as { [FAKEDMS_WRAPPER]: boolean })[FAKEDMS_WRAPPER] = true;
    (isFriendWrapper as unknown as { [FAKEDMS_WRAPPER]: boolean })[FAKEDMS_WRAPPER] = true;

    relationshipStore.getFriendIDs = getFriendIDsWrapper;
    relationshipStore.getRelationshipType = getRelationshipTypeWrapper;
    relationshipStore.isFriend = isFriendWrapper;

    relationshipStore.getFriendCount = function () {
        return relationshipStore.getFriendIDs().length;
    };

    if (currentFriendsGetState !== fakedmsFriendsGetStateWrapperRef) {
        originalFriendsGetState = currentFriendsGetState?.bind(friendsStore);
    }

    if (!fakedmsFriendsGetStateWrapperRef) {
        fakedmsFriendsGetStateWrapperRef = function friendsGetStateWrapper() {
            const state = originalFriendsGetState?.call(friendsStore) ?? {};
            if (!fakeFriends.size) return state;

            const origRows = state.rows;
            if (!origRows || !origRows._rows) return state;

            const fakeRows = Array.from(fakeFriends).map(userId => {
                const realUser = UserStore.getUser(userId);
                const syntheticUser = realUser || {
                    id: userId,
                    username: userId,
                    discriminator: "0000",
                    avatar: null,
                    bot: false,
                    system: false,
                    publicFlags: 0,
                    hasUniqueUsername() { return true; },
                    getAvatarURL() { return null; },
                    toString() { return userId; },
                };
                return {
                    userId,
                    type: RelationshipType.FRIEND,
                    status: "offline",
                    activities: [],
                    applicationStream: null,
                    clientStatuses: {},
                    user: syntheticUser,
                    nickname: null,
                    usernameLower: (syntheticUser.username || userId).toLowerCase(),
                    key: userId,
                };
            });

            const wrappedRows = {
                ...origRows,
                _rows: [...(origRows._rows ?? []), ...fakeRows],
                filter(section: string, searchQuery?: string | null) {
                    const result = origRows.filter?.(section, searchQuery) ?? [];
                    if (!searchQuery) {
                        return Array.isArray(result) ? [...result, ...fakeRows] : result;
                    }
                    const query = searchQuery.toLowerCase();
                    const matchingFakes = fakeRows.filter(row => {
                        const username = row.user?.username?.toLowerCase() || row.userId.toLowerCase();
                        return username.includes(query) || row.userId.includes(query);
                    });
                    return Array.isArray(result) ? [...result, ...matchingFakes] : result;
                },
                getRelationshipCounts() {
                    const c = { ...(origRows.getRelationshipCounts?.() ?? {}) };
                    const key = RelationshipType.FRIEND as number;
                    c[key] = (c[key] ?? 0) + fakeFriends.size;
                    return c;
                },
            };
            return { ...state, rows: wrappedRows };
        };
    }
    friendsStore.getState = fakedmsFriendsGetStateWrapperRef;

    if (typeof relationshipStore.emitChange === "function" && !originalRelationshipEmitChange) {
        originalRelationshipEmitChange = relationshipStore.emitChange.bind(relationshipStore);
        relationshipStore.emitChange = function () {
            applyRelationshipStorePatches();
            originalRelationshipEmitChange?.();
        };
    }
}

function removeRelationshipStorePatches(): void {
    if (originalGetFriendIDs) {
        relationshipStore.getFriendIDs = originalGetFriendIDs;
    }
    if (originalGetRelationshipType) {
        relationshipStore.getRelationshipType = originalGetRelationshipType;
    }
    if (originalIsFriend) {
        relationshipStore.isFriend = originalIsFriend;
    }
    if (originalGetFriendCount) {
        relationshipStore.getFriendCount = originalGetFriendCount;
    }
    if (originalFriendsGetState) {
        friendsStore.getState = originalFriendsGetState;
    }
    if (originalRelationshipEmitChange) {
        relationshipStore.emitChange = originalRelationshipEmitChange;
        originalRelationshipEmitChange = undefined;
    }
    fakedmsFriendsGetStateWrapperRef = null;
}

async function getFakesForChannel(channelId: string): Promise<PersistedFakeMessage[]> {
    await initDb();
    const rows = await db.getAllFromIndex("messages", "by_channel_id", channelId);
    if (rows.length === 0) return rows;

    const next: PersistedFakeMessage[] = [];
    const writes: Promise<unknown>[] = [];

    for (const row of rows) {
        const tsMs = Date.parse(row.timestamp);
        if (!isValidDateMs(tsMs)) {
            writes.push(deleteFakeFromDb(row.id));
            continue;
        }

        const migrated = maybeMigratePersistedFakeId({
            ...row,
            timestamp: safeIsoTimestamp(row.timestamp),
        });

        if (migrated.id !== row.id || migrated.timestamp !== row.timestamp) {
            writes.push(putFakeToDb(migrated));
            if (migrated.id !== row.id) writes.push(deleteFakeFromDb(row.id));
        }

        next.push(migrated);
    }

    if (writes.length) {
        try {
            await Promise.all(writes);
        } catch { }
    }

    return next;
}

async function getFakesForChannelInRange(channelId: string, start: string, end: string): Promise<PersistedFakeMessage[]> {
    await initDb();
    const idx = db.transaction("messages", "readonly").store.index("by_channel_id_and_timestamp");
    const range = IDBKeyRange.bound([channelId, start], [channelId, end]);
    return await idx.getAll(range);
}

async function sanitizeDbOnce(): Promise<void> {
    await initDb();

    let rows: PersistedFakeMessage[];
    try {
        rows = await db.getAll("messages");
    } catch {
        return;
    }

    if (!rows.length) return;

    const writes: Promise<unknown>[] = [];
    for (const row of rows) {
        const tsMs = Date.parse(row.timestamp);
        if (!isValidDateMs(tsMs)) {
            writes.push(deleteFakeFromDb(row.id));
            continue;
        }

        const normalizedTs = safeIsoTimestamp(row.timestamp);
        const migrated = maybeMigratePersistedFakeId({
            ...row,
            timestamp: normalizedTs,
        });

        if (migrated.id !== row.id || migrated.timestamp !== row.timestamp) {
            writes.push(putFakeToDb(migrated));
            if (migrated.id !== row.id) writes.push(deleteFakeFromDb(row.id));
        }
    }

    if (!writes.length) return;
    try {
        await Promise.all(writes);
    } catch { }
}

async function migrateJsonToIdbOnce(): Promise<void> {
    if (!VencordNative?.fakedms?.get || !VencordNative?.fakedms?.set) return;

    let data: unknown[];
    try {
        data = await VencordNative.fakedms.get();
    } catch {
        return;
    }

    if (!Array.isArray(data) || data.length === 0) return;

    await initDb();

    let wroteAny = false;
    for (const entry of data) {
        if (!isPersistedFakeMessage(entry)) continue;
        const tsMs = Date.parse(entry.timestamp);
        if (!isValidDateMs(tsMs)) continue;
        const migrated = maybeMigratePersistedFakeId(entry);
        await putFakeToDb({
            ...migrated,
            timestamp: safeIsoTimestamp(migrated.timestamp),
        });
        wroteAny = true;
    }

    if (!wroteAny) return;

    try {
        await VencordNative.fakedms.set([]);
    } catch { }
}

let lastFakeMsSinceEpoch = 0n;
let lastFakeSeq = 0n;

function fakeMessageId(timestampMs: number): string {
    // Discord snowflake: ((msSinceDiscordEpoch) << 22) + (random 22 bits)
    const DISCORD_EPOCH = 1420070400000n;
    const ms = BigInt(Math.floor(timestampMs));
    const msSince = ms > DISCORD_EPOCH ? (ms - DISCORD_EPOCH) : 0n;

    if (msSince === lastFakeMsSinceEpoch) {
        lastFakeSeq = (lastFakeSeq + 1n) & ((1n << 22n) - 1n);
    } else {
        lastFakeMsSinceEpoch = msSince;
        lastFakeSeq = 0n;
    }

    return ((msSince << 22n) + lastFakeSeq).toString();
}

function maybeMigratePersistedFakeId(p: PersistedFakeMessage): PersistedFakeMessage {
    // Older versions stored IDs as unixMs*1000 which don't interleave with real Discord snowflakes.
    // If it doesn't look like a snowflake, regenerate from timestamp.
    let idBig: bigint | null = null;
    try {
        idBig = BigInt(p.id);
    } catch {
        idBig = null;
    }

    // If it decodes to a valid snowflake time, keep it.
    if (idBig !== null) {
        const DISCORD_EPOCH = 1420070400000n;
        const ms = Number((idBig >> 22n) + DISCORD_EPOCH);
        if (isValidDateMs(ms)) return p;
    }

    const tsMs = Date.parse(p.timestamp);
    if (!isValidDateMs(tsMs)) return p;

    return {
        ...p,
        id: fakeMessageId(tsMs),
    };
}

function getMessageTimestampMs(m: { timestamp?: string | Date; } | null | undefined): number {
    const t = m?.timestamp;
    if (!t) return 0;
    const ms = t instanceof Date ? t.getTime() : Date.parse(String(t));
    return isValidDateMs(ms) ? ms : 0;
}

function getMessageIdBigInt(m: { id?: string; } | null | undefined): bigint | null {
    const id = m?.id;
    if (!id) return null;
    try {
        return BigInt(id);
    } catch {
        return null;
    }
}

function compareMessages(a: { id: string; timestamp?: string; }, b: { id: string; timestamp?: string; }): number {
    const ida = getMessageIdBigInt(a);
    const idb = getMessageIdBigInt(b);
    if (ida !== null && idb !== null) {
        return ida < idb ? -1 : ida > idb ? 1 : 0;
    }
    const ta = getMessageTimestampMs(a);
    const tb = getMessageTimestampMs(b);
    return ta < tb ? -1 : ta > tb ? 1 : 0;
}

function detectIsDesc<T extends { id: string; timestamp?: string; }>(messages: T[]): boolean {
    // Discord message arrays are typically newest-first. Default to that unless we can prove otherwise.
    if (!Array.isArray(messages) || messages.length < 2) return true;

    const first = messages[0];
    for (let i = 1; i < messages.length; i++) {
        const cmp = compareMessages(first, messages[i]);
        if (cmp === 0) continue;
        return cmp > 0;
    }
    return true;
}

function mergeMessagesStableInPlace<T extends { id: string; timestamp?: string; }>(messages: T[], fakes: T[]): void {
    const isDesc = detectIsDesc(messages);
    const fakesSorted = fakes.slice().sort((a, b) => {
        const cmp = compareMessages(a, b);
        return isDesc ? -cmp : cmp;
    });

    for (const fake of fakesSorted) {
        let idx = 0;
        if (isDesc) {
            // Keep newer messages earlier: insert after all messages newer than fake.
            while (idx < messages.length && compareMessages(messages[idx] as T, fake as T) > 0) idx++;
        } else {
            // Keep older messages earlier: insert after all messages older than fake.
            while (idx < messages.length && compareMessages(messages[idx] as T, fake as T) < 0) idx++;
        }

        messages.splice(idx, 0, fake);
    }
}

function mergeMessagesStable<T extends { id: string; timestamp?: string; }>(messages: T[], fakes: T[]): T[] {
    if (!Array.isArray(messages) || messages.length === 0) return fakes.slice();
    if (!Array.isArray(fakes) || fakes.length === 0) return messages;

    const result = messages.slice();

    // Determine direction based on existing list (Discord usually uses newest-first).
    const isDesc = detectIsDesc(result);

    // Insert in timestamp order so indices remain stable.
    const fakesSorted = fakes.slice().sort((a, b) => {
        const cmp = compareMessages(a, b);
        return isDesc ? -cmp : cmp;
    });

    for (const fake of fakesSorted) {
        let idx = 0;
        if (isDesc) {
            // Keep newer messages earlier: insert after all messages newer than fake.
            while (idx < result.length && compareMessages(result[idx] as T, fake as T) > 0) idx++;
        } else {
            // Keep older messages earlier: insert after all messages older than fake.
            while (idx < result.length && compareMessages(result[idx] as T, fake as T) < 0) idx++;
        }

        result.splice(idx, 0, fake);
    }

    return result;
}

type LoadMessagePayload = { channelId: string;[k: string]: unknown; };
type MessagesArray = Array<{ id: string; timestamp?: string; channel_id?: string;[k: string]: unknown; }>;

function messageTimeMsFromId(id: string): number {
    // Snowflake ms = (id >> 22) + DISCORD_EPOCH
    const DISCORD_EPOCH = 1420070400000n;
    let idBig: bigint;
    try {
        idBig = BigInt(id);
    } catch {
        return 0;
    }
    return Number((idBig >> 22n) + DISCORD_EPOCH);
}

function getChunkTimeBounds(messages: MessagesArray): { min: number; max: number; } | null {
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const m of messages) {
        const t = messageTimeMsFromId(m.id);
        if (!t) continue;
        if (t < min) min = t;
        if (t > max) max = t;
    }
    if (!Number.isFinite(min) || !max) return null;
    return { min, max };
}

/** Merge our fakes into the messages array when LOAD_MESSAGES_SUCCESS payload is read (same injection point as MessageLoggerEnhanced). */
function mergeFakedmsIntoPayloadMessages(messages: MessagesArray, payload: LoadMessagePayload): MessagesArray {
    try {
        const mle = (globalThis as typeof window & { Vencord?: { Plugins?: { plugins?: Record<string, { coolReAddDeletedMessages?: (m: MessagesArray, p: LoadMessagePayload) => MessagesArray; }>; }; }; }).Vencord?.Plugins?.plugins?.MessageLoggerEnhanced;
        if (mle?.coolReAddDeletedMessages) {
            messages = mle.coolReAddDeletedMessages(messages as MessagesArray & { extra?: unknown[]; }, payload) as MessagesArray;
        }
    } catch (_) { /* MLE not loaded or failed */ }
    const channelId = payload.channelId;
    if (!channelId) return messages;

    const persisted = channelFakeCache.get(channelId);
    if (!persisted?.length) return messages;

    const fakeMessages = persisted
        .filter(p => isValidDateMs(Date.parse(p.timestamp)))
        .map(hydratePersistedMessage) as unknown as MessagesArray;

    const bounds = getChunkTimeBounds(messages);
    if (!bounds) return messages;

    const channelStart = !payload.hasMoreAfter && !payload.isBefore;
    const channelEnd = !payload.hasMoreBefore && !payload.isAfter;

    const existingIds = new Set(messages.map(m => m.id));
    const toAdd = fakeMessages
        .filter(m => !existingIds.has(m.id))
        .filter(m => {
            const t = messageTimeMsFromId(m.id);
            if (!t) return false;
            if (channelStart && channelEnd) return true;
            if (channelStart) return t >= bounds.min;
            if (channelEnd) return t <= bounds.max;
            return t >= bounds.min && t <= bounds.max;
        });

    if (!toAdd.length) return messages;

    try {
        mergeMessagesStableInPlace(messages, toAdd);
    } catch { }

    return messages;
}

/** Merge into fetch response body as backup (in case getter patch runs in different order). */
async function mergeFakedmsIntoResponse(response: {
    body?: Array<{ id: string; channel_id?: string; timestamp?: string;[k: string]: unknown; }>;
}): Promise<void> {
    try {
        const mle = (globalThis as typeof window & { Vencord?: { Plugins?: { plugins?: Record<string, { processMessageFetch?: (r: unknown) => Promise<void>; }>; }; }; }).Vencord?.Plugins?.plugins?.MessageLoggerEnhanced;
        if (mle?.processMessageFetch) await mle.processMessageFetch(response);
    } catch (_) { /* MLE not loaded or failed */ }
    if (!response?.body || !Array.isArray(response.body) || response.body.length === 0) return;
    const channelId = response.body[0].channel_id ?? response.body[response.body.length - 1].channel_id;
    if (!channelId) return;

    const ts0 = safeIsoTimestamp(response.body[0].timestamp ?? "");
    const tsN = safeIsoTimestamp(response.body[response.body.length - 1].timestamp ?? "");
    const start = ts0 < tsN ? ts0 : tsN;
    const end = ts0 < tsN ? tsN : ts0;

    const persisted = await getFakesForChannelInRange(channelId, start, `${end}\uffff`);
    if (persisted.length === 0) return;

    const hydrated = persisted.map(hydratePersistedMessage);

    const bodyAny = response.body as typeof response.body & { extra?: unknown[]; };
    bodyAny.extra ??= [];
    bodyAny.extra.push(...hydrated);
}

function applyMessageStorePatch() {
    if (originalGetMessages && MessageStore.getMessages !== originalGetMessages) return;
    originalGetMessages = MessageStore.getMessages.bind(MessageStore);
    MessageStore.getMessages = function (channelId: string) {
        const result = originalGetMessages(channelId);
        const persisted = channelFakeCache.get(channelId);

        if (!persisted?.length) return result;

        const existingMap = result._map ?? {};
        const existingArray = result._array ?? [];

        const fakeIds = new Set(persisted.map(p => p.id));
        const realMessages = existingArray.filter((m: Message) => !fakeIds.has(m.id));

        if (!realMessages.length) {
            const hydratedFakes = persisted
                .filter(p => isValidDateMs(Date.parse(p.timestamp)))
                .map(hydratePersistedMessage)
                .sort((a, b) => compareMessages(a, b));

            const newMap = { ...existingMap };
            hydratedFakes.forEach(m => { (newMap as Record<string, Message>)[m.id] = m; });

            (result as Record<string, unknown>)._array = hydratedFakes;
            (result as Record<string, unknown>)._map = newMap;
            return result;
        }

        const bounds = getChunkTimeBounds(realMessages as unknown as MessagesArray);
        if (!bounds) {
            return result;
        }

        const existingIds = new Set(realMessages.map((m: Message) => m.id));
        const cachedFakesInWindow = persisted
            .filter(p => !existingIds.has(p.id))
            .filter(p => isValidDateMs(Date.parse(p.timestamp)))
            .map(hydratePersistedMessage);

        const allFakes = cachedFakesInWindow;
        if (!allFakes.length) {
            return result;
        }

        const combined = mergeMessagesStable(realMessages, allFakes);
        const newMap = { ...existingMap };

        for (const id of fakeIds) {
            delete (newMap as Record<string, Message>)[id];
        }
        allFakes.forEach(m => { (newMap as Record<string, Message>)[m.id] = m; });

        (result as Record<string, unknown>)._array = combined;
        (result as Record<string, unknown>)._map = newMap;
        return result;
    };
}

function removeMessageStorePatch() {
    if (originalGetMessages && MessageStore.getMessages !== originalGetMessages) {
        MessageStore.getMessages = originalGetMessages;
    }
}

async function dispatchAndStore(channelId: string, message: Message): Promise<void> {
    const persisted = serializeMessage(channelId, message);
    persisted.timestamp = safeIsoTimestamp(persisted.timestamp);
    await putFakeToDb(persisted);

    channelsWithFakes.add(channelId);
    privateChannelSortStore.emitChange?.();

    channelFakeCache.delete(channelId);
    await ensureChannelCacheLoaded(channelId);

    const hydrated = hydratePersistedMessage(persisted);
    FluxDispatcher.dispatch({ type: "MESSAGE_CREATE", channelId, message: hydrated });
    refreshMessages();
}

function toDatetimeLocal(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${y}-${m}-${day}T${h}:${min}:${s}.${ms}`;
}

function fromDatetimeLocal(s: string): Date {
    const trimmed = s.trim();
    const normalized = trimmed.length === 16
        ? `${trimmed}:00.000`
        : trimmed.length === 19
            ? `${trimmed}.000`
            : trimmed;
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? new Date() : d;
}

type FakeParticipantState = { mute: boolean; deaf: boolean; video: boolean; stream: boolean; };
const defaultParticipantState = (): FakeParticipantState => ({ mute: false, deaf: false, video: false, stream: false });

const activeFakeCalls = new Map<string, Map<string, FakeParticipantState>>();
const fakeCallStarts = new Map<string, number>();
const fakeCallMessageIds = new Map<string, string>();
const fakeCallListeners = new Set<() => void>();

function getFakeCallStartedAt(channelId: string): number | null {
    return fakeCallStarts.get(channelId) ?? null;
}

function notifyFakeCallListeners() {
    for (const fn of fakeCallListeners) fn();
    emitVoiceChannelChange();
    emitRtcConnectionChange();
}

async function persistFakeCall(channelId: string): Promise<void> {
    try {
        await initDb();
        const participants = activeFakeCalls.get(channelId);
        if (!participants) {
            await db.delete("fakeCalls", channelId);
        } else {
            const list = Array.from(participants.entries()).map(([userId, s]) => ({ userId, ...s }));
            const startedAt = fakeCallStarts.get(channelId) ?? Date.now();
            const messageId = fakeCallMessageIds.get(channelId);
            await db.put("fakeCalls", { channelId, participants: list as any, startedAt, messageId } as any);
        }
    } catch (e) {
        logger.error("Failed to persist fake call:", e);
    }
}

function isFakeCallActive(channelId: string): boolean {
    return activeFakeCalls.has(channelId);
}

function getFakeCallParticipants(channelId: string): string[] {
    return Array.from(activeFakeCalls.get(channelId)?.keys() ?? []);
}

function getFakeParticipantState(channelId: string, userId: string): FakeParticipantState | null {
    return activeFakeCalls.get(channelId)?.get(userId) ?? null;
}

function dispatchVoiceStateForParticipant(channelId: string | null, userId: string, state: FakeParticipantState): void {
    FluxDispatcher.dispatch({
        type: "VOICE_STATE_UPDATES",
        voiceStates: [{
            userId,
            channelId,
            guildId: null,
            sessionId: `fakedms-${userId}`,
            deaf: false,
            mute: false,
            selfDeaf: state.deaf,
            selfMute: state.mute || state.deaf,
            selfVideo: state.video,
            selfStream: state.stream,
            suppress: false,
            requestToSpeakTimestamp: null,
        }],
    });
}

function dispatchCallCreate(channelId: string): void {
    FluxDispatcher.dispatch({
        type: "CALL_CREATE",
        channelId,
        messageId: fakeMessageId(Date.now()),
        region: "us-east",
        ongoingRings: {},
    });
}

function buildCallMessageParticipants(channelId: string): string[] {
    const channel = ChannelStore.getChannel(channelId);
    const currentUser = UserStore.getCurrentUser();
    if (!channel || !currentUser) return [];
    const recipientIds = ((channel.recipients ?? []) as string[]).filter(id => id !== currentUser.id);
    return Array.from(new Set([currentUser.id, ...recipientIds]));
}

async function persistOngoingCallMessage(channelId: string, startMs: number): Promise<void> {
    try {
        const currentUser = UserStore.getCurrentUser();
        if (!currentUser) return;
        const participants = buildCallMessageParticipants(channelId);
        const messageId = fakeMessageId(startMs);
        fakeCallMessageIds.set(channelId, messageId);
        const base = createBotMessage({ channelId, content: "", embeds: [] });
        const message: Message = new MessageRecord({
            ...base,
            id: messageId,
            channel_id: channelId,
            timestamp: new Date(startMs),
            edited_timestamp: null,
            flags: 0,
            author: currentUser,
            attachments: [],
            embeds: [],
            stickerItems: [],
            components: [],
            type: 3,
            call: {
                participants,
                endedTimestamp: null,
                duration: moment.duration(0),
            },
            mentions: [],
            mentionRoles: [],
            mentionChannels: [],
            mentionEveryone: false,
            tts: false,
        });
        await dispatchAndStore(channelId, message);
    } catch (e) {
        logger.error("Failed to persist ongoing call message:", e);
    }
}

async function finalizeCallMessage(channelId: string, messageId: string, startMs: number, durationMs: number): Promise<void> {
    try {
        await initDb();
        const persisted = await db.get("messages", messageId);
        if (!persisted) return;
        const endedMs = startMs + durationMs;
        persisted.call = {
            participants: persisted.call?.participants ?? buildCallMessageParticipants(channelId),
            endedTimestamp: new Date(endedMs).toISOString(),
            duration: durationMs,
        };
        await putFakeToDb(persisted);
        channelFakeCache.delete(channelId);
        await ensureChannelCacheLoaded(channelId);
        const hydrated = hydratePersistedMessage(persisted);
        FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message: hydrated });
        refreshMessages();
    } catch (e) {
        logger.error("Failed to finalize call message:", e);
    }
}

function startFakeCall(channelId: string): void {
    if (activeFakeCalls.has(channelId)) return;
    const startMs = Date.now();
    activeFakeCalls.set(channelId, new Map());
    fakeCallStarts.set(channelId, startMs);
    dispatchCallCreate(channelId);
    void persistOngoingCallMessage(channelId, startMs).then(() => persistFakeCall(channelId));
    notifyFakeCallListeners();
}

function fakeJoinCall(channelId: string, userId: string): void {
    const participants = activeFakeCalls.get(channelId);
    if (!participants || participants.has(userId)) return;
    const state = defaultParticipantState();
    participants.set(userId, state);
    dispatchVoiceStateForParticipant(channelId, userId, state);
    void persistFakeCall(channelId);
    notifyFakeCallListeners();
}

function fakeLeaveCall(channelId: string, userId: string): void {
    const participants = activeFakeCalls.get(channelId);
    const state = participants?.get(userId);
    if (!participants || !state) return;
    participants.delete(userId);
    dispatchVoiceStateForParticipant(null, userId, state);
    void persistFakeCall(channelId);
    notifyFakeCallListeners();
}

function setFakeParticipantState(channelId: string, userId: string, partial: Partial<FakeParticipantState>): void {
    const participants = activeFakeCalls.get(channelId);
    const state = participants?.get(userId);
    if (!participants || !state) return;
    const next = { ...state, ...partial };
    participants.set(userId, next);
    dispatchVoiceStateForParticipant(channelId, userId, next);
    void persistFakeCall(channelId);
    notifyFakeCallListeners();
}

function endFakeCall(channelId: string, options?: { suppressMessage?: boolean; }): void {
    const participants = activeFakeCalls.get(channelId);
    if (!participants) return;
    const startedAt = fakeCallStarts.get(channelId);
    const messageId = fakeCallMessageIds.get(channelId);
    const durationMs = startedAt != null ? Math.max(0, Date.now() - startedAt) : 0;
    for (const [userId, state] of Array.from(participants.entries())) {
        dispatchVoiceStateForParticipant(null, userId, state);
    }
    activeFakeCalls.delete(channelId);
    fakeCallStarts.delete(channelId);
    fakeCallMessageIds.delete(channelId);
    void persistFakeCall(channelId);
    notifyFakeCallListeners();
    const doFinalize = !options?.suppressMessage && startedAt != null && messageId != null;
    if (doFinalize) {
        void finalizeCallMessage(channelId, messageId!, startedAt!, durationMs).then(() => {
            FluxDispatcher.dispatch({ type: "CALL_DELETE", channelId });
        });
    } else {
        FluxDispatcher.dispatch({ type: "CALL_DELETE", channelId });
    }
}

function endAllFakeCalls(): void {
    for (const channelId of Array.from(activeFakeCalls.keys())) {
        const participants = activeFakeCalls.get(channelId);
        if (participants) {
            for (const [userId, state] of Array.from(participants.entries())) {
                dispatchVoiceStateForParticipant(null, userId, state);
            }
        }
        FluxDispatcher.dispatch({ type: "CALL_DELETE", channelId });
    }
    activeFakeCalls.clear();
    fakeCallStarts.clear();
    notifyFakeCallListeners();
}

async function restoreFakeCalls(): Promise<void> {
    try {
        await initDb();
        const rows = await db.getAll("fakeCalls") as Array<{ channelId: string; startedAt?: number; participants: Array<string | (FakeParticipantState & { userId: string; })>; }>;
        for (const row of rows) {
            if (!row?.channelId) continue;
            const map = new Map<string, FakeParticipantState>();
            for (const entry of row.participants ?? []) {
                if (typeof entry === "string") {
                    map.set(entry, defaultParticipantState());
                } else if (entry?.userId) {
                    map.set(entry.userId, {
                        mute: !!entry.mute,
                        deaf: !!entry.deaf,
                        video: !!entry.video,
                        stream: !!entry.stream,
                    });
                }
            }
            activeFakeCalls.set(row.channelId, map);
            fakeCallStarts.set(row.channelId, row.startedAt ?? Date.now());
            dispatchCallCreate(row.channelId);
            for (const [userId, state] of map.entries()) {
                dispatchVoiceStateForParticipant(row.channelId, userId, state);
            }
        }
        if (rows.length) notifyFakeCallListeners();
    } catch (e) {
        logger.error("Failed to restore fake calls:", e);
    }
}

interface FakeMessageModalProps {
    modalProps: ModalProps;
    channelId: string;
}

function FakeMessageModal({ modalProps, channelId }: FakeMessageModalProps) {
    const channel = ChannelStore.getChannel(channelId);
    const currentUser = UserStore.getCurrentUser();
    const guildId = channel?.guild_id;

    const [userId, setUserId] = useState(currentUser.id);
    const [userIdInput, setUserIdInput] = useState("");
    const [content, setContent] = useState("");
    const [datetimeLocal, setDatetimeLocal] = useState(toDatetimeLocal(new Date()));
    const [messageType, setMessageType] = useState<"text" | "call" | "media" | "sticker" | "embed" | "livecall">("text");
    const [, forceFakeCallRender] = useState(0);
    const [liveCallAddUserId, setLiveCallAddUserId] = useState("");
    const [callTick, setCallTick] = useState(0);
    React.useEffect(() => {
        const fn = () => forceFakeCallRender(n => n + 1);
        fakeCallListeners.add(fn);
        return () => { fakeCallListeners.delete(fn); };
    }, []);
    const liveCallActive = messageType === "livecall" && isFakeCallActive(channelId);
    React.useEffect(() => {
        if (!liveCallActive) return;
        const id = window.setInterval(() => setCallTick(t => t + 1), 1000);
        return () => window.clearInterval(id);
    }, [liveCallActive]);

    const [attachmentUrl, setAttachmentUrl] = useState("");
    const [attachmentFilename, setAttachmentFilename] = useState("");
    const [attachmentWidth, setAttachmentWidth] = useState("");
    const [attachmentHeight, setAttachmentHeight] = useState("");

    const [embedTitle, setEmbedTitle] = useState("");
    const [embedDescription, setEmbedDescription] = useState("");
    const [embedColor, setEmbedColor] = useState("#5865F2");
    const [embedImageUrl, setEmbedImageUrl] = useState("");

    const [stickerUrl, setStickerUrl] = useState("");
    const [stickerName, setStickerName] = useState("");

    const [callState, setCallState] = useState<"ended" | "missed">("ended");
    const [callDurationValue, setCallDurationValue] = useState("");
    const [callDurationUnit, setCallDurationUnit] = useState<"seconds" | "minutes" | "hours" | "days">("minutes");

    const durationUnitOptions = useMemo(() => [
        { label: "Seconds", value: "seconds" },
        { label: "Minutes", value: "minutes" },
        { label: "Hours", value: "hours" },
        { label: "Days", value: "days" },
    ], []);

    const selectedDurationUnit = useMemo(() =>
        durationUnitOptions.find(opt => opt.value === callDurationUnit) || durationUnitOptions[1],
        [callDurationUnit, durationUnitOptions]
    );

    const formatCallDuration = (seconds: number): string => {
        if (seconds < 59) return "lasted a few seconds";

        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(seconds / 3600);
        const days = Math.floor(seconds / 86400);

        if (days > 0) {
            return days === 1 ? "lasted 1 day" : `lasted ${days} days`;
        }
        if (hours > 0) {
            const remainingMinutes = minutes % 60;
            if (hours === 1 && remainingMinutes === 0) return "lasted an hour";
            if (remainingMinutes === 0) return `lasted ${hours} hours`;
            return `lasted ${hours} hour${hours > 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}`;
        }
        if (minutes === 1) return "lasted 1 minute";
        return `lasted ${minutes} minutes`;
    };

    const handleMediaUrlChange = async (url: string) => {
        setAttachmentUrl(url);
        if (!url) return;

        if (!attachmentFilename) {
            const filename = url.split('/').pop()?.split('?')[0] || 'image.png';
            setAttachmentFilename(filename);
        }

        if (!attachmentWidth || !attachmentHeight) {
            try {
                const img = new Image();
                img.onload = () => {
                    if (!attachmentWidth) setAttachmentWidth(String(img.width));
                    if (!attachmentHeight) setAttachmentHeight(String(img.height));
                };
                img.src = url;
            } catch (e) {
            }
        }
    };

    const userOptions = useMemo(() => {
        const meLabel = currentUser.global_name && currentUser.global_name !== currentUser.username
            ? `${currentUser.global_name} (@${currentUser.username})`
            : (currentUser.username ?? currentUser.global_name ?? "You");
        const options: { label: string; value: string; }[] = [
            { label: `Me (${meLabel})`, value: currentUser.id },
        ];
        if (guildId) {
            try {
                const members = GuildMemberStore.getMembers(guildId) ?? [];
                const seen = new Set<string>([currentUser.id]);
                for (const member of members) {
                    const uid = (member as { userId?: string; }).userId;
                    if (!uid || seen.has(uid)) continue;
                    seen.add(uid);
                    const user = UserStore.getUser(uid);
                    const nick = (member as { nick?: string | null; }).nick;
                    const displayName = nick ?? user?.global_name ?? user?.username ?? uid;
                    const username = user?.username ?? uid;
                    const label = displayName !== username ? `${displayName} (@${username})` : (displayName || uid);
                    options.push({ label, value: uid });
                }
            } catch (_) { }
        } else {
            const recipientIds = (channel?.recipients ?? []) as string[];
            const rawRecipients = (channel?.rawRecipients ?? []) as { id?: string; username?: string; }[];
            for (const id of recipientIds) {
                if (id === currentUser.id) continue;
                const user = UserStore.getUser(id);
                const raw = rawRecipients.find(r => r.id === id);
                const displayName = user?.global_name ?? user?.username ?? raw?.username ?? id;
                const username = user?.username ?? raw?.username ?? id;
                const label = displayName !== username ? `${displayName} (@${username})` : (displayName || id);
                options.push({ label, value: id });
            }
        }
        return options;
    }, [guildId, channel?.recipients, channel?.rawRecipients, currentUser.id, currentUser.username, currentUser.global_name]);

    const author = useMemo(() => {
        if (userId === currentUser.id) return currentUser;
        const user = UserStore.getUser(userId);
        if (user) return user;
        const buildSynthetic = (username: string, globalName: string | null, avatarUrl: string | null) => {
            const resolvedAvatar = avatarUrl ?? (() => { try { return IconUtils.getDefaultAvatarURL(userId); } catch { return ""; } })();
            return {
                id: userId,
                username,
                usernameNormalized: username.toLowerCase(),
                globalName,
                global_name: globalName,
                discriminator: "0",
                avatar: null,
                avatarDecorationData: null,
                banner: null,
                accentColor: null,
                bot: false,
                system: false,
                flags: 0,
                publicFlags: 0,
                premiumType: 0,
                phone: null,
                email: null,
                mfaEnabled: false,
                verified: false,
                desktop: false,
                mobile: false,
                hasAnyStaffLevel: () => false,
                hasFlag: () => false,
                isClaimed: () => true,
                isClyde: () => false,
                isLocalBot: () => false,
                isNonUserBot: () => false,
                isPhoneVerified: () => true,
                isPomelo: () => true,
                isSystemUser: () => false,
                isVerifiedBot: () => false,
                hasUniqueUsername: () => true,
                hasPremiumPerks: false,
                hasFreePremium: () => false,
                getAvatarURL: () => resolvedAvatar,
                getAvatarSource: () => ({ uri: resolvedAvatar }),
                getBannerURL: () => null,
                tag: username,
                toString: () => `<@${userId}>`,
            } as unknown as Message["author"];
        };

        if (guildId) {
            const member = GuildMemberStore.getMember(guildId, userId);
            if (member) {
                const memberAvatar = (member as { avatar?: string | null; }).avatar;
                const avatarUrl = memberAvatar && IconUtils.getGuildMemberAvatarURLSimple
                    ? IconUtils.getGuildMemberAvatarURLSimple({ guildId, userId, avatar: memberAvatar, size: 32 })
                    : null;
                const nick = (member as { nick?: string | null; }).nick;
                return buildSynthetic(nick ?? userId, nick ?? null, avatarUrl);
            }
        }
        const rawRecipients = (channel?.rawRecipients ?? []) as { id?: string; username?: string; global_name?: string | null; }[];
        const raw = rawRecipients.find(r => r.id === userId);
        return buildSynthetic(raw?.username ?? userId, raw?.global_name ?? null, null);
    }, [userId, currentUser, guildId, channel?.rawRecipients]);

    const selectedUserOption = useMemo(() => userOptions.find(o => o.value === userId), [userOptions, userId]);
    const tsMs = useMemo(() => clampMsForSnowflake(fromDatetimeLocal(datetimeLocal).getTime()), [datetimeLocal]);
    const previewId = useMemo(() => fakeMessageId(tsMs), [tsMs]);

    const previewMessage = useMemo((): Message | null => {
        if (!author || !channel) return null;
        try {
        const attachments: FakeAttachment[] = [];
        const embeds: FakeEmbed[] = [];
        const stickerItems: FakeSticker[] = [];
        let msgType = 0;
        let call: { participants: string[]; endedTimestamp: Date; duration: number } | undefined;
        if (messageType === "media" && attachmentUrl) {
            attachments.push({
                id: previewId + "_0",
                filename: attachmentFilename || "image.png",
                url: attachmentUrl,
                proxy_url: attachmentUrl,
                width: attachmentWidth ? parseInt(attachmentWidth) || undefined : undefined,
                height: attachmentHeight ? parseInt(attachmentHeight) || undefined : undefined,
            });
        }
        if (messageType === "embed" && (embedTitle || embedDescription)) {
            embeds.push({
                title: embedTitle || undefined,
                description: embedDescription || undefined,
                color: parseInt(embedColor.replace("#", ""), 16) || 0x5865f2,
                image: embedImageUrl ? { url: embedImageUrl } : undefined,
            });
        }
        if (messageType === "sticker" && stickerUrl) {
            stickerItems.push({
                id: stickerUrl.match(/stickers\/(\d+)/)?.[1] || previewId + "_sticker",
                name: stickerName || "Sticker",
                format_type: 1,
            });
        }
        if (messageType === "call") {
            msgType = 3;
            let durationSeconds = 0;
            const value = parseInt(callDurationValue) || 0;
            switch (callDurationUnit) {
                case "seconds": durationSeconds = value; break;
                case "minutes": durationSeconds = value * 60; break;
                case "hours": durationSeconds = value * 3600; break;
                case "days": durationSeconds = value * 86400; break;
            }
            const participants = callState === "missed"
                ? [userId].filter(id => id !== currentUser.id)
                : Array.from(new Set([userId, currentUser.id]));
            const endedMs = durationSeconds > 0 ? tsMs + durationSeconds * 1000 : tsMs;
            call = { participants, endedTimestamp: new Date(endedMs), duration: moment.duration(durationSeconds * 1000) };
        }
        const base = createBotMessage({
            channelId,
            content: messageType === "call" ? "" : (content || "\u200b"),
            embeds,
        });
        return new MessageRecord({
            ...base,
            id: previewId,
            channel_id: channelId,
            timestamp: new Date(tsMs),
            edited_timestamp: null,
            flags: 0,
            author,
            attachments,
            embeds,
            stickerItems,
            components: [],
            mentions: [],
            mentionRoles: [],
            mentionChannels: [],
            mentionEveryone: false,
            tts: false,
            type: msgType,
            call,
        }) as Message;
        } catch (e) {
            logger.error("Failed to build preview message:", e);
            return null;
        }
    }, [
        author, channel, channelId, content, messageType, attachmentUrl, attachmentFilename, attachmentWidth, attachmentHeight,
        embedTitle, embedDescription, embedColor, embedImageUrl, stickerUrl, stickerName,
        callState, callDurationValue, callDurationUnit, userId, currentUser.id, tsMs,
    ]);

    const adjustTime = (deltaMs: number) => setDatetimeLocal(prev => toDatetimeLocal(new Date(fromDatetimeLocal(prev).getTime() + deltaMs)));
    const presets: { label: string; fn: () => void; }[] = [
        { label: "−1h", fn: () => adjustTime(-3600 * 1000) },
        { label: "−10m", fn: () => adjustTime(-10 * 60 * 1000) },
        { label: "−1m", fn: () => adjustTime(-60 * 1000) },
        { label: "Now", fn: () => setDatetimeLocal(toDatetimeLocal(new Date())) },
        { label: "+1m", fn: () => adjustTime(60 * 1000) },
        { label: "+10m", fn: () => adjustTime(10 * 60 * 1000) },
        { label: "+1h", fn: () => adjustTime(3600 * 1000) },
    ];

    const handleSend = async () => {
        if (!author) return;
        const tsMs = clampMsForSnowflake(fromDatetimeLocal(datetimeLocal).getTime());
        const safeTimestamp = safeIsoFromMs(tsMs);
        const messageId = fakeMessageId(tsMs);

        const attachments: FakeAttachment[] = [];
        const embeds: FakeEmbed[] = [];
        const stickerItems: FakeSticker[] = [];
        let msgType = 0;
        let call: any = undefined;

        if (messageType === "media" && attachmentUrl) {
            attachments.push({
                id: messageId + "_0",
                filename: attachmentFilename || "image.png",
                url: attachmentUrl,
                proxy_url: attachmentUrl,
                width: attachmentWidth ? parseInt(attachmentWidth) : undefined,
                height: attachmentHeight ? parseInt(attachmentHeight) : undefined,
            });
        }

        if (messageType === "embed" && (embedTitle || embedDescription)) {
            embeds.push({
                title: embedTitle || undefined,
                description: embedDescription || undefined,
                color: parseInt(embedColor.replace("#", ""), 16),
                image: embedImageUrl ? { url: embedImageUrl } : undefined,
            });
        }

        if (messageType === "sticker" && stickerUrl) {
            const stickerId = stickerUrl.match(/stickers\/(\d+)/)?.[1] || messageId + "_sticker";
            stickerItems.push({
                id: stickerId,
                name: stickerName || "Sticker",
                format_type: 1,
            });
        }

        if (messageType === "call") {
            msgType = 3;
            let durationSeconds = 0;
            const value = parseInt(callDurationValue) || 0;
            switch (callDurationUnit) {
                case "seconds": durationSeconds = value; break;
                case "minutes": durationSeconds = value * 60; break;
                case "hours": durationSeconds = value * 3600; break;
                case "days": durationSeconds = value * 86400; break;
            }
            const participants = callState === "missed"
                ? [userId].filter(id => id !== currentUser.id)
                : Array.from(new Set([userId, currentUser.id]));
            const durationMs = durationSeconds * 1000;
            const endedMs = durationMs > 0 ? tsMs + durationMs : tsMs;
            call = { participants, endedTimestamp: new Date(endedMs), duration: durationMs };
        }

        const base = createBotMessage({
            channelId,
            content: messageType === "call" ? "" : (content || "\u200b"),
            embeds,
        });

        const message: Message = new MessageRecord({
            ...base,
            id: messageId,
            channel_id: channelId,
            timestamp: new Date(tsMs),
            edited_timestamp: null,
            flags: 0,
            author,
            attachments,
            embeds,
            stickerItems,
            components: [],
            mentions: [],
            mentionRoles: [],
            mentionChannels: [],
            mentionEveryone: false,
            tts: false,
            type: msgType,
            call,
        });

        await dispatchAndStore(channelId, message);
        modalProps.onClose();
    };

    const displayName = author?.global_name ?? author?.username ?? (author as { id?: string; })?.id ?? "Unknown user";
    const avatarUrl = author?.getAvatarURL?.(undefined, 32) ?? (author as { getAvatarURL?: () => string; })?.getAvatarURL?.();

    const channelRecord = channel ?? null;

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader separator={false} className={cl("modal-header")}>
                <div className={cl("header-icon")}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                        <path d="M12 2C6.48 2 2 5.92 2 10.66c0 2.75 1.5 5.2 3.84 6.82-.1 1.17-.5 2.8-1.84 4.02 0 0 3.1-.35 5.28-2.08.88.17 1.79.24 2.72.24 5.52 0 10-3.92 10-8.66S17.52 2 12 2Z" />
                    </svg>
                </div>
                <div className={cl("header-text")}>
                    <Heading tag="h2" className={cl("modal-title")}>Fake Message</Heading>
                    <Forms.FormText className={cl("modal-subtitle")}>Craft and inject messages into any DM conversation.</Forms.FormText>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent className={cl("modal-content")}>
                {messageType !== "livecall" && (
                <Forms.FormSection className={cl("preview-section")}>
                    <div className={cl("preview-box")}>
                    <ScrollerThin className={cl("preview-scroller")}>
                        {previewMessage && channelRecord ? (
                            <ErrorBoundary noop fallback={() => <Forms.FormText className={cl("preview-placeholder")}>Preview unavailable.</Forms.FormText>}>
                                <ChannelMessage
                                    className={classes(cl("preview-message"), messageClasses?.message, messageClasses?.groupStart, messageClasses?.cozyMessage)}
                                    groupId={previewId}
                                    id={previewId}
                                    compact={false}
                                    isHighlight={false}
                                    isLastItem={false}
                                    renderContentOnly={false}
                                    channel={channelRecord}
                                    message={previewMessage}
                                />
                            </ErrorBoundary>
                        ) : (
                            <Forms.FormText className={cl("preview-placeholder")}>Select an author to see preview.</Forms.FormText>
                        )}
                    </ScrollerThin>
                    </div>
                </Forms.FormSection>
                )}

                <Forms.FormSection className={cl("form-section")}>
                    <TabBar
                        type="top"
                        look="brand"
                        className={cl("tab-bar")}
                        selectedItem={messageType}
                        onItemSelect={e => setMessageType(e as typeof messageType)}
                    >
                        <TabBar.Item className={cl("tab-item")} id="text">Text</TabBar.Item>
                        <TabBar.Item className={cl("tab-item")} id="media">Media</TabBar.Item>
                        <TabBar.Item className={cl("tab-item")} id="embed">Embed</TabBar.Item>
                        <TabBar.Item className={cl("tab-item")} id="sticker">Sticker</TabBar.Item>
                        <TabBar.Item className={cl("tab-item")} id="call">Call</TabBar.Item>
                        <TabBar.Item className={cl("tab-item")} id="livecall">Live Call</TabBar.Item>
                    </TabBar>
                </Forms.FormSection>

                {messageType !== "livecall" && (
                <Forms.FormSection className={cl("form-section")}>
                    <Forms.FormTitle tag="h5" className={cl("field-label")}>Author</Forms.FormTitle>
                    <SearchableSelect
                        options={userOptions}
                        value={selectedUserOption}
                        placeholder="Select user..."
                        clearable={false}
                        maxVisibleItems={8}
                        closeOnSelect={true}
                        onChange={v => {
                            const id = typeof v === "string" ? v : (v as { value?: string; })?.value;
                            if (id) { setUserId(id); setUserIdInput(""); }
                        }}
                        renderOptionPrefix={o => {
                            if (!o?.value) return null;
                            const user = UserStore.getUser(o.value);
                            const member = guildId ? GuildMemberStore.getMember(guildId, o.value) : null;
                            let src: string | null = null;
                            if (user?.getAvatarURL) src = user.getAvatarURL(undefined, 32);
                            else if (member && (member as { avatar?: string; }).avatar && IconUtils.getGuildMemberAvatarURLSimple)
                                src = IconUtils.getGuildMemberAvatarURLSimple({ guildId: guildId!, userId: o.value, avatar: (member as { avatar: string; }).avatar, size: 32 });
                            return src ? <Avatar src={src} size="SIZE_24" aria-hidden /> : null;
                        }}
                    />
                    <Forms.FormTitle tag="h5" className={cl("field-label")}>User ID</Forms.FormTitle>
                    <div className={cl("userid-input")}>
                        <TextInput
                            value={userIdInput}
                            onChange={v => { setUserIdInput(v); const id = v.trim(); setUserId(id || currentUser.id); }}
                            placeholder="Or paste user ID"
                        />
                    </div>
                </Forms.FormSection>
                )}

                {messageType === "text" && (
                    <Forms.FormSection className={cl("form-section")}>
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Message</Forms.FormTitle>
                        <div className={cl("textarea")}>
                            <TextArea value={content} onChange={setContent} placeholder="Message content..." />
                        </div>
                    </Forms.FormSection>
                )}

                {messageType === "media" && (
                    <Forms.FormSection className={cl("form-section")}>
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Image or video URL</Forms.FormTitle>
                        <TextInput value={attachmentUrl} onChange={handleMediaUrlChange} placeholder="https://..." />
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Filename</Forms.FormTitle>
                        <TextInput value={attachmentFilename} onChange={setAttachmentFilename} placeholder="image.png" />
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Width / height (optional)</Forms.FormTitle>
                        <Flex style={{ gap: 8 }}>
                            <TextInput value={attachmentWidth} onChange={setAttachmentWidth} placeholder="Width" />
                            <TextInput value={attachmentHeight} onChange={setAttachmentHeight} placeholder="Height" />
                        </Flex>
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Caption</Forms.FormTitle>
                        <div className={cl("textarea")}>
                            <TextArea value={content} onChange={setContent} placeholder="Optional caption..." />
                        </div>
                    </Forms.FormSection>
                )}

                {messageType === "embed" && (
                    <Forms.FormSection className={cl("form-section")}>
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Title</Forms.FormTitle>
                        <TextInput value={embedTitle} onChange={setEmbedTitle} placeholder="Embed title" />
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Description</Forms.FormTitle>
                        <div className={cl("textarea")}>
                            <TextArea value={embedDescription} onChange={setEmbedDescription} placeholder="Description..." />
                        </div>
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Color</Forms.FormTitle>
                        <TextInput value={embedColor} onChange={setEmbedColor} placeholder="#5865F2" />
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Image URL (optional)</Forms.FormTitle>
                        <TextInput value={embedImageUrl} onChange={setEmbedImageUrl} placeholder="https://..." />
                    </Forms.FormSection>
                )}

                {messageType === "sticker" && (
                    <Forms.FormSection className={cl("form-section")}>
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Sticker URL</Forms.FormTitle>
                        <TextInput value={stickerUrl} onChange={setStickerUrl} placeholder="https://..." />
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Name</Forms.FormTitle>
                        <TextInput value={stickerName} onChange={setStickerName} placeholder="Sticker name" />
                    </Forms.FormSection>
                )}

                {messageType === "livecall" && (() => {
                    const active = isFakeCallActive(channelId);
                    const joined = getFakeCallParticipants(channelId);
                    const joinedSet = new Set(joined);
                    const dmRecipientIds = ((channel?.recipients ?? []) as string[]).filter(id => id !== currentUser.id);
                    const candidates = [currentUser.id, ...dmRecipientIds];
                    const candidateSet = new Set(candidates);
                    const extraJoined = joined.filter(id => !candidateSet.has(id));
                    const userDisplayName = (id: string) => {
                        if (id === currentUser.id) return currentUser.global_name || currentUser.username || "You";
                        const u = UserStore.getUser(id);
                        return u?.global_name ?? u?.username ?? id;
                    };
                    const userAvatar = (id: string) => {
                        const u = UserStore.getUser(id);
                        return u?.getAvatarURL?.(undefined, 32) ?? IconUtils.getDefaultAvatarURL(id);
                    };
                    const renderRow = (id: string) => {
                        const joined = joinedSet.has(id);
                        const state = joined ? getFakeParticipantState(channelId, id) : null;
                        const toggle = (key: keyof FakeParticipantState) => () => setFakeParticipantState(channelId, id, { [key]: !state?.[key] });
                        return (
                            <div key={id} className={cl("call-row")}>
                                <img className={cl("call-row-avatar")} src={userAvatar(id)} alt="" />
                                <div className={cl("call-row-info")}>
                                    <div className={cl("call-row-name")}>{userDisplayName(id)}</div>
                                    <div className={cl("call-row-sub")}>{id === currentUser.id ? "You" : id}</div>
                                </div>
                                {joined && state && (() => {
                                    const Icons = DiscordIcons as Record<string, React.ComponentType<{ size?: string; width?: number; height?: number; }> | undefined>;
                                    const pick = (on: string, off: string, active: boolean, FallbackOn: React.FC, FallbackOff: React.FC) => {
                                        let NativeOn: React.ComponentType<{ size?: string; width?: number; height?: number; }> | undefined;
                                        let NativeOff: React.ComponentType<{ size?: string; width?: number; height?: number; }> | undefined;
                                        try { NativeOn = Icons?.[on]; NativeOff = Icons?.[off]; } catch { }
                                        if (active) return NativeOff ? <NativeOff size="custom" width={18} height={18} /> : <FallbackOff />;
                                        return NativeOn ? <NativeOn size="custom" width={18} height={18} /> : <FallbackOn />;
                                    };
                                    return (
                                        <div className={cl("call-row-toggles")}>
                                            <button className={classes(cl("call-toggle"), (state.mute || state.deaf) && cl("call-toggle-active"))} title={state.mute ? "Unmute" : "Mute"} onClick={toggle("mute")} disabled={state.deaf}>
                                                {pick("MicrophoneIcon", "MicrophoneSlashIcon", state.mute || state.deaf, MicOnIcon, MicOffIcon)}
                                            </button>
                                            <button className={classes(cl("call-toggle"), state.deaf && cl("call-toggle-active"))} title={state.deaf ? "Undeafen" : "Deafen"} onClick={toggle("deaf")}>
                                                {pick("HeadphonesIcon", "HeadphonesSlashIcon", state.deaf, HeadOnIcon, HeadOffIcon)}
                                            </button>
                                            <button className={classes(cl("call-toggle"), state.video && cl("call-toggle-active"))} title={state.video ? "Turn off camera" : "Turn on camera"} onClick={toggle("video")}>
                                                {pick("VideoIcon", "VideoSlashIcon", !state.video, VidOnIcon, VidOffIcon)}
                                            </button>
                                            <button className={classes(cl("call-toggle"), state.stream && cl("call-toggle-active"))} title={state.stream ? "Stop sharing" : "Start sharing"} onClick={toggle("stream")}>
                                                {pick("ScreenIcon", "ScreenSlashIcon", !state.stream, ScrOnIcon, ScrOffIcon)}
                                            </button>
                                        </div>
                                    );
                                })()}
                                {joined
                                    ? <button className={cl("call-row-btn")} onClick={() => fakeLeaveCall(channelId, id)}>Leave</button>
                                    : <button className={classes(cl("call-row-btn"), cl("call-row-btn-brand"))} onClick={() => fakeJoinCall(channelId, id)}>Join</button>}
                            </div>
                        );
                    };
                    return (
                        <>
                            <Forms.FormSection className={cl("form-section")}>
                                <div className={cl("livecall-status-card", active && "livecall-status-card-active")}>
                                    <div className={cl("livecall-status-row")}>
                                        <div className={classes(cl("livecall-status-pill"), active && cl("livecall-status-pill-active"))}>
                                            <div className={cl("livecall-status-dot")} />
                                            {active ? "Live" : "Idle"}
                                        </div>
                                        <div className={cl("livecall-status-text")}>
                                            {active ? (() => {
                                                const start = getFakeCallStartedAt(channelId);
                                                const elapsedMs = start != null ? Math.max(0, Date.now() - start) : 0;
                                                void callTick;
                                                const totalSec = Math.floor(elapsedMs / 1000);
                                                const h = Math.floor(totalSec / 3600);
                                                const m = Math.floor((totalSec % 3600) / 60);
                                                const s = totalSec % 60;
                                                const pad = (n: number) => String(n).padStart(2, "0");
                                                const formatted = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
                                                return `${formatted} · ${joined.length} ${joined.length === 1 ? "participant" : "participants"}`;
                                            })() : "No active call in this DM"}
                                        </div>
                                    </div>
                                    {active
                                        ? <button className={cl("livecall-action-btn", "livecall-action-btn-end")} onClick={() => endFakeCall(channelId)}>End Call</button>
                                        : <button className={cl("livecall-action-btn", "livecall-action-btn-start")} onClick={() => startFakeCall(channelId)}>Start Call</button>}
                                </div>
                            </Forms.FormSection>

                            {active && (
                                <Forms.FormSection className={cl("form-section")}>
                                    <Forms.FormTitle tag="h5" className={cl("field-label")}>DM Members</Forms.FormTitle>
                                    <div className={cl("call-list")}>
                                        {candidates.map(id => renderRow(id))}
                                    </div>
                                    {extraJoined.length > 0 && (
                                        <>
                                            <Forms.FormTitle tag="h5" className={cl("field-label")} style={{ marginTop: 16 }}>Added Users</Forms.FormTitle>
                                            <div className={cl("call-list")}>
                                                {extraJoined.map(id => renderRow(id))}
                                            </div>
                                        </>
                                    )}
                                    <Forms.FormTitle tag="h5" className={cl("field-label")} style={{ marginTop: 16 }}>Add User by ID</Forms.FormTitle>
                                    <Flex style={{ gap: 8 }}>
                                        <div style={{ flex: 1 }}>
                                            <TextInput
                                                value={liveCallAddUserId}
                                                onChange={setLiveCallAddUserId}
                                                placeholder="Paste a user ID"
                                            />
                                        </div>
                                        <Button
                                            disabled={!liveCallAddUserId.trim() || joinedSet.has(liveCallAddUserId.trim())}
                                            onClick={() => {
                                                const id = liveCallAddUserId.trim();
                                                if (!id) return;
                                                fakeJoinCall(channelId, id);
                                                setLiveCallAddUserId("");
                                            }}
                                        >Add to call</Button>
                                    </Flex>
                                </Forms.FormSection>
                            )}
                        </>
                    );
                })()}

                {messageType === "call" && (
                    <Forms.FormSection className={cl("form-section")}>
                        <Forms.FormTitle tag="h5" className={cl("field-label")}>Status</Forms.FormTitle>
                        <Flex style={{ gap: 8 }} className={cl("flex-row")}>
                            <Button size="small" color={callState === "ended" ? "brand" : "primary"} onClick={() => setCallState("ended")}>Ended</Button>
                            <Button size="small" color={callState === "missed" ? "brand" : "primary"} onClick={() => setCallState("missed")}>Missed</Button>
                        </Flex>
                        {callState === "ended" && (
                            <>
                                <Forms.FormTitle tag="h5" className={cl("field-label")}>Duration</Forms.FormTitle>
                                <Flex style={{ gap: 8, flexWrap: "wrap" }} className={cl("flex-row")}>
                                    <TextInput value={callDurationValue} onChange={setCallDurationValue} placeholder="5" style={{ width: 80 }} />
                                    <Button size="small" color={callDurationUnit === "seconds" ? "brand" : "primary"} onClick={() => setCallDurationUnit("seconds")}>Seconds</Button>
                                    <Button size="small" color={callDurationUnit === "minutes" ? "brand" : "primary"} onClick={() => setCallDurationUnit("minutes")}>Minutes</Button>
                                    <Button size="small" color={callDurationUnit === "hours" ? "brand" : "primary"} onClick={() => setCallDurationUnit("hours")}>Hours</Button>
                                    <Button size="small" color={callDurationUnit === "days" ? "brand" : "primary"} onClick={() => setCallDurationUnit("days")}>Days</Button>
                                </Flex>
                            </>
                        )}
                    </Forms.FormSection>
                )}

                {messageType !== "livecall" && (
                <Forms.FormSection className={cl("form-section")}>
                    <Forms.FormTitle tag="h5" className={cl("field-label")}>Timestamp</Forms.FormTitle>
                    <Flex style={{ gap: 8, alignItems: "center" }}>
                        <div style={{ flex: 1 }}>
                            <TextInput value={datetimeLocal} onChange={setDatetimeLocal} placeholder="2026-04-06T12:00:00.000" />
                        </div>
                        <div style={{ position: "relative", flexShrink: 0 }}>
                            <input
                                type="datetime-local"
                                step="1"
                                value={datetimeLocal.replace(/\.\d+$/, "")}
                                onChange={e => setDatetimeLocal(e.target.value + ".000")}
                                style={{ position: "absolute", opacity: 0, width: 0, height: 0, top: 0, left: 0 }}
                                ref={el => { if (el) (el as any).__fakedmsRef = el; }}
                                id="fakedms-datetime-picker"
                            />
                            <Button size="small" onClick={() => {
                                const el = document.getElementById("fakedms-datetime-picker") as HTMLInputElement;
                                el?.showPicker?.();
                            }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1ZM4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9H4Z" />
                                </svg>
                            </Button>
                        </div>
                    </Flex>
                    <Flex style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                        {presets.map(p => (
                            <Button key={p.label} size="small" onClick={p.fn}>{p.label}</Button>
                        ))}
                    </Flex>
                </Forms.FormSection>
                )}
            </ModalContent>
            {messageType !== "livecall" && (
            <ModalFooter className={cl("modal-footer")}>
                <Button onClick={handleSend} disabled={!author}>Send</Button>
            </ModalFooter>
            )}
        </ModalRoot>
    );
}

export function openFakeMessageModal() {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;
    openModal(modalProps => (
        <FakeMessageModal modalProps={modalProps} channelId={channelId} />
    ));
}

export default definePlugin({
    name: "FakeDms",
    openSettingsModal: openFakeMessageModal,
    description: "Create fake messages with custom timestamps. Alt+F to open. Session only (cleared on reload).",
    authors: [{ name: "gabe", id: 1467949308816003193n }],
    requiresRestart: true,
    patches: [
        {
            find: "_tryFetchMessagesCached",
            replacement: [
                {
                    match: /(?<=\.get\(\{url:.+?then\()(\i)=>\(/,
                    replace: "async $1=>(await $self.mergeFakedmsIntoResponse($1),"
                },
                {
                    match: /(?<=type:"LOAD_MESSAGES_SUCCESS",.{1,100})messages:(\i)/,
                    replace: "get messages() {return $self.mergeFakedmsIntoPayloadMessages($1, this);}"
                }
            ]
        },
        {
            find: "AccessibilityIcon:()=>",
            replacement: {
                match: /(\i)=\{\};(\i\.r\(\1\),\i\.d\(\1,)/,
                replace: "$1=arguments[1];$2"
            }
        },
    ],
    mergeFakedmsIntoResponse,
    mergeFakedmsIntoPayloadMessages,
    dependencies: ["PluginDock"],
    settings,
    start() {
        registerFakeDmsDock();
        addMessageContextEntry("fakeDms", (message) => {
            const channelId = (message as { channel_id?: string; })?.channel_id;
            const messageId = (message as { id?: string; })?.id;
            const isFake = !!(channelId && messageId && channelFakeCache.get(channelId)?.some(m => m.id === messageId));
            return (
                <>
                    <Menu.MenuItem
                        id="open-fake-message"
                        label="Fake message (Alt+F)"
                        action={() => openFakeMessageModal()}
                    />
                    {isFake && (
                        <Menu.MenuItem
                            id="delete-fake-message"
                            label="Delete fake message"
                            action={() => void deleteFake(channelId!, messageId!)}
                        />
                    )}
                </>
            );
        });
        addUserContextEntry("fakeDms", (userId) => {
            const isFake = isFakeFriend(userId);
            return (
                <Menu.MenuItem
                    id="toggle-fake-friend"
                    label={isFake ? "Remove fake friend" : "Add fake friend"}
                    action={() => {
                        if (isFake) void removeFakeFriend(userId);
                        else void addFakeFriend(userId);
                    }}
                />
            );
        });
        applyMessageStorePatch();
        applyRelationshipStorePatches();
        applyPrivateChannelSortStorePatch();
        applyVoiceChannelIdOverride();
        originalFluxDispatch = FluxDispatcher.dispatch.bind(FluxDispatcher);
        FluxDispatcher.dispatch = async (action: { type: string; channelId?: string; [k: string]: unknown }) => {
            if (action.type === "LOAD_MESSAGES_SUCCESS" && action.channelId && !channelFakeCache.has(action.channelId)) {
                await ensureChannelCacheLoaded(action.channelId);
            }
            return originalFluxDispatch!(action);
        };
        void (async () => {
            await migrateJsonToIdbOnce();
            await sanitizeDbOnce();
            await loadFakeFriends();
            try { await initDb(); await db.clear("fakeCalls"); } catch { }
            await loadChannelsWithFakes();
            await Promise.all(Array.from(channelsWithFakes, ensureChannelCacheLoaded));
            privateChannelSortStore.emitChange?.();
            const initialChannelId = SelectedChannelStore.getChannelId();
            if (!initialChannelId) return;
            channelFakeCache.delete(initialChannelId);
            await ensureChannelCacheLoaded(initialChannelId);
            refreshMessages();
        })();

        fluxInterceptor = (e: { type: string; channelId?: string; }) => {
            if (e.type === "CHANNEL_SELECT" && e.channelId) {
                logger.info(`[CHANNEL_SELECT] User opened channel ${e.channelId}`);
                const hasFakes = channelsWithFakes.has(e.channelId);
                logger.info(`[CHANNEL_SELECT] Channel has fake messages in DB: ${hasFakes}`);
                void ensureChannelCacheLoaded(e.channelId).then(() => refreshMessages());
            }
        };
        FluxDispatcher.addInterceptor(fluxInterceptor);

        keydownHandler = (e: KeyboardEvent) => {
            if (matchKb(e, settings.store.keybind)) {
                e.preventDefault();
                openFakeMessageModal();
            }

            if (e.key === "Control") ctrlDown = true;
            if (e.key === "Shift") shiftDown = true;

            if (ctrlDown && shiftDown && indicatorTimer == null && !settings.store.indicatorMode) {
                indicatorTimer = window.setTimeout(() => {
                    indicatorTimer = null;
                    settings.store.indicatorMode = true;
                    document.body.classList.add("vc-fakedms-indicator-active");
                    refreshMessages();
                    setTimeout(markFakeMessageElements, 50);
                    indicatorInterval = window.setInterval(markFakeMessageElements, 500);
                }, 2000);
            }
        };

        keyupHandler = (e: KeyboardEvent) => {
            if (e.key === "Control") ctrlDown = false;
            if (e.key === "Shift") shiftDown = false;

            if (!ctrlDown || !shiftDown) {
                if (indicatorTimer != null) {
                    window.clearTimeout(indicatorTimer);
                    indicatorTimer = null;
                }
                if (settings.store.indicatorMode) {
                    settings.store.indicatorMode = false;
                    if (indicatorInterval != null) {
                        window.clearInterval(indicatorInterval);
                        indicatorInterval = null;
                    }
                    document.body.classList.remove("vc-fakedms-indicator-active");
                    unmarkFakeMessageElements();
                    refreshMessages();
                }
            }
        };

        document.addEventListener("keydown", keydownHandler, { capture: true });
        document.addEventListener("keyup", keyupHandler, { capture: true });
    },
    stop() {
        endAllFakeCalls();
        removeDockButton("fakedms");
        removeMessageContextEntry("fakeDms");
        removeUserContextEntry("fakeDms");
        if (indicatorInterval != null) {
            window.clearInterval(indicatorInterval);
            indicatorInterval = null;
        }
        document.body.classList.remove("vc-fakedms-indicator-active");
        unmarkFakeMessageElements();
        if (originalFluxDispatch) {
            FluxDispatcher.dispatch = originalFluxDispatch;
            originalFluxDispatch = null;
        }
        document.removeEventListener("keydown", keydownHandler, true);
        document.removeEventListener("keyup", keyupHandler, true);
        removeMessageStorePatch();
        removeRelationshipStorePatches();
        removePrivateChannelSortStorePatch();
        removeVoiceChannelIdOverride();
        removeRtcConnectionOverride();
        if (fluxInterceptor) {
            const idx = FluxDispatcher._interceptors?.indexOf(fluxInterceptor);
            if (typeof idx === "number" && idx >= 0) FluxDispatcher._interceptors.splice(idx, 1);
            fluxInterceptor = null;
        }
    },
    onMessageClick(message: Message, channel: any, event: MouseEvent) {
        if (!event.ctrlKey || !event.shiftKey || event.button !== 0) return;

        const channelId = message?.channel_id;
        const messageId = message?.id;
        if (!channelId || !messageId) return;

        const cached = channelFakeCache.get(channelId);
        if (!cached?.some(m => m.id === messageId)) return;

        event.preventDefault();
        event.stopPropagation();

        void deleteFake(channelId, messageId);
    },
    renderMessageAccessory(props: Record<string, any>) {
        if (!settings.store.indicatorMode) return null;
        const message = props?.message as Message | undefined;
        const channelId = message?.channel_id;
        const messageId = message?.id;
        if (!channelId || !messageId) return null;
        const cached = channelFakeCache.get(channelId);
        if (!cached?.some(m => m.id === messageId)) return null;
        return <span className={cl("fake-indicator-marker")} />;
    },
});
