/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import * as DataStore from "@api/DataStore";
import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import {
    AuthenticationStore,
    ChannelStore,
    FluxDispatcher,
    IconUtils,
    Menu,
    MessageActions,
    React,
    RestAPI,
    Toasts,
    Tooltip,
    UserStore,
} from "@webpack/common";

import { addDockButton, addUserContextEntry, removeDockButton, removeUserContextEntry } from "../pluginDock";

const MessageStore = findByPropsLazy("getMessages", "getMessage");
const VoiceStateStore = findStoreLazy("VoiceStateStore");

const TARGET_GUILD_ID = "319560327719026709";
const OWNER_PERM = BigInt("3146752");
const CLAIM_COMMAND = "!voice-claim";
const PANEL_COMMAND = "!vc";
const PANEL_KEY = "vcutils-panel-v2";
const VC_NAME_RE = /^VC\s+\d+$/i;
const COMMON_USER_ACTIONS = ["Ban", "Kick", "Mute", "Unmute", "Unban", "Transfer"];

const settings = definePluginSettings({
    autoClaim: {
        type: OptionType.BOOLEAN,
        description: "Auto-claim VC when no owner is present or owner leaves.",
        default: true,
    },
});

interface BotButton {
    label: string;
    customId: string;
    style: number;
    emoji?: { id?: string; name?: string; };
}

interface SavedPanel {
    messageId: string;
    channelId: string;
    botId: string;
    botName: string;
    botAvatar: string;
    buttons: BotButton[];
}

let savedPanel: SavedPanel | null = null;
let lastClaimAt = 0;
let claimInFlight = false;

async function loadPanel() {
    savedPanel = (await DataStore.get(PANEL_KEY)) ?? null;
}

async function savePanel(panel: SavedPanel) {
    savedPanel = panel;
    await DataStore.set(PANEL_KEY, panel);
}

function isTargetVc(channelId: string | null | undefined): boolean {
    if (!channelId) return false;
    const ch = ChannelStore.getChannel(channelId);
    if (!ch || ch.guild_id !== TARGET_GUILD_ID) return false;
    const name = (ch as any).name ?? "";
    return VC_NAME_RE.test(name);
}

function toBigIntSafe(value: any): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string") return BigInt(value.replace(/n$/, "").trim());
    return BigInt(0);
}

function detectVcOwner(channelId: string): string | null {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return null;
    const overwrites = (channel as any).permissionOverwrites ?? (channel as any).permissionOverwrites_;
    if (!overwrites || typeof overwrites !== "object") return null;
    for (const [id, ow] of Object.entries(overwrites)) {
        try {
            const { allow, type } = ow as any;
            if (type === 1 && allow != null && toBigIntSafe(allow) === OWNER_PERM) return id;
        } catch { }
    }
    return null;
}

function interactionNonce(): string {
    return (BigInt(Date.now()) - 1420070400000n).toString() + Math.floor(Math.random() * 100000).toString();
}

function waitForBotPanelMessage(channelId: string, timeoutMs = 6000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", handler);
            reject(new Error("Timed out waiting for bot panel"));
        }, timeoutMs);
        const handler = (data: any) => {
            const msg = data?.message;
            if (msg?.channel_id !== channelId) return;
            if (!msg.author?.bot) return;
            if (!msg.components?.length) return;
            const hasInteractive = msg.components.some((row: any) =>
                (row?.components ?? []).some((c: any) => (c?.type === 2 || c?.type === 3) && (c?.customId ?? c?.custom_id)));
            if (!hasInteractive) return;
            clearTimeout(timer);
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", handler);
            resolve(msg);
        };
        FluxDispatcher.subscribe("MESSAGE_CREATE", handler);
    });
}

function extractPanel(msg: any, channelId: string): SavedPanel | null {
    const buttons: BotButton[] = [];
    try {
        for (const row of msg.components ?? []) {
            for (const comp of row.components ?? []) {
                if (comp?.type !== 2) continue;
                const customId = comp.customId ?? comp.custom_id;
                if (!customId) continue;
                buttons.push({
                    label: comp.label ?? comp.emoji?.name ?? "???",
                    customId,
                    style: comp.style ?? 2,
                    emoji: comp.emoji,
                });
            }
        }
    } catch { return null; }
    if (!buttons.length) return null;
    let avatar: string;
    try { avatar = msg.author.getAvatarURL?.(undefined, 32) ?? IconUtils.getDefaultAvatarURL(msg.author.id); }
    catch { avatar = IconUtils.getDefaultAvatarURL(msg.author.id); }
    return {
        messageId: msg.id,
        channelId: msg.channel_id ?? channelId,
        botId: msg.author.id,
        botName: msg.author.username ?? "Bot",
        botAvatar: avatar,
        buttons,
    };
}

async function sendChatAndCapturePanel(vcChannelId: string, command: string): Promise<SavedPanel | null> {
    await RestAPI.post({
        url: `/channels/${vcChannelId}/messages`,
        body: { content: command, nonce: Math.floor(Math.random() * 1e16).toString() },
    });
    try {
        const reply = await waitForBotPanelMessage(vcChannelId);
        const panel = extractPanel(reply, vcChannelId);
        if (panel) {
            await savePanel(panel);
            return panel;
        }
    } catch { }
    return null;
}

async function performClaim(vcChannelId: string) {
    if (claimInFlight) return;
    const now = Date.now();
    if (now - lastClaimAt < 8000) return;
    claimInFlight = true;
    lastClaimAt = now;
    try {
        const panel = await sendChatAndCapturePanel(vcChannelId, CLAIM_COMMAND);
        if (panel) {
            Toasts.show({ id: Toasts.genId(), message: `Claimed and saved panel from ${panel.botName}`, type: Toasts.Type.SUCCESS, options: { position: Toasts.Position.BOTTOM } });
        } else {
            Toasts.show({ id: Toasts.genId(), message: `Sent ${CLAIM_COMMAND}`, type: Toasts.Type.SUCCESS, options: { position: Toasts.Position.BOTTOM } });
        }
    } catch (e: any) {
        Toasts.show({ id: Toasts.genId(), message: `Claim failed: ${e?.body?.message ?? e?.message ?? "error"}`, type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
    } finally {
        claimInFlight = false;
    }
}

let panelFetchInFlight = false;
async function ensurePanel(vcChannelId: string): Promise<SavedPanel | null> {
    if (savedPanel) return savedPanel;
    if (panelFetchInFlight) return null;
    panelFetchInFlight = true;
    try {
        const panel = await sendChatAndCapturePanel(vcChannelId, PANEL_COMMAND);
        if (panel) {
            Toasts.show({ id: Toasts.genId(), message: `Fetched panel from ${panel.botName}`, type: Toasts.Type.SUCCESS, options: { position: Toasts.Position.BOTTOM } });
        } else {
            Toasts.show({ id: Toasts.genId(), message: "Could not fetch panel", type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
        }
        return panel;
    } catch (e: any) {
        Toasts.show({ id: Toasts.genId(), message: `Panel fetch failed: ${e?.body?.message ?? e?.message ?? "error"}`, type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
        return null;
    } finally {
        panelFetchInFlight = false;
    }
}

function buildInteractionPayload(panel: SavedPanel, button: BotButton) {
    const channel = ChannelStore.getChannel(panel.channelId);
    return {
        type: 3,
        guild_id: channel?.guild_id,
        channel_id: panel.channelId,
        message_id: panel.messageId,
        message_flags: 0,
        application_id: panel.botId,
        session_id: (AuthenticationStore as any)?.getSessionId?.(),
        data: { component_type: 2, custom_id: button.customId },
    };
}

function findPanelInChannelHistory(channelId: string): SavedPanel | null {
    try {
        const messages = MessageStore.getMessages(channelId)?.toArray?.() ?? [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (!msg?.author?.bot) continue;
            const panel = extractPanel(msg, channelId);
            if (panel) return panel;
        }
    } catch { }
    return null;
}

async function runUserAction(actionLabel: string, userId: string, vcChannelId: string): Promise<void> {
    const me = UserStore.getCurrentUser();
    if (!me) return;

    const owner = detectVcOwner(vcChannelId);
    if (!owner) {
        Toasts.show({ id: Toasts.genId(), message: "No VC owner detected", type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
        return;
    }
    if (owner !== me.id) {
        Toasts.show({ id: Toasts.genId(), message: "You're not the VC owner", type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
        return;
    }

    let panel: SavedPanel | null = null;

    if (savedPanel && savedPanel.channelId === vcChannelId) {
        panel = savedPanel;
    }

    if (!panel) {
        const fromHistory = findPanelInChannelHistory(vcChannelId);
        if (fromHistory) {
            await savePanel(fromHistory);
            panel = fromHistory;
        }
    }

    if (!panel) {
        panel = await ensurePanel(vcChannelId);
    }

    if (!panel) {
        Toasts.show({ id: Toasts.genId(), message: "Could not get bot panel", type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
        return;
    }

    const labelLower = actionLabel.toLowerCase();
    let button = panel.buttons.find(b => (b.label ?? "").toLowerCase().includes(labelLower));
    if (!button) {
        Toasts.show({ id: Toasts.genId(), message: `No "${actionLabel}" button on panel`, type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
        return;
    }
    try {
        await clickButtonForUser(panel, button, userId);
        Toasts.show({ id: Toasts.genId(), message: `${button.label} ran`, type: Toasts.Type.SUCCESS, options: { position: Toasts.Position.BOTTOM } });
        return;
    } catch (e: any) {
        if (!isStaleInteractionError(e)) {
            Toasts.show({ id: Toasts.genId(), message: `Failed: ${e?.body?.message ?? e?.message ?? "error"}`, type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
            return;
        }
    }

    savedPanel = null;
    try { await DataStore.del(PANEL_KEY); } catch { }

    const fresh = await ensurePanel(vcChannelId);
    if (!fresh) {
        Toasts.show({ id: Toasts.genId(), message: "Could not re-fetch panel after stale error", type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
        return;
    }
    const freshButton = fresh.buttons.find(b => (b.label ?? "").toLowerCase().includes(labelLower));
    if (!freshButton) {
        Toasts.show({ id: Toasts.genId(), message: `No "${actionLabel}" button on new panel`, type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
        return;
    }
    try {
        await clickButtonForUser(fresh, freshButton, userId);
        Toasts.show({ id: Toasts.genId(), message: `${freshButton.label} ran (after retry)`, type: Toasts.Type.SUCCESS, options: { position: Toasts.Position.BOTTOM } });
    } catch (e: any) {
        Toasts.show({ id: Toasts.genId(), message: `Failed after retry: ${e?.body?.message ?? e?.message ?? "error"}`, type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
    }
}

async function clickButtonForUser(panel: SavedPanel, button: BotButton, userId: string) {
    const channel = ChannelStore.getChannel(panel.channelId);
    const guildId = channel?.guild_id;
    const sessionId = (AuthenticationStore as any)?.getSessionId?.();
    await RestAPI.post({ url: "/interactions", body: { ...buildInteractionPayload(panel, button), nonce: interactionNonce() } });
    const reply = await waitForBotPanelMessage(panel.channelId, 5000);
    const selectComp = reply.components?.flatMap((row: any) => row.components ?? [])?.find((c: any) => c.type === 3);
    if (!selectComp) throw new Error("No select component in bot reply");
    const selectCustomId = selectComp.customId ?? selectComp.custom_id;
    await RestAPI.post({
        url: "/interactions",
        body: {
            type: 3,
            guild_id: guildId,
            channel_id: panel.channelId,
            message_id: reply.id,
            message_flags: reply.flags ?? 64,
            application_id: panel.botId,
            session_id: sessionId,
            nonce: interactionNonce(),
            data: { component_type: 3, custom_id: selectCustomId, type: 3, values: [userId] },
        },
    });
}

function isStaleInteractionError(e: any): boolean {
    const code = e?.body?.code;
    const msg = (e?.body?.message ?? e?.message ?? "").toString().toLowerCase();
    return code === 10008
        || code === 10062
        || msg.includes("unknown message")
        || msg.includes("unknown interaction")
        || msg.includes("invalid interaction");
}

function getReactProps(el: any): any {
    if (!el) return null;
    const key = Object.keys(el).find(k => k.startsWith("__reactProps$"));
    return key ? el[key] : null;
}

function findUserIdFromElement(start: HTMLElement | null): string | null {
    let el: HTMLElement | null = start;
    while (el && el !== document.body) {
        const tileAttr = el.getAttribute?.("data-selenium-video-tile");
        if (tileAttr && /^\d{15,}$/.test(tileAttr)) return tileAttr;
        const props = getReactProps(el);
        if (props) {
            const candidate = props.userId
                ?? props.user?.id
                ?? props.participant?.user?.id
                ?? props.participant?.userId
                ?? props.participantUserId
                ?? props.voiceParticipant?.userId;
            if (candidate && typeof candidate === "string") return candidate;
        }
        el = el.parentElement;
    }
    return null;
}

function handleShiftClick(e: MouseEvent) {
    if (!e.shiftKey || e.button !== 0) return;
    const me = UserStore.getCurrentUser();
    if (!me) return;
    const myVs = VoiceStateStore.getVoiceStateForUser(me.id);
    const vcId = myVs?.channelId;
    if (!vcId || !isTargetVc(vcId)) return;
    const userId = findUserIdFromElement(e.target as HTMLElement);
    if (!userId || userId === me.id) return;
    e.preventDefault();
    e.stopPropagation();
    void runUserAction("Ban", userId, vcId);
}

function handleShiftContextMenu(e: MouseEvent) {
    if (!e.shiftKey) return;
    const me = UserStore.getCurrentUser();
    if (!me) return;
    const myVs = VoiceStateStore.getVoiceStateForUser(me.id);
    const vcId = myVs?.channelId;
    if (!vcId || !isTargetVc(vcId)) return;
    const userId = findUserIdFromElement(e.target as HTMLElement);
    if (!userId || userId === me.id) return;
    e.preventDefault();
    e.stopPropagation();
    void runUserAction("Kick", userId, vcId);
}

function VcUtilsIcon({ colorClass, width, height }: { color?: string; colorClass?: string; width?: number; height?: number; }) {
    const w = width ?? 20;
    const h = height ?? 20;
    return (
        <span style={{ position: "relative", display: "inline-flex", width: w, height: h }} className={colorClass}>
            <svg width={w} height={h} viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
                <path d="M19 12a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 1 0 2 0v-2.08A7 7 0 0 0 19 12Z" />
            </svg>
            <svg
                width={Math.round(w * 0.7)}
                height={Math.round(h * 0.7)}
                viewBox="0 0 24 24"
                fill="currentColor"
                style={{ position: "absolute", right: -3, bottom: -3, pointerEvents: "none" }}
            >
                <circle cx="12" cy="12" r="10" fill="var(--background-secondary, #2b2d31)" />
                <path d="M21 13v-2l-2-.5a7 7 0 0 0-.6-1.4l1.1-1.7-1.4-1.4-1.7 1.1A7 7 0 0 0 15 6.6L14.5 4.5h-2L12 6.6a7 7 0 0 0-1.4.6L8.9 6.1 7.5 7.5l1.1 1.7A7 7 0 0 0 8 10.6L6 11v2l2 .5a7 7 0 0 0 .6 1.4l-1.1 1.7 1.4 1.4 1.7-1.1a7 7 0 0 0 1.4.6L12 19.5h2l.5-2a7 7 0 0 0 1.4-.6l1.7 1.1 1.4-1.4-1.1-1.7a7 7 0 0 0 .6-1.4ZM13 15a3 3 0 1 1 3-3 3 3 0 0 1-3 3Z" />
            </svg>
        </span>
    );
}

function registerDock() {
    addDockButton("vcutils", {
        icon: VcUtilsIcon,
        tooltipText: `VC Utils${settings.store.autoClaim ? " (auto-claim ON)" : ""}`,
        glowing: settings.store.autoClaim,
        glowColor: "green",
        onClick: () => {
            settings.store.autoClaim = !settings.store.autoClaim;
            registerDock();
        },
    });
}

function handleVoiceStateUpdates(e: any) {
    if (!settings.store.autoClaim) return;
    const me = UserStore.getCurrentUser();
    if (!me) return;

    const myVs = VoiceStateStore.getVoiceStateForUser(me.id);
    const myChannelId = myVs?.channelId;
    if (!myChannelId || !isTargetVc(myChannelId)) return;

    for (const update of e.voiceStates ?? []) {
        if (update.userId === me.id) {
            const joined = update.channelId === myChannelId && update.oldChannelId !== myChannelId;
            if (joined) {
                setTimeout(() => {
                    const owner = detectVcOwner(myChannelId);
                    if (!owner) {
                        performClaim(myChannelId);
                        return;
                    }
                    const ownerVs = VoiceStateStore.getVoiceStateForUser(owner);
                    if (ownerVs?.channelId !== myChannelId) {
                        performClaim(myChannelId);
                    }
                }, 250);
            }
            continue;
        }
        const oldChannelId = update.oldChannelId;
        if (oldChannelId !== myChannelId) continue;
        if (update.channelId === oldChannelId) continue;
        const owner = detectVcOwner(myChannelId);
        if (owner !== update.userId) continue;
        performClaim(myChannelId);
    }
}

export default definePlugin({
    name: "VC Utils",
    description: "Hardcoded for one server: detects VC owner, shows crown, auto-claims when owner missing, captures bot panel for user actions.",
    authors: [{ name: "gabe", id: 1467949308816003193n }],
    dependencies: ["PluginDock"],
    settings,

    requiresRestart: true,
    patches: [
        {
            find: ".VOICE_PANEL}}",
            replacement: {
                match: /(VOICE_PANEL\}\},.+?\(0,\i\.\i\)\(\i,\{disabled:\i,\.\.\.\i,isHovered:\i\}\))(\])/,
                replace: "$1,$self.renderCrown($.id)$2",
            },
        },
        {
            find: "AccessibilityIcon:()=>",
            replacement: {
                match: /,(\i)=\{\};(\i\.r\(\1\),\i\.d\(\1,)/,
                replace: ",$1=arguments[1];$2",
            },
        },
    ],

    renderCrown(userOrUserId: any) {
        const userId = typeof userOrUserId === "string" ? userOrUserId : userOrUserId?.id;
        if (!userId) return null;
        const vs = VoiceStateStore.getVoiceStateForUser(userId);
        if (!vs?.channelId) return null;
        if (!isTargetVc(vs.channelId)) return null;
        const ownerId = detectVcOwner(vs.channelId);
        if (ownerId !== userId) return null;
        return (
            <Tooltip text="VC Owner">
                {({ onMouseEnter, onMouseLeave }: any) => (
                    <span
                        onMouseEnter={onMouseEnter}
                        onMouseLeave={onMouseLeave}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#f0b232",
                            verticalAlign: "middle",
                            width: 16,
                            height: 16,
                            marginLeft: -4,
                        }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M3 6 L8 11 L12 4 L16 11 L21 6 L19.5 18 L4.5 18 Z" />
                        </svg>
                    </span>
                )}
            </Tooltip>
        );
    },

    flux: {
        VOICE_STATE_UPDATES: handleVoiceStateUpdates,
    },

    commands: [
        {
            name: "vc",
            description: "Post a link to the voice channel you're currently in.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_, ctx) => {
                const me = UserStore.getCurrentUser();
                const vs = VoiceStateStore.getVoiceStateForUser(me?.id);
                if (!vs?.channelId) {
                    sendBotMessage(ctx.channel.id, { content: "You're not in a voice channel." });
                    return;
                }
                const channel = ChannelStore.getChannel(vs.channelId);
                const guildId = channel?.guild_id;
                if (!guildId) {
                    sendBotMessage(ctx.channel.id, { content: "Could not resolve your voice channel's guild." });
                    return;
                }
                MessageActions.sendMessage(ctx.channel.id, {
                    content: `https://discord.com/channels/${guildId}/${vs.channelId}`,
                    invalidEmojis: [],
                    tts: false,
                    validNonShortcutEmojis: [],
                }, true, {});
            },
        },
    ],

    async start() {
        registerDock();
        await loadPanel();
        document.addEventListener("click", handleShiftClick, true);
        document.addEventListener("contextmenu", handleShiftContextMenu, true);
        addUserContextEntry("vcUtils", (userId) => {
            if (userId === UserStore.getCurrentUser()?.id) return null;
            const me = UserStore.getCurrentUser();
            const myVs = me ? VoiceStateStore.getVoiceStateForUser(me.id) : null;
            const myVcId = myVs?.channelId;
            if (!myVcId || !isTargetVc(myVcId)) return null;
            return (
                <Menu.MenuItem id="vc-utils-user-actions" label="VC Bot Actions">
                    {COMMON_USER_ACTIONS.map(label => (
                        <Menu.MenuItem
                            key={label}
                            id={`vc-utils-${label.toLowerCase()}`}
                            label={label}
                            action={() => runUserAction(label, userId, myVcId)}
                        />
                    ))}
                </Menu.MenuItem>
            );
        });
    },

    stop() {
        removeDockButton("vcutils");
        removeUserContextEntry("vcUtils");
        document.removeEventListener("click", handleShiftClick, true);
        document.removeEventListener("contextmenu", handleShiftContextMenu, true);
    },

    detectVcOwner,
});
