/*
 * Equicord, a Discord client mod
 * Copyright (c) 2026 Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { Button, Card, Paragraph, Span } from "@components/index";
import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { classes, sleep } from "@utils/misc";
import { ModalCloseButton, ModalFooter, ModalHeader, ModalRoot, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { ChannelActionCreators, ChannelStore, GuildChannelStore, IconUtils, RestAPI, ScrollerThin, SelectedChannelStore, Select, Slider, SnowflakeUtils, TextInput, Timestamp, Tooltip, UserStore } from "@webpack/common";
import { useCallback, useEffect, useRef, useState } from "@webpack/common";

const cl = classNameFactory("vc-purger-");
const logger = new Logger("MessagePurger");

const ManaSelect = findComponentByCodeLazy('"data-mana-component":"select"');
const PrivateChannelSortStore = findStoreLazy("PrivateChannelSortStore");

const settings = definePluginSettings({
    autoRateLimit: {
        type: OptionType.BOOLEAN,
        description: "Read Discord's X-RateLimit headers to pace requests at the maximum legal speed. When on, the manual delays are ignored.",
        default: true,
    },
    deleteDelay: {
        type: OptionType.SLIDER,
        description: "Default milliseconds between each delete.",
        default: 1250,
        markers: [500, 750, 1000, 1250, 1500, 2000, 3000],
    },
    searchDelay: {
        type: OptionType.SLIDER,
        description: "Default milliseconds to wait between search pages. 1000ms is safe; lower with caution.",
        default: 1000,
        markers: [500, 750, 1000, 1500, 2000, 3000],
    },
    keybind: {
        description: "Keybind to open the purge modal.",
        type: OptionType.STRING,
        default: "",
    },
});

function matchesPurgerKeybind(e: KeyboardEvent) {
    const parts = settings.store.keybind.split("+").map(p => p.trim().toLowerCase());
    for (const part of parts) {
        if (part === "alt" && !e.altKey) return false;
        if (part === "ctrl" && !e.ctrlKey) return false;
        if (part === "shift" && !e.shiftKey) return false;
        if (part === "meta" && !e.metaKey) return false;
        if (!["alt", "ctrl", "shift", "meta"].includes(part) && e.key.toLowerCase() !== part) return false;
    }
    return true;
}

// #region Types

interface SearchMessage {
    id: string;
    channel_id: string;
    author: { id: string; username: string; avatar: string; };
    content: string;
    timestamp: string;
    type: number;
    pinned: boolean;
    attachments: { filename: string; }[];
    embeds: { type?: string; }[];
    hit?: boolean;
    reactions?: { emoji: { id: string | null; name: string; }; count: number; me: boolean; }[];
    message_reference?: { type?: number; };
    activity?: { type?: number; };
}

interface SearchChannel {
    id: string;
    recipients?: { id: string; username: string; global_name: string | null; }[];
    name?: string;
}

interface SearchCursor {
    timestamp: string;
    type: string;
}

interface SearchResponse {
    total_results: number;
    messages: SearchMessage[][];
    channels?: SearchChannel[];
    cursor?: SearchCursor | null;
}

type PreviewStatus = "pending" | "deleting" | "deleted" | "failed" | "skipped";

interface PreviewEntry {
    msg: SearchMessage;
    status: PreviewStatus;
    reactEmojis?: { id: string | null; name: string; }[];
}

// fetching = phase 1 (collect all), running = phase 2 (delete)
type EngineState = "idle" | "fetching" | "running" | "done" | "stopped";

// #endregion

// #region Purge Engine (persists across modal open/close)

type EngineListener = () => void;

interface PurgeEngineData {
    state: EngineState;
    deleted: number;
    failed: number;
    skipped: number;
    totalFound: number;
    fetched: number;
    toDelete: number;
    fetchedByChannel: Record<string, number>;
    channelNames: Record<string, string>;
    status: string;
    preview: PreviewEntry[];
    channelId: string;
    channelLabel: string;
    startTime: number | null;
    paused: boolean;
}

const engineListeners = new Set<EngineListener>();
let engineCancel = false;
let engineData: PurgeEngineData = createFreshEngine();

function createFreshEngine(): PurgeEngineData {
    return {
        state: "idle",
        deleted: 0,
        failed: 0,
        skipped: 0,
        totalFound: 0,
        fetched: 0,
        toDelete: 0,
        fetchedByChannel: {},
        channelNames: {},
        status: "",
        preview: [],
        channelId: "",
        channelLabel: "",
        startTime: null,
        paused: false,
    };
}

function notifyListeners() {
    for (const l of engineListeners) l();
}

function updateEngine(partial: Partial<PurgeEngineData>) {
    Object.assign(engineData, partial);
    notifyListeners();
}

function updatePreviewStatus(id: string, status: PreviewStatus) {
    const idx = engineData.preview.findIndex(e => e.msg.id === id);
    if (idx >= 0) {
        engineData.preview[idx] = { ...engineData.preview[idx], status };
        engineData.preview = [...engineData.preview];
        notifyListeners();
    }
}

function addToPreview(msgs: SearchMessage[], status: PreviewStatus = "pending") {
    engineData.preview = [...engineData.preview, ...msgs.map(msg => ({ msg, status }))];
    notifyListeners();
}

function useEngine(): PurgeEngineData {
    const [, setTick] = useState(0);
    useEffect(() => {
        const listener = () => setTick(t => t + 1);
        engineListeners.add(listener);
        return () => { engineListeners.delete(listener); };
    }, []);
    return engineData;
}

// #endregion

// #region API

const SEARCH_PAGE_SIZE = 25;

// Persists across engine resets within the session so re-running a purge doesn't
// re-fetch messages that were deleted but not yet evicted from Discord's search index.
const recentlyDeleted = new Set<string>();

async function searchMessages(
    channelId: string,
    guildId: string | null,
    authorId: string | null,
    content: string,
    hasLink: boolean,
    hasFile: boolean,
    hasEmbed: boolean,
    minId: string | null,
    maxId: string | null,
    channelIds: string[] | null,
    sortOrder: "asc" | "desc",
): Promise<SearchResponse> {
    const params = new URLSearchParams();
    if (authorId) params.set("author_id", authorId);
    params.set("sort_by", "timestamp");
    params.set("sort_order", sortOrder);
    params.set("offset", "0");
    params.set("include_nsfw", "true");

    if (content) params.set("content", content);
    if (hasLink) params.append("has", "link");
    if (hasFile) params.append("has", "file");
    if (hasEmbed) params.append("has", "embed");
    if (minId) params.set("min_id", minId);
    if (maxId) params.set("max_id", maxId);

    let baseUrl: string;
    if (guildId && channelIds?.length) {
        baseUrl = `/guilds/${guildId}/messages/search`;
        for (const cid of channelIds) params.append("channel_id", cid);
    } else {
        baseUrl = `/channels/${channelId}/messages/search`;
    }

    const res = await RestAPI.get({ url: `${baseUrl}?${params}` });
    (res.body as any).__headers = res.headers;
    return res.body;
}

async function searchMessagesGlobal(
    authorId: string | null,
    content: string,
    hasLink: boolean,
    hasFile: boolean,
    hasEmbed: boolean,
    minId: string | null,
    maxId: string | null,
    sortOrder: "asc" | "desc",
    cursor: SearchCursor | null,
): Promise<SearchResponse> {
    const tab: Record<string, unknown> = {
        sort_by: "timestamp",
        sort_order: sortOrder,
        limit: SEARCH_PAGE_SIZE,
    };

    if (cursor) tab.cursor = cursor;

    if (authorId) tab.author_id = [authorId];
    if (content) tab.content = content;

    const has: string[] = [];
    if (hasLink) has.push("link");
    if (hasFile) has.push("file");
    if (hasEmbed) has.push("embed");
    if (has.length) tab.has = has;

    if (minId) tab.min_id = minId;
    if (maxId) tab.max_id = maxId;

    const res = await RestAPI.post({
        url: "/users/@me/messages/search/tabs",
        body: { tabs: { messages: tab }, track_exact_total_hits: true },
    });

    const out = res.body.tabs.messages;
    (out as any).__headers = res.headers;
    return out;
}

async function doSearchGlobal(opts: PurgeOptions, cursor: SearchCursor | null, sortOrder: "asc" | "desc", searchDelayRef: { v: number }): Promise<SearchResponse | null> {
    const dateMinId = opts.afterDate ? dateToSnowflake(new Date(opts.afterDate)) : null;
    const dateMaxId = opts.beforeDate ? dateToSnowflake(new Date(opts.beforeDate)) : null;
    let retries = 0;

    while (true) {
        if (engineCancel) return null;
        try {
            const out = await searchMessagesGlobal(
                opts.authorId, opts.content, opts.hasLink, opts.hasFile, opts.hasEmbed,
                dateMinId, dateMaxId, sortOrder, cursor,
            );
            if (opts.autoRateLimit) searchDelayRef.v = rlWaitFromHeaders((out as any).__headers);
            return out;
        } catch (err: unknown) {
            const st = (err as { status?: number; }).status;
            const body = (err as { body?: { retry_after?: number; message?: string; }; }).body;

            if (st === 202) {
                const wait = (body?.retry_after ?? 3) * 1000;
                updateEngine({ status: `Discord is indexing messages, waiting ${(wait / 1000).toFixed(0)}s...` });
                await sleep(wait);
                continue;
            }
            if (st === 429) {
                const wait = ((body?.retry_after ?? 3) * 1000) + 500;
                searchDelayRef.v = Math.min(searchDelayRef.v + 500, 10000);
                updateEngine({ status: `Rate limited, cooling down ${(wait / 1000).toFixed(1)}s...` });
                await sleep(wait);
                continue;
            }
            retries++;
            if (retries >= 5) {
                const detail = body?.message ?? st ?? "unknown error";
                throw new Error(`Search failed after ${retries} retries: ${detail}`);
            }
            const wait = Math.min(2000 * retries, 10000);
            logger.warn(`Search error (attempt ${retries}/5, status ${st}), retrying in ${wait}ms`, err);
            updateEngine({ status: `Search error, retrying (${retries}/5)...` });
            await sleep(wait);
        }
    }
}

async function deleteMsg(channelId: string, messageId: string): Promise<any> {
    return RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` });
}

function rlWaitFromHeaders(headers: Record<string, string> | undefined): number {
    if (!headers) return 0;
    const remaining = Number(headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"] ?? "1");
    const resetAfter = Number(headers["x-ratelimit-reset-after"] ?? headers["X-RateLimit-Reset-After"] ?? "0");
    if (remaining <= 0 && resetAfter > 0) return Math.ceil(resetAfter * 1000) + 20;
    return 0;
}

async function fetchChannelMessages(channelId: string, before?: string): Promise<SearchMessage[]> {
    const params = new URLSearchParams({ limit: "100" });
    if (before) params.set("before", before);
    const res = await RestAPI.get({ url: `/channels/${channelId}/messages?${params}` });
    return res.body;
}

async function removeReaction(channelId: string, messageId: string, emoji: { id: string | null; name: string; }): Promise<any> {
    const encoded = emoji.id ? `${encodeURIComponent(emoji.name)}:${emoji.id}` : encodeURIComponent(emoji.name);
    return RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me` });
}

const PURGER_SIGNATURE = "\u200B\u200C\u200D\u2060";

async function blockUser(userId: string): Promise<void> {
    await RestAPI.put({ url: `/users/@me/relationships/${userId}`, body: { type: 2 } });
}

async function unaddUser(userId: string): Promise<void> {
    await RestAPI.del({ url: `/users/@me/relationships/${userId}` });
}

function getRecipientId(channelId: string): string | null {
    const ch = ChannelStore.getChannel(channelId);
    if (!ch) return null;
    return (ch as { recipients?: string[]; }).recipients?.[0] ?? null;
}

function dateToSnowflake(date: Date): string {
    return SnowflakeUtils.fromTimestamp(date.getTime());
}

function parseDate(input: string): Date | null {
    if (!input.trim()) return null;
    const d = new Date(input.trim());
    return isNaN(d.getTime()) ? null : d;
}

function getDmLabel(channelId: string): string {
    // Use names cached from search responses first (most reliable for global search)
    const cached = engineData.channelNames[channelId];
    if (cached) return cached;
    const ch = ChannelStore.getChannel(channelId);
    if (!ch) return `DM …${channelId.slice(-4)}`;
    if (ch.name) return ch.name;
    const recipientId = (ch as { recipients?: string[]; }).recipients?.[0];
    if (recipientId) {
        const user = UserStore.getUser(recipientId);
        if (user) return `@${user.username}`;
    }
    return `DM …${channelId.slice(-4)}`;
}

// #endregion

// #region Engine Runner

type DeleteOrder = "newest_first" | "oldest_first";

interface PurgeOptions {
    channelId: string;
    guildId: string | null;
    channelLabel: string;
    authorId: string | null;
    content: string;
    hasLink: boolean;
    hasFile: boolean;
    hasEmbed: boolean;
    includePinned: boolean;
    afterDate: string | null;
    beforeDate: string | null;
    channelIds: string[] | null;
    deleteDelay: number;
    searchDelay: number;
    autoRateLimit: boolean;
    deleteOrder: DeleteOrder;
    global: boolean;
    blacklistedChannels: string[];
    removeReactions: boolean;
    scanActivities: boolean;
    postBlock: boolean;
    postUnadd: boolean;
    postClose: boolean;
    leaveMessage: string;
    globalPostBlock: string[];
    globalPostUnadd: string[];
    globalPostClose: string[];
    globalLeaveMessages: Record<string, string>;
}

// cursorId: ID of the last message seen. Becomes max_id (desc) or min_id (asc) for the next request,
// giving us offset-free cursor pagination that avoids Discord's offset limit.
async function doSearch(opts: PurgeOptions, cursorId: string | null, sortOrder: "asc" | "desc", searchDelayRef: { v: number }): Promise<SearchResponse | null> {
    const dateMinId = opts.afterDate ? dateToSnowflake(new Date(opts.afterDate)) : null;
    const dateMaxId = opts.beforeDate ? dateToSnowflake(new Date(opts.beforeDate)) : null;

    const minId = sortOrder === "asc" ? (cursorId ?? dateMinId) : dateMinId;
    const maxId = sortOrder === "desc" ? (cursorId ?? dateMaxId) : dateMaxId;
    let retries = 0;

    while (true) {
        if (engineCancel) return null;
        try {
            const out = await searchMessages(
                opts.channelId, opts.guildId, opts.authorId,
                opts.content, opts.hasLink, opts.hasFile, opts.hasEmbed,
                minId, maxId, opts.channelIds, sortOrder,
            );
            if (opts.autoRateLimit) searchDelayRef.v = rlWaitFromHeaders((out as any).__headers);
            return out;
        } catch (err: unknown) {
            const st = (err as { status?: number; }).status;
            const body = (err as { body?: { retry_after?: number; message?: string; }; }).body;

            if (st === 202) {
                const wait = (body?.retry_after ?? 3) * 1000;
                updateEngine({ status: `Discord is indexing messages, waiting ${(wait / 1000).toFixed(0)}s...` });
                await sleep(wait);
                continue;
            }
            if (st === 429) {
                const wait = ((body?.retry_after ?? 3) * 1000) + 500;
                searchDelayRef.v = Math.min(searchDelayRef.v + 500, 10000);
                updateEngine({ status: `Rate limited, cooling down ${(wait / 1000).toFixed(1)}s...` });
                await sleep(wait);
                continue;
            }
            retries++;
            if (retries >= 5) {
                const detail = body?.message ?? st ?? "unknown error";
                throw new Error(`Search failed after ${retries} retries: ${detail}`);
            }
            const wait = Math.min(2000 * retries, 10000);
            logger.warn(`Search error (attempt ${retries}/5, status ${st}), retrying in ${wait}ms`, err);
            updateEngine({ status: `Search error, retrying (${retries}/5)...` });
            await sleep(wait);
        }
    }
}

async function runPurge(opts: PurgeOptions) {
    if (engineData.state !== "idle") return;

    engineCancel = false;
    const searchDelayRef = { v: opts.searchDelay };
    const sortOrder: "asc" | "desc" = opts.deleteOrder === "oldest_first" ? "asc" : "desc";

    updateEngine({
        ...createFreshEngine(),
        state: "fetching",
        status: "Contacting Discord search...",
        channelId: opts.channelId,
        channelLabel: opts.channelLabel,
        startTime: Date.now(),
    });

    // --- Phase 1: fetch all pages before deleting anything ---
    const seenIds = new Set<string>();
    let errorMsg: string | null = null;

    function processHits(hits: SearchMessage[]) {
        const meaningful = hits.filter(m => {
            if (m.type === 3) return false;
            if (m.content?.includes(PURGER_SIGNATURE)) return false;
            if (!(m.content || m.attachments?.length || m.embeds?.length || m.message_reference || m.activity)) return false;
            return true;
        });
        if (!meaningful.length) return;
        const deletable: SearchMessage[] = [];
        const skipped: SearchMessage[] = [];
        for (const msg of meaningful) {
            if (msg.pinned && !opts.includePinned) {
                skipped.push(msg);
            } else {
                deletable.push(msg);
            }
        }
        if (skipped.length) addToPreview(skipped, "skipped");
        if (deletable.length) addToPreview(deletable, "pending");
        const byChannel = { ...engineData.fetchedByChannel };
        for (const msg of meaningful) byChannel[msg.channel_id] = (byChannel[msg.channel_id] ?? 0) + 1;
        updateEngine({ fetchedByChannel: byChannel });
    }

    try {
        if (opts.global) {
            // Global DM search using the cross-DM endpoint (finds messages in closed DMs too).
            // Discord uses cursor-based pagination: the first request returns a cursor but no
            // messages, subsequent requests pass the cursor to receive actual results.
            let pageCursor: SearchCursor | null = null;
            let isFirstPage = true;

            while (!engineCancel) {
                while (engineData.paused && !engineCancel) {
                    updateEngine({ status: "Paused." });
                    await sleep(500);
                }
                if (engineCancel) break;

                const globalOpts = opts.authorId ? opts : { ...opts, authorId: UserStore.getCurrentUser()?.id ?? null };
                const searchData = await doSearchGlobal(globalOpts, pageCursor, sortOrder, searchDelayRef);
                if (!searchData) break;

                if (isFirstPage) {
                    isFirstPage = false;
                    if (searchData.total_results === 0) {
                        updateEngine({ status: "No messages found." });
                        break;
                    }
                    updateEngine({ totalFound: searchData.total_results });
                }

                pageCursor = searchData.cursor ?? null;

                const pageGroups = searchData.messages ?? [];

                // First response may return a cursor but no messages; use the cursor to continue
                if (!pageGroups.length) {
                    if (pageCursor) {
                        await sleep(searchDelayRef.v);
                        continue;
                    }
                    break;
                }

                // Cache channel names from the response (needed for closed DMs not in ChannelStore)
                if (searchData.channels) {
                    const channelNames = { ...engineData.channelNames };
                    for (const ch of searchData.channels) {
                        if (!channelNames[ch.id]) {
                            const recipient = ch.recipients?.[0];
                            channelNames[ch.id] = recipient
                                ? `@${recipient.global_name ?? recipient.username}`
                                : (ch.name ?? `DM …${ch.id.slice(-4)}`);
                        }
                    }
                    updateEngine({ channelNames });
                }

                const allHits = pageGroups
                    .map(g => g.find(m => m.hit))
                    .filter((m): m is SearchMessage => m != null && !seenIds.has(m.id));

                for (const m of allHits) seenIds.add(m.id);

                const hits = allHits.filter(m =>
                    !opts.blacklistedChannels.includes(m.channel_id) &&
                    !recentlyDeleted.has(m.id)
                );

                processHits(hits);
                updateEngine({
                    fetched: engineData.preview.length,
                    status: `Fetched ${engineData.preview.length} / ${engineData.totalFound} messages...`,
                });

                if (!pageCursor) break;
                await sleep(searchDelayRef.v);
            }
        } else {
            let cursorId: string | null = null;
            let isFirstPage = true;
            let useDirectFetch = false;

            while (!engineCancel) {
                while (engineData.paused && !engineCancel) {
                    updateEngine({ status: "Paused." });
                    await sleep(500);
                }
                if (engineCancel) break;

                const searchData = await doSearch(opts, cursorId, sortOrder, searchDelayRef);
                if (!searchData) break;

                if (isFirstPage) {
                    isFirstPage = false;
                    if (searchData.total_results === 0) {
                        if (!opts.guildId) {
                            useDirectFetch = true;
                            break;
                        }
                        updateEngine({ totalFound: 0, status: "No messages found." });
                        break;
                    }
                    updateEngine({ totalFound: searchData.total_results });
                }

                const pageGroups = searchData.messages ?? [];
                if (!pageGroups.length) {
                    if (!opts.guildId) {
                        useDirectFetch = true;
                    }
                    break;
                }

                const allHits = pageGroups
                    .map(g => g.find(m => m.hit))
                    .filter((m): m is SearchMessage => m != null && !seenIds.has(m.id));

                if (!allHits.length) break;

                for (const m of allHits) seenIds.add(m.id);
                cursorId = allHits[allHits.length - 1].id;

                const hits = allHits.filter(m =>
                    (!opts.authorId || m.author.id === opts.authorId) &&
                    !recentlyDeleted.has(m.id)
                );

                processHits(hits);
                updateEngine({
                    fetched: seenIds.size,
                    status: `Fetched ${seenIds.size} / ${searchData.total_results} messages...`,
                });

                if (pageGroups.length < SEARCH_PAGE_SIZE) break;
                await sleep(searchDelayRef.v);
            }

            if (useDirectFetch && !engineCancel) {
                updateEngine({ status: "Search index unavailable, fetching messages directly..." });
                let before: string | undefined;
                const dateMinId = opts.afterDate ? dateToSnowflake(new Date(opts.afterDate)) : null;
                const dateMaxId = opts.beforeDate ? dateToSnowflake(new Date(opts.beforeDate)) : null;

                while (!engineCancel) {
                    while (engineData.paused && !engineCancel) {
                        updateEngine({ status: "Paused." });
                        await sleep(500);
                    }
                    if (engineCancel) break;

                    const msgs = await fetchChannelMessages(opts.channelId, before);
                    if (!msgs.length) break;

                    const filtered = msgs.filter(m => {
                        if (seenIds.has(m.id) || recentlyDeleted.has(m.id)) return false;
                        if (opts.authorId && m.author.id !== opts.authorId) return false;
                        if (dateMinId && m.id < dateMinId) return false;
                        if (dateMaxId && m.id > dateMaxId) return false;
                        return true;
                    });

                    for (const m of filtered) seenIds.add(m.id);
                    processHits(filtered);
                    updateEngine({
                        fetched: seenIds.size,
                        status: `Fetched ${engineData.preview.length} messages...`,
                    });

                    before = msgs[msgs.length - 1].id;
                    if (dateMinId && msgs[msgs.length - 1].id < dateMinId) break;
                    if (msgs.length < 100) break;
                    await sleep(searchDelayRef.v);
                }
            }
        }
    } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        logger.error("Fetch phase error", err);
        updateEngine({ status: `Error: ${errorMsg}` });
    }

    if (engineCancel) {
        updateEngine({ state: "stopped", paused: false, status: "Stopped." });
        return;
    }

    if (errorMsg) {
        updateEngine({ state: "stopped", status: `Fetch failed: ${errorMsg}` });
        return;
    }

    // --- Phase 1b: scan for reactions (requires full channel read) ---
    if (opts.removeReactions && !engineCancel) {
        if (!opts.global) {
            updateEngine({ status: "Scanning for reactions..." });
            let before: string | undefined;
            try {
                while (!engineCancel) {
                    while (engineData.paused && !engineCancel) {
                        updateEngine({ status: "Paused." });
                        await sleep(500);
                    }
                    if (engineCancel) break;

                    const msgs = await fetchChannelMessages(opts.channelId, before);
                    if (!msgs.length) break;

                    const reactEntries: PreviewEntry[] = [];
                    for (const msg of msgs) {
                        if (seenIds.has(msg.id)) continue;
                        const myReactions = msg.reactions?.filter(r => r.me);
                        if (myReactions?.length) {
                            seenIds.add(msg.id);
                            reactEntries.push({
                                msg,
                                status: "pending",
                                reactEmojis: myReactions.map(r => r.emoji),
                            });
                        }
                    }

                    if (reactEntries.length) {
                        engineData.preview = [...engineData.preview, ...reactEntries];
                        notifyListeners();
                    }

                    before = msgs[msgs.length - 1].id;
                    const reactCount = engineData.preview.filter(e => e.reactEmojis).length;
                    updateEngine({ status: `Scanning for reactions... ${reactCount} messages found` });

                    if (msgs.length < 100) break;
                    await sleep(searchDelayRef.v);
                }
            } catch (err) {
                logger.error("Reaction scan error", err);
            }
        } else {
            const dmIds: string[] = PrivateChannelSortStore.getPrivateChannelIds?.() ?? [];
            const channelIds = dmIds.filter(id => !opts.blacklistedChannels.includes(id));
            let scanned = 0;

            for (const chId of channelIds) {
                if (engineCancel) break;
                scanned++;
                updateEngine({ status: `Scanning DM ${scanned}/${channelIds.length} for reactions...` });

                let before: string | undefined;
                try {
                    while (!engineCancel) {
                        while (engineData.paused && !engineCancel) {
                            updateEngine({ status: "Paused." });
                            await sleep(500);
                        }
                        if (engineCancel) break;

                        const msgs = await fetchChannelMessages(chId, before);
                        if (!msgs.length) break;

                        const reactEntries: PreviewEntry[] = [];
                        for (const msg of msgs) {
                            if (seenIds.has(msg.id)) continue;
                            const myReactions = msg.reactions?.filter(r => r.me);
                            if (myReactions?.length) {
                                seenIds.add(msg.id);
                                reactEntries.push({
                                    msg: { ...msg, channel_id: chId },
                                    status: "pending",
                                    reactEmojis: myReactions.map(r => r.emoji),
                                });
                            }
                        }

                        if (reactEntries.length) {
                            engineData.preview = [...engineData.preview, ...reactEntries];
                            notifyListeners();
                        }

                        before = msgs[msgs.length - 1].id;
                        if (msgs.length < 100) break;
                        await sleep(searchDelayRef.v);
                    }
                } catch {
                    logger.warn(`Reaction scan failed for channel ${chId}, skipping`);
                }
            }

            const reactCount = engineData.preview.filter(e => e.reactEmojis).length;
            if (reactCount) updateEngine({ status: `Found ${reactCount} messages with reactions across ${scanned} DMs` });
        }
    }

    if (engineCancel) {
        updateEngine({ state: "stopped", paused: false, status: "Stopped." });
        return;
    }

    // --- Phase 1c: scan for activity/system messages not indexed by search ---
    if (opts.scanActivities && !engineCancel) {
        const currentUserId = UserStore.getCurrentUser()?.id;

        async function scanChannelForActivities(chId: string) {
            let before: string | undefined;
            try {
                while (!engineCancel) {
                    while (engineData.paused && !engineCancel) {
                        updateEngine({ status: "Paused." });
                        await sleep(500);
                    }
                    if (engineCancel) break;

                    const msgs = await fetchChannelMessages(chId, before);
                    if (!msgs.length) break;

                    const activityMsgs: SearchMessage[] = [];
                    for (const msg of msgs) {
                        if (seenIds.has(msg.id) || recentlyDeleted.has(msg.id)) continue;
                        if (msg.type === 3) continue;
                        if (msg.content?.includes(PURGER_SIGNATURE)) continue;
                        if (msg.type === 20 || msg.activity) {
                            seenIds.add(msg.id);
                            activityMsgs.push({ ...msg, channel_id: chId });
                        }
                    }

                    if (activityMsgs.length) addToPreview(activityMsgs, "pending");

                    before = msgs[msgs.length - 1].id;
                    if (msgs.length < 100) break;
                    await sleep(searchDelayRef.v);
                }
            } catch (err) {
                logger.warn(`Activity scan failed for channel ${chId}`, err);
            }
        }

        if (opts.global) {
            const dmIds: string[] = PrivateChannelSortStore.getPrivateChannelIds?.() ?? [];
            const channelIds = dmIds.filter(id => !opts.blacklistedChannels.includes(id));
            let scanned = 0;

            for (const chId of channelIds) {
                if (engineCancel) break;
                scanned++;
                updateEngine({ status: `Scanning DM ${scanned}/${channelIds.length} for activities...` });
                await scanChannelForActivities(chId);
            }
        } else if (!opts.guildId) {
            updateEngine({ status: "Scanning for activity messages..." });
            await scanChannelForActivities(opts.channelId);
        }

        const activityCount = engineData.preview.filter(e => !e.reactEmojis && e.msg.type === 20).length;
        if (activityCount) updateEngine({ status: `Found ${activityCount} activity messages` });
    }

    if (engineCancel) {
        updateEngine({ state: "stopped", paused: false, status: "Stopped." });
        return;
    }

    // --- Phase 2: delete messages and remove reactions ---
    const pending = engineData.preview.filter(e => e.status === "pending");
    const skippedCount = engineData.preview.filter(e => e.status === "skipped").length;

    if (!pending.length) {
        updateEngine({
            state: "done",
            skipped: skippedCount,
            status: skippedCount > 0
                ? `Nothing to delete. ${skippedCount} pinned or non-deletable messages were skipped.`
                : "No messages found.",
        });
        return;
    }

    let totalDeleted = 0;
    let totalFailed = 0;
    let deleteDelay = opts.deleteDelay;

    updateEngine({
        state: "running",
        skipped: skippedCount,
        toDelete: pending.length,
        status: `Starting deletion of ${pending.length} messages...`,
        startTime: Date.now(),
    });

    for (const entry of pending) {
        if (engineCancel) break;

        while (engineData.paused && !engineCancel) {
            updateEngine({ status: "Paused." });
            await sleep(500);
        }
        if (engineCancel) break;

        const msg = entry.msg;
        const isReaction = !!entry.reactEmojis?.length;

        updatePreviewStatus(msg.id, "deleting");
        updateEngine({
            status: isReaction
                ? `Removing reactions from message by @${msg.author.username}...`
                : `Deleting message from @${msg.author.username}...`,
        });

        let success = false;

        let nextWait = opts.autoRateLimit ? 0 : deleteDelay;

        if (isReaction) {
            success = true;
            for (const emoji of entry.reactEmojis!) {
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        const res = await removeReaction(msg.channel_id, msg.id, emoji);
                        if (opts.autoRateLimit) nextWait = rlWaitFromHeaders(res?.headers);
                        break;
                    } catch (err: unknown) {
                        const errSt = (err as { status?: number; }).status;
                        const errBody = (err as { body?: { retry_after?: number; }; }).body;
                        if (errSt === 429) {
                            const wait = ((errBody?.retry_after ?? 2) * 1000) + 500;
                            if (!opts.autoRateLimit) deleteDelay = Math.min(deleteDelay + 500, 5000);
                            updateEngine({ status: `Rate limited, cooling down ${(wait / 1000).toFixed(1)}s...` });
                            await sleep(wait);
                            continue;
                        }
                        if (errSt === 404) break;
                        success = false;
                        break;
                    }
                }
                if (!success) break;
                if (opts.autoRateLimit) {
                    if (nextWait > 0) await sleep(nextWait);
                } else {
                    await sleep(Math.max(Math.floor(deleteDelay / 3), 200));
                }
            }
        } else {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const res = await deleteMsg(msg.channel_id, msg.id);
                    if (opts.autoRateLimit) nextWait = rlWaitFromHeaders(res?.headers);
                    success = true;
                    break;
                } catch (err: unknown) {
                    const errSt = (err as { status?: number; }).status;
                    const errBody = (err as { body?: { retry_after?: number; code?: number; }; }).body;

                    if (errSt === 429) {
                        const wait = ((errBody?.retry_after ?? 2) * 1000) + 500;
                        if (!opts.autoRateLimit) deleteDelay = Math.min(deleteDelay + 500, 5000);
                        updateEngine({ status: `Rate limited on delete, waiting ${(wait / 1000).toFixed(1)}s...` });
                        await sleep(wait);
                        continue;
                    }
                    if (errSt === 403 || errSt === 404) break;
                    logger.error("Delete failed", err);
                    break;
                }
            }
        }

        if (success) {
            totalDeleted++;
            recentlyDeleted.add(msg.id);
            updateEngine({ deleted: totalDeleted });
            updatePreviewStatus(msg.id, "deleted");
        } else {
            totalFailed++;
            updateEngine({ failed: totalFailed });
            updatePreviewStatus(msg.id, "failed");
        }

        if (opts.autoRateLimit) {
            if (nextWait > 0) await sleep(nextWait);
        } else {
            await sleep(deleteDelay);
        }
    }

    // --- Phase 3: post-purge actions ---
    if (!engineCancel) {
        const processedChannels = new Set(engineData.preview.map(e => e.msg.channel_id));

        if (opts.global) {
            for (const chId of processedChannels) {
                const recipientId = getRecipientId(chId);
                const leaveMsg = opts.globalLeaveMessages[chId];
                if (leaveMsg) {
                    try {
                        updateEngine({ status: `Sending message in ${getDmLabel(chId)}...` });
                        await sendMessage(chId, { content: leaveMsg + PURGER_SIGNATURE });
                        await sleep(500);
                    } catch (err) {
                        logger.warn(`Failed to send leave message in ${chId}`, err);
                    }
                }
                if (recipientId && opts.globalPostBlock.includes(chId)) {
                    try {
                        updateEngine({ status: `Blocking ${getDmLabel(chId)}...` });
                        await blockUser(recipientId);
                        await sleep(500);
                    } catch (err) {
                        logger.warn(`Failed to block user in ${chId}`, err);
                    }
                }
                if (recipientId && opts.globalPostUnadd.includes(chId)) {
                    try {
                        updateEngine({ status: `Removing ${getDmLabel(chId)}...` });
                        await unaddUser(recipientId);
                        await sleep(500);
                    } catch (err) {
                        logger.warn(`Failed to unadd user in ${chId}`, err);
                    }
                }
                if (opts.globalPostClose.includes(chId)) {
                    try {
                        updateEngine({ status: `Closing ${getDmLabel(chId)}...` });
                        await ChannelActionCreators.closePrivateChannel(chId);
                        await sleep(300);
                    } catch (err) {
                        logger.warn(`Failed to close DM ${chId}`, err);
                    }
                }
            }
        } else if (!opts.guildId) {
            const recipientId = getRecipientId(opts.channelId);
            if (opts.leaveMessage) {
                try {
                    updateEngine({ status: "Sending leave-behind message..." });
                    await sendMessage(opts.channelId, { content: opts.leaveMessage + PURGER_SIGNATURE });
                    await sleep(500);
                } catch (err) {
                    logger.warn("Failed to send leave message", err);
                }
            }
            if (recipientId && opts.postBlock) {
                try {
                    updateEngine({ status: "Blocking user..." });
                    await blockUser(recipientId);
                    await sleep(500);
                } catch (err) {
                    logger.warn("Failed to block user", err);
                }
            }
            if (recipientId && opts.postUnadd) {
                try {
                    updateEngine({ status: "Removing friend..." });
                    await unaddUser(recipientId);
                    await sleep(500);
                } catch (err) {
                    logger.warn("Failed to unadd user", err);
                }
            }
            if (opts.postClose) {
                try {
                    updateEngine({ status: "Closing DM..." });
                    await ChannelActionCreators.closePrivateChannel(opts.channelId);
                    await sleep(300);
                } catch (err) {
                    logger.warn("Failed to close DM", err);
                }
            }
        }
    }

    const finalState = engineCancel ? "stopped" : "done";
    updateEngine({
        state: finalState,
        paused: false,
        status: finalState === "done"
            ? `Done. Processed ${totalDeleted} messages.`
            : `Stopped. Processed ${totalDeleted} messages.`,
    });
}

function stopPurge() {
    engineCancel = true;
    updateEngine({ status: "Stopping...", paused: false });
}

function pausePurge() {
    updateEngine({ paused: true });
}

function resumePurge() {
    updateEngine({ paused: false });
}

function resetEngine() {
    engineCancel = true;
    engineData = createFreshEngine();
    notifyListeners();
}

// #endregion

// #region Chatbar Icon

function TrashIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M6 7h12l-1.2 12.6a2 2 0 0 1-2 1.8H9.2a2 2 0 0 1-2-1.8L6 7Z" fill="var(--status-danger)" opacity="0.85" />
            <path d="M4 7h16M10 11v6M14 11v6M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="var(--status-danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function TrashIconSettings() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24">
            <path d="M6 7h12l-1.2 12.6a2 2 0 0 1-2 1.8H9.2a2 2 0 0 1-2-1.8L6 7Z" fill="currentColor" opacity="0.85" />
            <path d="M4 7h16M10 11v6M14 11v6M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
    );
}

const PurgerChatBarButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    if (!isMainChat) return null;
    return (
        <ChatBarButton tooltip="Purge Messages" onClick={() => openPurgeModal(channel)}>
            <TrashIcon />
        </ChatBarButton>
    );
};

function openPurgeModal(channel: Channel) {
    openModal(modalProps => <PurgeModal modalProps={modalProps} channel={channel} />);
}

// #endregion

// #region Preview Row

function MessagePreviewRow({ entry }: { entry: PreviewEntry; }) {
    const { msg, status, reactEmojis } = entry;
    const isReaction = !!reactEmojis?.length;
    const avatarUrl = IconUtils.getUserAvatarURL(msg.author as never) ?? IconUtils.getDefaultAvatarURL(msg.author.id);

    const statusCls = status === "deleted" ? cl("message-deleted")
        : status === "deleting" ? cl("message-deleting")
            : status === "skipped" ? cl("message-skipped")
                : status === "failed" ? cl("message-failed")
                    : "";

    const contentText = isReaction
        ? `[${reactEmojis.map(e => e.name).join(", ")}] on: ${msg.content || "[message]"}`
        : (msg.content || (msg.attachments?.length ? `[${msg.attachments.length} attachment${msg.attachments.length > 1 ? "s" : ""}]` : (msg.embeds?.length ? "[embed]" : (msg.message_reference ? "[forwarded message]" : "[activity/system message]"))));

    const statusLabel = isReaction
        ? (status === "deleted" ? "Unreacted"
            : status === "failed" ? "Failed"
                : status === "deleting" ? "Removing..."
                    : "Reaction")
        : (status === "deleted" ? "Deleted"
            : status === "failed" ? "Failed"
                : status === "deleting" ? "Deleting..."
                    : status === "skipped" ? "Skipped"
                        : null);

    const statusColor = status === "deleted" ? "text-feedback-positive" as const
        : status === "failed" ? "text-danger" as const
            : status === "deleting" ? "text-feedback-warning" as const
                : "text-muted" as const;

    return (
        <div className={classes(cl("message"), statusCls)}>
            <img className={cl("message-avatar")} src={avatarUrl} alt="" />
            <div className={cl("message-body")}>
                <div className={cl("message-header")}>
                    <Span size="xs" weight="semibold">{msg.author.username}</Span>
                    <span className={cl("message-time")}>
                        <Timestamp timestamp={new Date(msg.timestamp)} />
                    </span>
                </div>
                <Paragraph size="xs" color="text-muted" className={cl("message-content")}>
                    {contentText}
                </Paragraph>
            </div>
            {statusLabel && (
                <Span size="xs" color={statusColor} className={cl("message-status")}>
                    {statusLabel}
                </Span>
            )}
        </div>
    );
}

// #endregion

// #region Controls Panel

interface GlobalState {
    blacklistedChannels: string[];
    setBlacklistedChannels: (v: string[]) => void;
    globalPostBlock: string[];
    setGlobalPostBlock: (v: string[]) => void;
    globalPostUnadd: string[];
    setGlobalPostUnadd: (v: string[]) => void;
    globalPostClose: string[];
    setGlobalPostClose: (v: string[]) => void;
    globalLeaveMessages: Record<string, string>;
    setGlobalLeaveMessages: (v: Record<string, string>) => void;
}

interface ControlsPanelProps {
    channel: Channel;
    globalMode: boolean;
    optsRef: React.MutableRefObject<PurgeOptions | null>;
    globalState: GlobalState;
}

function ControlsPanel({ channel, globalMode, optsRef, globalState }: ControlsPanelProps) {
    const [onlyOwn, setOnlyOwn] = useState(true);
    const [includePinned, setIncludePinned] = useState(false);
    const [contentFilter, setContentFilter] = useState("");
    const [hasLink, setHasLink] = useState(false);
    const [hasFile, setHasFile] = useState(false);
    const [hasEmbed, setHasEmbed] = useState(false);
    const [afterDate, setAfterDate] = useState("");
    const [beforeDate, setBeforeDate] = useState("");
    const [deleteDelay, setDeleteDelay] = useState(settings.store.deleteDelay);
    const [searchDelay, setSearchDelay] = useState(settings.store.searchDelay);
    const [autoRateLimit, setAutoRateLimit] = useState(settings.store.autoRateLimit);
    const [deleteOrder, setDeleteOrder] = useState<DeleteOrder>("newest_first");
    const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
    const [removeReactions, setRemoveReactions] = useState(false);
    const [scanActivities, setScanActivities] = useState(false);
    const [postBlock, setPostBlock] = useState(false);
    const [postUnadd, setPostUnadd] = useState(false);
    const [postClose, setPostClose] = useState(false);
    const [leaveMessage, setLeaveMessage] = useState("");

    const { blacklistedChannels, globalPostBlock, globalPostUnadd, globalPostClose, globalLeaveMessages } = globalState;

    const currentUserId = UserStore.getCurrentUser()?.id;
    const isGuild = !globalMode && !!channel.guild_id;
    const channelLabel = globalMode ? "All DMs" : (channel.name ? `#${channel.name}` : `DM ${channel.id}`);
    const channelOptions = useGuildChannels(isGuild ? channel.guild_id : null);

    const afterParsed = parseDate(afterDate);
    const beforeParsed = parseDate(beforeDate);

    optsRef.current = {
        channelId: globalMode ? "" : channel.id,
        guildId: globalMode ? null : (channel.guild_id ?? null),
        channelLabel,
        authorId: onlyOwn ? (currentUserId ?? null) : null,
        content: contentFilter.trim(),
        hasLink,
        hasFile,
        hasEmbed,
        includePinned,
        afterDate: afterParsed?.toISOString() ?? null,
        beforeDate: beforeParsed?.toISOString() ?? null,
        channelIds: isGuild && selectedChannels.length ? selectedChannels : null,
        deleteDelay,
        searchDelay,
        autoRateLimit,
        deleteOrder,
        global: globalMode,
        blacklistedChannels,
        removeReactions: !isGuild && removeReactions,
        scanActivities: !isGuild && scanActivities,
        postBlock: !isGuild && !globalMode && postBlock,
        postUnadd: !isGuild && !globalMode && postUnadd,
        postClose: !isGuild && !globalMode && postClose,
        leaveMessage: !isGuild && !globalMode ? leaveMessage.trim() : "",
        globalPostBlock: globalMode ? globalPostBlock : [],
        globalPostUnadd: globalMode ? globalPostUnadd : [],
        globalPostClose: globalMode ? globalPostClose : [],
        globalLeaveMessages: globalMode ? globalLeaveMessages : {},
    };

    const filtersBlock = (
        <>
            <div className={cl("section-label")}>
                <Span size="sm" weight="bold" color="text-muted">FILTERS</Span>
            </div>

            <FormSwitch
                title="My messages only"
                description="Only delete messages you sent"
                value={onlyOwn}
                onChange={setOnlyOwn}
                hideBorder
            />

            <FormSwitch
                title="Include pinned"
                description="Delete pinned messages too"
                value={includePinned}
                onChange={setIncludePinned}
                hideBorder
            />

            {!isGuild && (
                <FormSwitch
                    title="Remove my reactions"
                    description="Also scan for and remove all your reactions"
                    value={removeReactions}
                    onChange={setRemoveReactions}
                    hideBorder
                />
            )}

            {!isGuild && (
                <FormSwitch
                    title="Scan for activities"
                    description="Find slash command outputs and other activities not indexed by search"
                    value={scanActivities}
                    onChange={setScanActivities}
                    hideBorder
                />
            )}

            <div className={cl("section")}>
                <Span size="xs" color="text-muted">Contains text</Span>
                <TextInput
                    placeholder="Server-side content filter"
                    value={contentFilter}
                    onChange={setContentFilter}
                />
            </div>

            <FormSwitch title="Has link" description="Only messages containing links" value={hasLink} onChange={setHasLink} hideBorder />
            <FormSwitch title="Has file" description="Only messages with attachments" value={hasFile} onChange={setHasFile} hideBorder />
            <FormSwitch title="Has embed" description="Only messages with embeds or activities" value={hasEmbed} onChange={setHasEmbed} hideBorder />

            <Divider />

            <div className={cl("section-label")}>
                <Span size="sm" weight="bold" color="text-muted">DATE RANGE</Span>
            </div>

            <div className={cl("row")}>
                <div className={cl("section")}>
                    <Span size="xs" color={!afterDate || afterParsed ? "text-muted" : "text-danger"}>After (YYYY-MM-DD)</Span>
                    <TextInput placeholder="2024-01-01" value={afterDate} onChange={setAfterDate} />
                </div>
                <div className={cl("section")}>
                    <Span size="xs" color={!beforeDate || beforeParsed ? "text-muted" : "text-danger"}>Before (YYYY-MM-DD)</Span>
                    <TextInput placeholder="2026-12-31" value={beforeDate} onChange={setBeforeDate} />
                </div>
            </div>
        </>
    );

    const afterPurgeBlock = !isGuild && !globalMode ? (
        <>
            <div className={cl("section-label")}>
                <Span size="sm" weight="bold" color="text-muted">AFTER PURGE</Span>
            </div>

            <FormSwitch
                title="Block user"
                description="Block the user after purging"
                value={postBlock}
                onChange={setPostBlock}
                hideBorder
            />

            <FormSwitch
                title="Remove friend"
                description="Remove the user as a friend after purging"
                value={postUnadd}
                onChange={setPostUnadd}
                hideBorder
            />

            <FormSwitch
                title="Close DM"
                description="Close the DM after purging"
                value={postClose}
                onChange={setPostClose}
                hideBorder
            />

            <div className={cl("section")}>
                <Span size="xs" color="text-muted">Leave a message behind</Span>
                <TextInput
                    placeholder="This message will survive future purges"
                    value={leaveMessage}
                    onChange={setLeaveMessage}
                />
            </div>
        </>
    ) : null;

    const guildChannelsBlock = isGuild ? (
        <>
            <Divider />
            <div className={cl("section-label")}>
                <Span size="sm" weight="bold" color="text-muted">CHANNELS</Span>
            </div>
            <Span size="xs" color="text-muted">
                Leave empty to search only the current channel
            </Span>
            <div className={cl("row")} style={{ gap: 8, flexWrap: "wrap" }}>
                <Button variant="secondary" size="small" onClick={() => setSelectedChannels(channelOptions.map(c => c.id))}>
                    Select all channels
                </Button>
                {selectedChannels.length > 0 && (
                    <Button variant="secondary" size="small" onClick={() => setSelectedChannels([])}>
                        Clear
                    </Button>
                )}
            </div>
            <ManaSelect
                options={channelOptions}
                value={selectedChannels}
                onSelectionChange={(v: string | string[] | null) =>
                    setSelectedChannels(Array.isArray(v) ? v : v ? [v] : [])
                }
                selectionMode="multiple"
                placeholder="Select channels..."
                clearable
                fullWidth
                wrapTags
                maxOptionsVisible={8}
            />
        </>
    ) : null;

    const timingBlock = (
        <>
            <div className={cl("section-label")}>
                <Span size="sm" weight="bold" color="text-muted">ORDER & TIMING</Span>
            </div>

            <div className={cl("section")}>
                <Span size="xs" color="text-muted">Delete order</Span>
                <Select
                    options={[
                        { label: "Newest first", value: "newest_first" },
                        { label: "Oldest first", value: "oldest_first" },
                    ]}
                    select={v => setDeleteOrder(v as DeleteOrder)}
                    isSelected={v => v === deleteOrder}
                    serialize={String}
                    placeholder="Order"
                />
            </div>

            <FormSwitch
                title="Auto rate limit"
                description="Read Discord's X-RateLimit headers and pace requests at the maximum legal speed."
                value={autoRateLimit}
                onChange={v => { setAutoRateLimit(v); settings.store.autoRateLimit = v; }}
                hideBorder
            />

            {!autoRateLimit && (
                <>
                    <div className={cl("section")}>
                        <Span size="xs" color="text-muted">Delete delay: {deleteDelay}ms</Span>
                        <Slider
                            initialValue={deleteDelay}
                            minValue={250}
                            maxValue={3000}
                            markers={[250, 500, 750, 1000, 1250, 1500, 2000, 3000]}
                            onValueChange={v => setDeleteDelay(Math.round(v))}
                            onValueRender={v => `${Math.round(v)}ms`}
                        />
                    </div>

                    <div className={cl("section")}>
                        <Span size="xs" color="text-muted">Search delay: {searchDelay}ms</Span>
                        <Slider
                            initialValue={searchDelay}
                            minValue={500}
                            maxValue={3000}
                            markers={[500, 750, 1000, 1500, 2000, 3000]}
                            onValueChange={v => setSearchDelay(Math.round(v))}
                            onValueRender={v => `${Math.round(v)}ms`}
                        />
                    </div>
                </>
            )}
        </>
    );

    if (!isGuild && !globalMode) {
        return (
            <div className={cl("two-col")}>
                <div className={cl("two-col-left")}>
                    {filtersBlock}
                </div>
                <div className={cl("two-col-right")}>
                    {afterPurgeBlock}
                    <Divider />
                    {timingBlock}
                </div>
            </div>
        );
    }

    return (
        <>
            {filtersBlock}
            {guildChannelsBlock}
            <Divider />
            {timingBlock}
        </>
    );
}

interface DmChannelEntry {
    id: string;
    displayName: string;
    username: string;
    avatarUrl: string;
}

function useAllDmChannels(): DmChannelEntry[] {
    return useCallback(() => {
        try {
            const ids: string[] = PrivateChannelSortStore.getPrivateChannelIds?.() ?? [];
            return ids.map(id => {
                const ch = ChannelStore.getChannel(id);
                if (!ch) return null;
                const recipientId = (ch as { recipients?: string[]; }).recipients?.[0];
                if (recipientId) {
                    const user = UserStore.getUser(recipientId);
                    const avatarUrl = user
                        ? (IconUtils.getUserAvatarURL(user as never) ?? IconUtils.getDefaultAvatarURL(recipientId))
                        : IconUtils.getDefaultAvatarURL(recipientId);
                    return {
                        id,
                        displayName: user?.globalName ?? user?.username ?? `DM …${id.slice(-4)}`,
                        username: user?.username ?? "",
                        avatarUrl,
                    };
                }
                if (ch.name) return { id, displayName: ch.name, username: "", avatarUrl: IconUtils.getDefaultAvatarURL(id) };
                return null;
            }).filter((x): x is DmChannelEntry => x != null);
        } catch {
            return [];
        }
    }, [])();
}

function DmChannelPicker({ blacklisted, onChange }: { blacklisted: string[]; onChange: (ids: string[]) => void; }) {
    const channels = useAllDmChannels();
    const [search, setSearch] = useState("");

    const filtered = search.trim()
        ? channels.filter(ch => {
            const q = search.toLowerCase();
            return ch.displayName.toLowerCase().includes(q) || ch.username.toLowerCase().includes(q);
        })
        : channels;

    const toggle = (id: string) => {
        if (blacklisted.includes(id)) {
            onChange(blacklisted.filter(x => x !== id));
        } else {
            onChange([...blacklisted, id]);
        }
    };

    if (!channels.length) return (
        <Span size="xs" color="text-muted">No DMs found.</Span>
    );

    return (
        <div className={cl("dm-picker-wrap")}>
            <div className={cl("dm-picker-search")}>
                <TextInput
                    placeholder="Search..."
                    value={search}
                    onChange={setSearch}
                />
            </div>
            <ScrollerThin className={cl("dm-picker")}>
                {filtered.length === 0
                    ? <div className={cl("dm-pick-row")}><Span size="xs" color="text-muted">No results.</Span></div>
                    : filtered.map(ch => {
                        const active = blacklisted.includes(ch.id);
                        return (
                            <div
                                key={ch.id}
                                className={classes(cl("dm-pick-row"), active && cl("dm-pick-row-active"))}
                                onClick={() => toggle(ch.id)}
                            >
                                <img className={cl("dm-pick-avatar")} src={ch.avatarUrl} alt="" />
                                <div className={cl("dm-pick-name")}>
                                    <Span size="sm">{ch.displayName}</Span>
                                    {ch.username && ch.username !== ch.displayName && (
                                        <Span size="xs" color="text-muted"> ({ch.username})</Span>
                                    )}
                                </div>
                                <div className={classes(cl("dm-pick-check"), active && cl("dm-pick-check-active"))}>
                                    {active && "✕"}
                                </div>
                            </div>
                        );
                    })
                }
            </ScrollerThin>
        </div>
    );
}

interface DmActionPickerProps {
    blockIds: string[];
    onBlockChange: (ids: string[]) => void;
    unaddIds: string[];
    onUnaddChange: (ids: string[]) => void;
    closeIds: string[];
    onCloseChange: (ids: string[]) => void;
    leaveMessages: Record<string, string>;
    onLeaveMessagesChange: (msgs: Record<string, string>) => void;
}

function DmActionPicker({ blockIds, onBlockChange, unaddIds, onUnaddChange, closeIds, onCloseChange, leaveMessages, onLeaveMessagesChange }: DmActionPickerProps) {
    const channels = useAllDmChannels();
    const [search, setSearch] = useState("");
    const [expandedMsg, setExpandedMsg] = useState<string | null>(null);
    const [showGlobalMsg, setShowGlobalMsg] = useState(false);
    const [globalMsgText, setGlobalMsgText] = useState("");

    const filtered = search.trim()
        ? channels.filter(ch => {
            const q = search.toLowerCase();
            return ch.displayName.toLowerCase().includes(q) || ch.username.toLowerCase().includes(q);
        })
        : channels;

    const toggleList = (id: string, list: string[], onChange: (ids: string[]) => void) => {
        if (list.includes(id)) onChange(list.filter(x => x !== id));
        else onChange([...list, id]);
    };

    const toggleAll = (list: string[], onChange: (ids: string[]) => void) => {
        const allIds = channels.map(ch => ch.id);
        const allSelected = allIds.every(id => list.includes(id));
        onChange(allSelected ? [] : allIds);
    };

    const allBlocked = channels.length > 0 && channels.every(ch => blockIds.includes(ch.id));
    const allUnadded = channels.length > 0 && channels.every(ch => unaddIds.includes(ch.id));
    const allClosed = channels.length > 0 && channels.every(ch => closeIds.includes(ch.id));
    const msgCount = Object.keys(leaveMessages).length;

    if (!channels.length) return (
        <Span size="xs" color="text-muted">No DMs found.</Span>
    );

    return (
        <div className={cl("dm-picker-wrap")}>
            <div className={cl("dm-action-header")}>
                <Span size="xs" color="text-muted" style={{ flex: 1 }}>Select all:</Span>
                <Tooltip text={allBlocked ? "Unblock all" : "Block all"}>
                    {p => (
                        <button
                            {...p}
                            className={classes(cl("dm-action-btn"), allBlocked && cl("dm-action-btn-danger"))}
                            onClick={() => toggleAll(blockIds, onBlockChange)}
                        >B All</button>
                    )}
                </Tooltip>
                <Tooltip text={allUnadded ? "Re-add all" : "Unadd all"}>
                    {p => (
                        <button
                            {...p}
                            className={classes(cl("dm-action-btn"), allUnadded && cl("dm-action-btn-danger"))}
                            onClick={() => toggleAll(unaddIds, onUnaddChange)}
                        >U All</button>
                    )}
                </Tooltip>
                <Tooltip text={allClosed ? "Unclose all" : "Close all"}>
                    {p => (
                        <button
                            {...p}
                            className={classes(cl("dm-action-btn"), allClosed && cl("dm-action-btn-danger"))}
                            onClick={() => toggleAll(closeIds, onCloseChange)}
                        >X All</button>
                    )}
                </Tooltip>
                <Tooltip text={showGlobalMsg ? "Hide global message" : "Set message for all"}>
                    {p => (
                        <button
                            {...p}
                            className={classes(cl("dm-action-btn"), msgCount > 0 && cl("dm-action-btn-primary"))}
                            onClick={() => setShowGlobalMsg(!showGlobalMsg)}
                        >M All</button>
                    )}
                </Tooltip>
            </div>

            {showGlobalMsg && (
                <div className={cl("dm-action-global-msg")}>
                    <TextInput
                        placeholder="Message for all DMs..."
                        value={globalMsgText}
                        onChange={setGlobalMsgText}
                        style={{ flex: 1 }}
                    />
                    <Button
                        variant="primary"
                        size="small"
                        onClick={() => {
                            if (!globalMsgText.trim()) return;
                            const next: Record<string, string> = {};
                            for (const ch of channels) next[ch.id] = globalMsgText;
                            onLeaveMessagesChange(next);
                        }}
                    >Apply</Button>
                    {msgCount > 0 && (
                        <Button
                            variant="dangerSecondary"
                            size="small"
                            onClick={() => onLeaveMessagesChange({})}
                        >Clear</Button>
                    )}
                </div>
            )}

            <div className={cl("dm-picker-search")}>
                <TextInput
                    placeholder="Search..."
                    value={search}
                    onChange={setSearch}
                />
            </div>
            <ScrollerThin className={cl("dm-picker")} style={{ maxHeight: "none" }}>
                {filtered.length === 0
                    ? <div className={cl("dm-pick-row")}><Span size="xs" color="text-muted">No results.</Span></div>
                    : filtered.map(ch => {
                        const isBlock = blockIds.includes(ch.id);
                        const isUnadd = unaddIds.includes(ch.id);
                        const isClose = closeIds.includes(ch.id);
                        const hasMsg = !!leaveMessages[ch.id];
                        const isExpanded = expandedMsg === ch.id;

                        return (
                            <div key={ch.id}>
                                <div className={cl("dm-pick-row")}>
                                    <img className={cl("dm-pick-avatar")} src={ch.avatarUrl} alt="" />
                                    <div className={cl("dm-pick-name")}>
                                        <Span size="sm">{ch.displayName}</Span>
                                        {ch.username && ch.username !== ch.displayName && (
                                            <Span size="xs" color="text-muted"> ({ch.username})</Span>
                                        )}
                                    </div>
                                    <div className={cl("dm-action-buttons")}>
                                        <Tooltip text="Block">
                                            {p => (
                                                <button
                                                    {...p}
                                                    className={classes(cl("dm-action-btn"), isBlock && cl("dm-action-btn-danger"))}
                                                    onClick={() => toggleList(ch.id, blockIds, onBlockChange)}
                                                >B</button>
                                            )}
                                        </Tooltip>
                                        <Tooltip text="Unadd">
                                            {p => (
                                                <button
                                                    {...p}
                                                    className={classes(cl("dm-action-btn"), isUnadd && cl("dm-action-btn-danger"))}
                                                    onClick={() => toggleList(ch.id, unaddIds, onUnaddChange)}
                                                >U</button>
                                            )}
                                        </Tooltip>
                                        <Tooltip text="Close DM">
                                            {p => (
                                                <button
                                                    {...p}
                                                    className={classes(cl("dm-action-btn"), isClose && cl("dm-action-btn-danger"))}
                                                    onClick={() => toggleList(ch.id, closeIds, onCloseChange)}
                                                >X</button>
                                            )}
                                        </Tooltip>
                                        <Tooltip text="Leave message">
                                            {p => (
                                                <button
                                                    {...p}
                                                    className={classes(cl("dm-action-btn"), hasMsg && cl("dm-action-btn-primary"))}
                                                    onClick={() => setExpandedMsg(isExpanded ? null : ch.id)}
                                                >M</button>
                                            )}
                                        </Tooltip>
                                    </div>
                                </div>
                                {isExpanded && (
                                    <div className={cl("dm-action-msg-input")}>
                                        <TextInput
                                            placeholder="Message to leave behind..."
                                            value={leaveMessages[ch.id] ?? ""}
                                            onChange={v => {
                                                const next = { ...leaveMessages };
                                                if (v.trim()) next[ch.id] = v;
                                                else delete next[ch.id];
                                                onLeaveMessagesChange(next);
                                            }}
                                        />
                                    </div>
                                )}
                            </div>
                        );
                    })
                }
            </ScrollerThin>
        </div>
    );
}

function GlobalRightPanel({ globalState }: { globalState: GlobalState; }) {
    const { blacklistedChannels, setBlacklistedChannels, globalPostBlock, setGlobalPostBlock, globalPostUnadd, setGlobalPostUnadd, globalPostClose, setGlobalPostClose, globalLeaveMessages, setGlobalLeaveMessages } = globalState;

    return (
        <>
            <div className={cl("section-label")}>
                <Span size="sm" weight="bold" color="text-muted">SKIP DMS</Span>
            </div>
            <Span size="xs" color="text-muted">
                Messages from these DMs will not be deleted
            </Span>
            <div className={cl("row")} style={{ gap: 8 }}>
                {blacklistedChannels.length > 0 && (
                    <Span size="xs" color="text-muted">{blacklistedChannels.length} skipped</Span>
                )}
                {blacklistedChannels.length > 0 && (
                    <Button variant="secondary" size="small" onClick={() => setBlacklistedChannels([])}>
                        Clear
                    </Button>
                )}
            </div>
            <DmChannelPicker blacklisted={blacklistedChannels} onChange={setBlacklistedChannels} />

            <Divider />

            <div className={cl("section-label")}>
                <Span size="sm" weight="bold" color="text-muted">POST-PURGE ACTIONS</Span>
            </div>
            <Span size="xs" color="text-muted">
                Set per-DM actions to run after purging
            </Span>
            <DmActionPicker
                blockIds={globalPostBlock}
                onBlockChange={setGlobalPostBlock}
                unaddIds={globalPostUnadd}
                onUnaddChange={setGlobalPostUnadd}
                closeIds={globalPostClose}
                onCloseChange={setGlobalPostClose}
                leaveMessages={globalLeaveMessages}
                onLeaveMessagesChange={setGlobalLeaveMessages}
            />
        </>
    );
}

function useGuildChannels(guildId: string | null) {
    return useCallback(() => {
        if (!guildId) return [];
        try {
            const collection = GuildChannelStore.getChannels(guildId);
            const channels: { id: string; value: string; label: string; }[] = [];
            const seen = new Set<string>();
            if (collection?.SELECTABLE) {
                for (const entry of collection.SELECTABLE) {
                    const ch = entry?.channel;
                    if (ch?.name && !seen.has(ch.id)) {
                        seen.add(ch.id);
                        channels.push({ id: ch.id, value: ch.id, label: `#${ch.name}` });
                    }
                }
            }
            const vocal = collection?.VOCAL;
            if (vocal) {
                const list = Array.isArray(vocal) ? vocal : Object.values(vocal);
                for (const entry of list) {
                    const ch = (entry as { channel?: { id: string; name: string; }; })?.channel;
                    if (ch?.name && !seen.has(ch.id)) {
                        seen.add(ch.id);
                        channels.push({ id: ch.id, value: ch.id, label: `🔊 ${ch.name}` });
                    }
                }
            }
            return channels;
        } catch {
            return [];
        }
    }, [guildId])();
}

// #endregion

// #region Running Panel

function formatEta(sec: number): string {
    if (sec < 60) return `~${Math.round(sec)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
}

function DmBreakdown({ byChannel }: { byChannel: Record<string, number>; }) {
    const entries = Object.entries(byChannel).sort(([, a], [, b]) => b - a);
    if (!entries.length) return null;
    return (
        <div className={cl("dm-breakdown")}>
            <Span size="xs" weight="bold" color="text-muted">FOUND PER DM</Span>
            <ScrollerThin className={cl("dm-list")}>
                {entries.map(([cid, count]) => (
                    <div key={cid} className={cl("dm-row")}>
                        <Span size="xs" className={cl("dm-row-name")}>{getDmLabel(cid)}</Span>
                        <Span size="xs" color="text-muted">{count}</Span>
                    </div>
                ))}
            </ScrollerThin>
        </div>
    );
}

function RunningPanel() {
    const engine = useEngine();
    const isFetching = engine.state === "fetching";
    const isDeleting = engine.state === "running";
    const [eta, setEta] = useState<string | null>(null);

    const fetchProgress = engine.totalFound > 0 && isFetching
        ? Math.min((engine.fetched / engine.totalFound) * 100, 100)
        : 0;

    const deleteProgress = isDeleting && engine.toDelete > 0
        ? Math.min(((engine.deleted + engine.failed) / engine.toDelete) * 100, 100)
        : 0;

    const progress = isFetching ? fetchProgress : deleteProgress;

    useEffect(() => {
        if (!isDeleting || !engine.startTime) { setEta(null); return; }
        const tick = () => {
            const processed = engine.deleted + engine.failed;
            const remaining = engine.toDelete - processed;
            if (remaining <= 0 || processed <= 0) { setEta(null); return; }
            const elapsed = (Date.now() - (engine.startTime ?? 0)) / 1000;
            if (elapsed < 1) { setEta("Calculating…"); return; }
            setEta(formatEta(remaining / (processed / elapsed)));
        };
        tick();
        const id = setInterval(tick, 2000);
        return () => clearInterval(id);
    }, [isDeleting, engine.startTime, engine.deleted, engine.failed, engine.toDelete]);

    const stateColor = engine.paused ? "text-feedback-warning" as const
        : isFetching ? "text-link" as const
            : isDeleting ? "text-feedback-warning" as const
                : engine.state === "done" ? "text-feedback-positive" as const
                    : engine.state === "stopped" ? "text-danger" as const
                        : "text-muted" as const;

    const stateLabel = engine.paused ? "Paused"
        : isFetching ? "Fetching"
            : isDeleting ? "Deleting"
                : engine.state === "done" ? "Complete"
                    : engine.state === "stopped" ? "Stopped"
                        : "Idle";

    return (
        <div className={cl("running-info")}>
            <Card variant="primary" defaultPadding>
                <div className={cl("stats")}>
                    <div className={cl("stat-row")}>
                        <Span size="sm" weight="medium">Status</Span>
                        <Span size="sm" weight="bold" color={stateColor}>{stateLabel}</Span>
                    </div>

                    {isFetching && (
                        <div className={cl("stat-row")}>
                            <Span size="sm" weight="medium">Fetched</Span>
                            <Span size="sm" color="text-muted">
                                {engine.fetched}{engine.totalFound > 0 ? ` / ${engine.totalFound}` : ""}
                            </Span>
                        </div>
                    )}

                    {!isFetching && (
                        <>
                            <div className={cl("stat-row")}>
                                <Span size="sm" weight="medium">Deleted</Span>
                                <Span size="sm" weight="bold" color="text-feedback-positive">{engine.deleted}</Span>
                            </div>
                            {engine.failed > 0 && (
                                <div className={cl("stat-row")}>
                                    <Span size="sm" weight="medium">Failed</Span>
                                    <Span size="sm" weight="bold" color="text-danger">{engine.failed}</Span>
                                </div>
                            )}
                            {engine.skipped > 0 && (
                                <div className={cl("stat-row")}>
                                    <Span size="sm">Skipped</Span>
                                    <Span size="sm" color="text-muted">{engine.skipped}</Span>
                                </div>
                            )}
                            {engine.toDelete > 0 && (
                                <div className={cl("stat-row")}>
                                    <Span size="sm">To delete</Span>
                                    <Span size="sm" color="text-muted">{engine.toDelete}</Span>
                                </div>
                            )}
                            {eta && (
                                <div className={cl("stat-row")}>
                                    <Span size="sm">Remaining</Span>
                                    <Span size="sm" color="text-muted">{eta}</Span>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </Card>

            {progress > 0 && (
                <div className={cl("progress")}>
                    <div className={cl("progress-bar")} style={{ width: `${progress}%` }} />
                </div>
            )}

            {isFetching && Object.keys(engine.fetchedByChannel).length > 0 && (
                <DmBreakdown byChannel={engine.fetchedByChannel} />
            )}

            <Paragraph size="xs" color="text-muted" style={{ fontStyle: "italic" }}>
                {engine.status}
            </Paragraph>

            {engine.channelLabel && (
                <Span size="xs" color="text-subtle">Scope: {engine.channelLabel}</Span>
            )}

            {(isFetching || isDeleting) && (
                <Button
                    variant="secondary"
                    style={{ width: "100%" }}
                    onClick={engine.paused ? resumePurge : pausePurge}
                >
                    {engine.paused ? "Resume" : "Pause"}
                </Button>
            )}
        </div>
    );
}

// #endregion

// #region Preview Panel

function PreviewPanel() {
    const engine = useEngine();
    const scrollRef = useRef<HTMLDivElement>(null);
    const prevLenRef = useRef(0);

    useEffect(() => {
        if (engine.preview.length > prevLenRef.current && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
        prevLenRef.current = engine.preview.length;
    }, [engine.preview.length]);

    if (!engine.preview.length) {
        return (
            <div className={cl("empty")}>
                <Paragraph size="sm" color="text-muted">
                    {engine.state === "idle"
                        ? "Messages will appear here once you start purging"
                        : "Fetching messages..."}
                </Paragraph>
            </div>
        );
    }

    return (
        <div ref={scrollRef} className={cl("preview-scroll")}>
            <div className={cl("preview-scroll-inner")}>
                {engine.preview.map(entry => (
                    <MessagePreviewRow key={entry.msg.id} entry={entry} />
                ))}
            </div>
        </div>
    );
}

// #endregion

// #region Modal

type ActiveTab = "channel" | "global";

interface PurgeModalProps {
    modalProps: { onClose(): void; transitionState: number; };
    channel: Channel;
}

function PurgeModal({ modalProps, channel }: PurgeModalProps) {
    const engine = useEngine();
    const isActive = engine.state !== "idle";
    const channelLabel = channel.name ? `#${channel.name}` : `DM ${channel.id}`;
    const optsRef = useRef<PurgeOptions | null>(null);
    const [activeTab, setActiveTab] = useState<ActiveTab>("channel");

    const [blacklistedChannels, setBlacklistedChannels] = useState<string[]>([]);
    const [globalPostBlock, setGlobalPostBlock] = useState<string[]>([]);
    const [globalPostUnadd, setGlobalPostUnadd] = useState<string[]>([]);
    const [globalPostClose, setGlobalPostClose] = useState<string[]>([]);
    const [globalLeaveMessages, setGlobalLeaveMessages] = useState<Record<string, string>>({});

    const globalState: GlobalState = {
        blacklistedChannels, setBlacklistedChannels,
        globalPostBlock, setGlobalPostBlock,
        globalPostUnadd, setGlobalPostUnadd,
        globalPostClose, setGlobalPostClose,
        globalLeaveMessages, setGlobalLeaveMessages,
    };

    return (
        <ModalRoot {...modalProps} size="large" className={cl("modal")}>
            <ModalHeader className={cl("header")}>
                <div className={cl("title-row")}>
                    <div className={cl("title-icon")}>
                        <TrashIconSettings />
                    </div>
                    <div className={cl("title-text")}>
                        <Span size="lg" weight="bold" color="text-default">
                            {isActive ? `Purging — ${engine.channelLabel || channelLabel}` : "Purge Messages"}
                        </Span>
                        <Span size="xs" color="text-muted">
                            {isActive ? "Operation in progress" : channelLabel}
                        </Span>
                    </div>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            {!isActive && (
                <div className={cl("tabs")}>
                    <button
                        className={classes(cl("tab"), activeTab === "channel" && cl("tab-active"))}
                        onClick={() => setActiveTab("channel")}
                    >
                        DM / Channel
                    </button>
                    <button
                        className={classes(cl("tab"), activeTab === "global" && cl("tab-active"))}
                        onClick={() => setActiveTab("global")}
                    >
                        Global DMs
                    </button>
                </div>
            )}

            <div className={cl("body")}>
                {isActive ? (
                    <>
                        <div className={cl("controls")}>
                            <ScrollerThin fade className={cl("controls-scroll")}>
                                <div className={cl("controls-inner")}>
                                    <RunningPanel />
                                </div>
                            </ScrollerThin>
                        </div>
                        <div className={cl("preview")}>
                            <div className={cl("preview-header")}>
                                <Span size="sm" weight="semibold">Live Preview</Span>
                                <Span size="xs" color="text-muted">{engine.preview.length} messages</Span>
                            </div>
                            <PreviewPanel />
                        </div>
                    </>
                ) : activeTab === "global" ? (
                    <>
                        <div className={cl("controls")}>
                            <ScrollerThin fade className={cl("controls-scroll")}>
                                <div className={cl("controls-inner")}>
                                    <ControlsPanel channel={channel} globalMode optsRef={optsRef} globalState={globalState} />
                                </div>
                            </ScrollerThin>
                        </div>
                        <div className={cl("preview")}>
                            <ScrollerThin fade className={cl("controls-scroll")}>
                                <div className={cl("controls-inner")}>
                                    <GlobalRightPanel globalState={globalState} />
                                </div>
                            </ScrollerThin>
                        </div>
                    </>
                ) : (
                    <div className={cl("controls-full")}>
                        <ScrollerThin fade className={cl("controls-scroll")}>
                            <div className={cl("controls-inner")}>
                                <ControlsPanel channel={channel} globalMode={false} optsRef={optsRef} globalState={globalState} />
                            </div>
                        </ScrollerThin>
                    </div>
                )}
            </div>

            <ModalFooter>
                <div className={cl("footer")}>
                    {engine.state === "idle" && (
                        <>
                            <Button variant="secondary" onClick={modalProps.onClose}>
                                Cancel
                            </Button>
                            <Button
                                variant="dangerPrimary"
                                onClick={() => { if (optsRef.current) runPurge(optsRef.current); }}
                            >
                                {activeTab === "global" ? "Start Global Purge" : "Start Purge"}
                            </Button>
                        </>
                    )}

                    {(engine.state === "fetching" || engine.state === "running") && (
                        <>
                            <Button variant="dangerSecondary" onClick={stopPurge}>
                                Stop
                            </Button>
                            <Button variant="primary" onClick={modalProps.onClose}>
                                Close
                            </Button>
                        </>
                    )}

                    {(engine.state === "done" || engine.state === "stopped") && (
                        <>
                            <Button variant="secondary" onClick={() => { resetEngine(); }}>
                                New Purge
                            </Button>
                            <Button variant="primary" onClick={modalProps.onClose}>
                                Close
                            </Button>
                        </>
                    )}
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}

// #endregion

function onPurgerKeydown(e: KeyboardEvent) {
    if (!matchesPurgerKeybind(e)) return;
    if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
    e.preventDefault();
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;
    const channel = ChannelStore.getChannel(channelId);
    if (channel) openPurgeModal(channel);
}

export default definePlugin({
    name: "Message Purger",
    description: "Bulk delete your messages from any channel or across all DMs using Discord's search API.",
    authors: [{ name: "eco", id: 666n }],
    settings,
    chatBarButton: {
        icon: TrashIconSettings,
        render: PurgerChatBarButton,
    },

    start() {
        document.addEventListener("keydown", onPurgerKeydown);
    },

    stop() {
        document.removeEventListener("keydown", onPurgerKeydown);
    },
});
