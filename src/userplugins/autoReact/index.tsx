/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { definePluginSettings } from "@api/Settings";
import { classNameFactory } from "@utils/css";
import { classes, sleep } from "@utils/misc";
import { ModalCloseButton, ModalContent, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import {
    ChannelStore,
    FluxDispatcher,
    GuildMemberStore,
    IconUtils,
    MessageStore,
    RestAPI,
    SearchableSelect,
    SelectedChannelStore,
    Slider,
    Switch,
    Toasts,
    UserStore,
    showToast,
    useMemo,
    useState,
} from "@webpack/common";

import { addDockButton, removeDockButton } from "../pluginDock";
import "./style.css";

const cl = classNameFactory("vc-autoreact-");

const EmojiPickerComponent = findComponentByCodeLazy("shouldHidePickerActions");
const EmojiIntention = findByPropsLazy("REACTION", "STATUS", "CHAT");
const UnicodeEmojis = findByPropsLazy("getByCategory", "getByName");

const settings = definePluginSettings({
    emoji: {
        type: OptionType.STRING,
        description: "Emoji to react with.",
        default: "👍",
    },
    emojiList: {
        type: OptionType.STRING,
        description: "Multiple emojis separated by comma for cycle mode.",
        default: "",
    },
    mode: {
        type: OptionType.SELECT,
        description: "Reaction mode.",
        options: [
            { label: "Single", value: "single", default: true },
            { label: "Cycle", value: "cycle" },
            { label: "Random", value: "random" },
        ],
    },
    toggle: {
        type: OptionType.BOOLEAN,
        description: "Auto react on/off.",
        default: false,
        onChange: () => { try { registerDockButton(); } catch { } },
    },
    customUser: {
        type: OptionType.STRING,
        description: "User IDs to react to.",
        default: "",
    },
    delay: {
        type: OptionType.NUMBER,
        description: "Delay in seconds before reacting.",
        default: 0.25,
    },
    currentChannelOnly: {
        type: OptionType.BOOLEAN,
        description: "Only react in the currently viewed channel.",
        default: false,
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Skip messages from bots.",
        default: true,
    },
    keybind: {
        type: OptionType.STRING,
        description: "Keybind to open the Auto React modal.",
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

function parseEmojiInput(input: string): { id: string | null; name: string } {
    const trimmed = input.replace(/\s/g, "").replace(/[<>]/g, "");
    const match = trimmed.match(/^:?([^:]+):(\d+)$/);
    if (match) return { name: match[1], id: match[2] };
    return { id: null, name: trimmed || "👍" };
}

function splitList(s: string): string[] {
    return s.split(",").map(e => e.trim()).filter(Boolean);
}

function getRandomUnicodeEmoji(): { id: null; name: string } {
    const categories = ["people", "nature", "food", "activity", "travel", "objects", "symbols"];
    const cat = categories[Math.floor(Math.random() * categories.length)];
    const emojis = UnicodeEmojis.getByCategory(cat);
    if (!emojis?.length) return { id: null, name: "👍" };
    const pick = emojis[Math.floor(Math.random() * emojis.length)];
    return { id: null, name: pick.surrogates };
}

let cycleIndex = 0;
let lastReactedMessage = "";

async function tryReact(channelId: string, messageId: string, emoji: { id: string | null; name: string }) {
    try {
        const str = emoji.id ? `${emoji.name}:${emoji.id}` : encodeURIComponent(emoji.name);
        await RestAPI.put({ url: `/channels/${channelId}/messages/${messageId}/reactions/${str}/@me` });
    } catch { }
}

const MESSAGE_CREATE_HANDLER = async (e: { message: { id: string; author: { id: string; bot?: boolean } }; channelId: string }) => {
    if (!settings.store.toggle) return;

    const { id: messageId, author } = e.message;
    const { channelId } = e;

    if (!author?.id) return;
    if (messageId === lastReactedMessage) return;
    if (settings.store.ignoreBots && author.bot) return;

    const targets = splitList(settings.store.customUser);
    if (!targets.includes(author.id)) return;

    if (settings.store.currentChannelOnly && channelId !== SelectedChannelStore.getChannelId()) return;

    lastReactedMessage = messageId;

    await sleep(Math.max(0, (settings.store.delay ?? 0.25) * 1000));

    const mode = settings.store.mode ?? "single";
    if (mode === "random") {
        await tryReact(channelId, messageId, getRandomUnicodeEmoji());
    } else if (mode === "cycle") {
        const list = splitList(settings.store.emojiList);
        if (!list.length) return;
        await tryReact(channelId, messageId, parseEmojiInput(list[cycleIndex++ % list.length]));
    } else {
        if (!settings.store.emoji?.trim()) return;
        await tryReact(channelId, messageId, parseEmojiInput(settings.store.emoji));
    }
};

async function purgeSelfReactionsInCurrentChannel() {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) {
        showToast("No channel selected", Toasts.Type.FAILURE);
        return;
    }
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;

    const messages = MessageStore.getMessages(channelId)?.toArray?.() ?? [];
    const jobs: { messageId: string; emoji: { id: string | null; name: string; }; str: string; burst: boolean; }[] = [];

    for (const msg of messages) {
        for (const r of (msg.reactions ?? []) as any[]) {
            if (!r.me && !r.me_burst) continue;
            const e = r.emoji;
            const str = e.id ? `${e.name}:${e.id}` : encodeURIComponent(e.name);
            jobs.push({ messageId: msg.id, emoji: { id: e.id, name: e.name }, str, burst: !!r.me_burst });
        }
    }

    if (!jobs.length) {
        showToast("No reactions to remove in this channel", Toasts.Type.MESSAGE);
        return;
    }

    showToast(`Removing ${jobs.length} reaction${jobs.length === 1 ? "" : "s"}...`, Toasts.Type.MESSAGE);

    let ok = 0;
    let failed = 0;
    for (const j of jobs) {
        let attempts = 0;
        let waitMs = 0;
        while (attempts < 5) {
            attempts++;
            try {
                const res: any = await RestAPI.del({ url: `/channels/${channelId}/messages/${j.messageId}/reactions/${j.str}/@me` });
                ok++;
                FluxDispatcher.dispatch({
                    type: "MESSAGE_REACTION_REMOVE",
                    channelId,
                    messageId: j.messageId,
                    userId,
                    emoji: j.emoji,
                    burst: j.burst,
                });

                const h = res?.headers ?? {};
                const remaining = Number(h["x-ratelimit-remaining"] ?? h["X-RateLimit-Remaining"] ?? "1");
                const resetAfter = Number(h["x-ratelimit-reset-after"] ?? h["X-RateLimit-Reset-After"] ?? "0");
                if (remaining <= 0 && resetAfter > 0) waitMs = Math.ceil(resetAfter * 1000) + 20;
                break;
            } catch (err: any) {
                if (err?.status === 429) {
                    const retrySec = err.body?.retry_after ?? Number(err.headers?.["retry-after"] ?? 0.5);
                    waitMs = Math.max(0, Math.ceil(retrySec * 1000) + 50);
                    await sleep(waitMs);
                    waitMs = 0;
                    continue;
                }
                failed++;
                console.error("[AutoReact] purge failed", j, err?.body ?? err);
                break;
            }
        }
        if (waitMs > 0) await sleep(waitMs);
    }

    showToast(
        failed ? `Removed ${ok}, ${failed} failed (see console)` : `Removed ${ok} reaction${ok === 1 ? "" : "s"}`,
        failed ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS
    );
}

function AutoReactIcon({ width, height }: { width?: number; height?: number }) {
    return (
        <svg width={width ?? 18} height={height ?? 18} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" />
        </svg>
    );
}

const MODES = [
    { id: "single", label: "Single", desc: "One emoji" },
    { id: "cycle", label: "Cycle", desc: "Rotate through list" },
    { id: "random", label: "Random", desc: "Surprise me" },
] as const;

function AutoReactModal({ modalProps }: { modalProps: ModalProps }) {
    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    const currentUser = UserStore.getCurrentUser();
    const guildId = channel?.guild_id;

    const [emoji, setEmoji] = useState(settings.store.emoji || "👍");
    const [emojiList, setEmojiList] = useState(settings.store.emojiList || "");
    const [mode, setMode] = useState<string>(settings.store.mode ?? "single");
    const [delay, setDelay] = useState(settings.store.delay ?? 0.25);
    const [userIds, setUserIds] = useState<string[]>(() => splitList(settings.store.customUser));
    const [currentChannelOnly, setCurrentChannelOnly] = useState(settings.store.currentChannelOnly ?? false);
    const [ignoreBots, setIgnoreBots] = useState(settings.store.ignoreBots ?? true);
    const [pickerOpen, setPickerOpen] = useState(false);

    const userOptions = useMemo(() => {
        const opts: { label: string; value: string }[] = [];
        const seen = new Set<string>();

        if (currentUser?.id) {
            seen.add(currentUser.id);
            const name = currentUser.globalName ?? currentUser.username ?? "Me";
            opts.push({ label: `${name} (you)`, value: currentUser.id });
        }

        if (guildId) {
            try {
                for (const member of GuildMemberStore.getMembers(guildId) ?? []) {
                    const uid = (member as { userId?: string }).userId;
                    if (!uid || seen.has(uid)) continue;
                    seen.add(uid);
                    const user = UserStore.getUser(uid);
                    const nick = (member as { nick?: string | null }).nick;
                    const display = nick ?? user?.globalName ?? user?.username ?? uid;
                    const username = user?.username ?? uid;
                    opts.push({ label: display !== username ? `${display} (@${username})` : display, value: uid });
                }
            } catch { }
        } else if (channel) {
            for (const id of (channel.recipients ?? []) as string[]) {
                if (seen.has(id)) continue;
                seen.add(id);
                const user = UserStore.getUser(id);
                const display = user?.globalName ?? user?.username ?? id;
                const username = user?.username ?? id;
                opts.push({ label: display !== username ? `${display} (@${username})` : display, value: id });
            }
        }

        return opts;
    }, [guildId, channel?.recipients, currentUser?.id]);

    const handleEmojiSelect = (e: { emoji: { id?: string; name: string; optionallyDiverseSequence?: string } }) => {
        const em = e.emoji;
        const val = em.id ? `:${em.name}:${em.id}` : (em.optionallyDiverseSequence ?? em.name);

        if (mode === "cycle") {
            const list = splitList(emojiList);
            list.push(val);
            setEmojiList(list.join(", "));
        } else {
            setEmoji(val);
        }
        setPickerOpen(false);
    };

    const handleSave = () => {
        settings.store.emoji = emoji.trim() || "👍";
        settings.store.emojiList = emojiList;
        settings.store.mode = mode;
        settings.store.delay = Math.max(0, delay);
        settings.store.customUser = userIds.join(",");
        settings.store.currentChannelOnly = currentChannelOnly;
        settings.store.ignoreBots = ignoreBots;
        cycleIndex = 0;
        registerDockButton();
        modalProps.onClose();
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM} className={cl("modal")}>
            <div className={cl("header")}>
                <div className={cl("header-left")}>
                    <div className={cl("header-icon")}>
                        <AutoReactIcon />
                    </div>
                    <span className={cl("header-title")}>Auto React</span>
                    <div className={classes(cl("status"), settings.store.toggle && cl("status-active"))}>
                        <div className={cl("status-dot")} />
                        {settings.store.toggle ? "Active" : "Paused"}
                    </div>
                </div>
                <div className={cl("header-right")}>
                    <ModalCloseButton onClick={modalProps.onClose} />
                </div>
            </div>

            <ModalContent className={cl("body")}>
                <div className={cl("section")}>
                    <div className={cl("section-label")}>Target Users</div>
                    {userIds.length > 0 && (
                        <div className={cl("chips")}>
                            {userIds.map(uid => {
                                const user = UserStore.getUser(uid);
                                const member = guildId ? GuildMemberStore.getMember(guildId, uid) : null;
                                const name = (member as { nick?: string | null })?.nick ?? user?.globalName ?? user?.username ?? uid;
                                const src = user?.getAvatarURL?.(undefined, 32) ?? IconUtils.getDefaultAvatarURL(uid);
                                return (
                                    <div key={uid} className={cl("user-chip")}>
                                        <img className={cl("user-chip-avatar")} src={src} alt="" />
                                        <span className={cl("user-chip-name")}>{name}</span>
                                        <button className={cl("chip-remove")} onClick={() => setUserIds(userIds.filter(u => u !== uid))}>
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                                <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
                                            </svg>
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    <SearchableSelect
                        options={userOptions.filter(o => !userIds.includes(o.value))}
                        value={undefined}
                        placeholder="Add a user..."
                        maxVisibleItems={6}
                        closeOnSelect
                        onChange={v => {
                            const id = typeof v === "string" ? v : (v as { value?: string })?.value;
                            if (id && !userIds.includes(id)) setUserIds([...userIds, id]);
                        }}
                        renderOptionPrefix={o => {
                            if (!o?.value) return null;
                            const user = UserStore.getUser(o.value);
                            const src = user?.getAvatarURL?.(undefined, 24) ?? IconUtils.getDefaultAvatarURL(o.value);
                            return <img src={src} style={{ width: 24, height: 24, borderRadius: "50%" }} alt="" />;
                        }}
                    />
                </div>

                <div className={cl("divider")} />

                <div className={cl("section")}>
                    <div className={cl("section-label")}>Reaction Mode</div>
                    <div className={cl("mode-selector")}>
                        {MODES.map(m => (
                            <button
                                key={m.id}
                                className={classes(cl("mode-pill"), mode === m.id && cl("mode-pill-active"))}
                                onClick={() => setMode(m.id)}
                            >
                                <span className={cl("mode-pill-label")}>{m.label}</span>
                                <span className={cl("mode-pill-desc")}>{m.desc}</span>
                            </button>
                        ))}
                    </div>
                </div>

                <div className={cl("divider")} />

                <div className={cl("section")}>
                    <div className={cl("section-label")}>
                        {mode === "single" ? "Emoji" : mode === "cycle" ? "Emoji List" : "Random Mode"}
                    </div>

                    {mode === "single" && (
                        <button className={cl("emoji-card")} onClick={() => setPickerOpen(true)}>
                            <span className={cl("emoji-card-preview")}>{emoji}</span>
                            <span className={cl("emoji-card-hint")}>Click to change</span>
                        </button>
                    )}

                    {mode === "cycle" && (
                        <div className={cl("emoji-list")}>
                            {splitList(emojiList).map((e, i) => (
                                <div key={i} className={cl("emoji-chip")}>
                                    <span className={cl("emoji-chip-value")}>{e}</span>
                                    <button className={cl("chip-remove")} onClick={() => {
                                        const list = splitList(emojiList);
                                        list.splice(i, 1);
                                        setEmojiList(list.join(", "));
                                    }}>
                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                                            <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
                                        </svg>
                                    </button>
                                </div>
                            ))}
                            <button className={cl("emoji-add")} onClick={() => setPickerOpen(true)}>+</button>
                        </div>
                    )}

                    {mode === "random" && (
                        <div className={cl("info-card")}>
                            A random unicode emoji will be picked for each message. Nitro-locked emojis are automatically skipped.
                        </div>
                    )}
                </div>

                <div className={cl("divider")} />

                <div className={cl("section")}>
                    <div className={cl("section-header")}>
                        <span className={cl("section-label")}>Delay</span>
                        <span className={cl("section-value")}>{delay.toFixed(2)}s</span>
                    </div>
                    <Slider
                        initialValue={delay}
                        onValueChange={setDelay}
                        minValue={0}
                        maxValue={5}
                        markers={[0, 0.5, 1, 2, 3, 5]}
                        onValueRender={v => `${v.toFixed(1)}s`}
                        onMarkerRender={v => `${v}s`}
                    />
                </div>

                <div className={cl("divider")} />

                <div className={cl("section")}>
                    <div className={cl("section-label")}>Options</div>
                    <div className={cl("option-row")}>
                        <div className={cl("option-info")}>
                            <span className={cl("option-title")}>Current channel only</span>
                            <span className={cl("option-desc")}>Only react in the channel you're viewing</span>
                        </div>
                        <Switch checked={currentChannelOnly} onChange={setCurrentChannelOnly} />
                    </div>
                    <div className={cl("option-row")}>
                        <div className={cl("option-info")}>
                            <span className={cl("option-title")}>Ignore bots</span>
                            <span className={cl("option-desc")}>Skip messages from bot accounts</span>
                        </div>
                        <Switch checked={ignoreBots} onChange={setIgnoreBots} />
                    </div>
                </div>

                <div className={cl("divider")} />

                <div className={cl("section")}>
                    <div className={cl("section-label")}>Cleanup</div>
                    <div className={cl("option-row")}>
                        <div className={cl("option-info")}>
                            <span className={cl("option-title")}>Remove my reactions here</span>
                            <span className={cl("option-desc")}>Scans the current channel and removes every reaction you made.</span>
                        </div>
                        <Button variant="dangerPrimary" size="medium" onClick={purgeSelfReactionsInCurrentChannel}>
                            Purge
                        </Button>
                    </div>
                </div>
            </ModalContent>

            <div className={cl("footer")}>
                <div className={cl("footer-hint")}>
                    <kbd className={cl("kbd")}>Alt</kbd>
                    <span>+</span>
                    <kbd className={cl("kbd")}>A</kbd>
                    <span className={cl("footer-hint-text")}>to quick open</span>
                </div>
                <Button variant="primary" size="medium" onClick={handleSave}>
                    Save Changes
                </Button>
            </div>

            {pickerOpen && (
                <>
                    <div className={cl("picker-backdrop")} onClick={() => setPickerOpen(false)} />
                    <div className={cl("picker-container")}>
                        <EmojiPickerComponent
                            containerWidth={418}
                            pickerIntention={EmojiIntention.REACTION}
                            channel={channel}
                            closePopout={() => setPickerOpen(false)}
                            onSelectEmoji={handleEmojiSelect}
                        />
                    </div>
                </>
            )}
        </ModalRoot>
    );
}

function openAutoReactModal() {
    if (!SelectedChannelStore.getChannelId()) return;
    openModal(modalProps => <AutoReactModal modalProps={modalProps} />);
}

function registerDockButton() {
    addDockButton("autoreact", {
        icon: AutoReactIcon,
        tooltipText: "Auto React",
        glowing: settings.store.toggle,
        glowColor: "green",
        onClick: () => {
            settings.store.toggle = !settings.store.toggle;
            if (settings.store.toggle) cycleIndex = 0;
            registerDockButton();
        },
        onContextMenu: e => {
            e.preventDefault();
            openAutoReactModal();
        },
    });
}

let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

export default definePlugin({
    name: "Auto React",
    openSettingsModal: openAutoReactModal,
    description: "Automatically react to messages from specific users with customizable emoji and timing.",
    authors: [{ name: "gabe", id: 1467949308816003193n }],
    dependencies: ["PluginDock"],
    settings,
    start() {
        if (!settings.store.customUser) settings.store.customUser = UserStore.getCurrentUser()?.id ?? "";
        cycleIndex = 0;
        FluxDispatcher.subscribe("MESSAGE_CREATE", MESSAGE_CREATE_HANDLER);
        keydownHandler = (e: KeyboardEvent) => {
            if (matchKb(e, settings.store.keybind)) {
                e.preventDefault();
                openAutoReactModal();
            }
        };
        document.addEventListener("keydown", keydownHandler, true);
        registerDockButton();
    },
    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", MESSAGE_CREATE_HANDLER);
        if (keydownHandler) {
            document.removeEventListener("keydown", keydownHandler, true);
            keydownHandler = null;
        }
        removeDockButton("autoreact");
    },
});
