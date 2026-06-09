/*
 * Equicord, a Discord client mod
 * Copyright (c) 2026 Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { Span } from "@components/Span";
import { debounce } from "@shared/debounce";
import { classNameFactory } from "@utils/css";
import { getCurrentChannel } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { classes, sleep } from "@utils/misc";
import { ModalCloseButton, ModalFooter, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { FluxDispatcher, Menu, React, RestAPI, ScrollerThin, Select, Slider, showToast, Toasts, UserStore } from "@webpack/common";
import { useCallback, useEffect, useState } from "@webpack/common";

import { addChatInputContextEntry, addDockButton, addGuildContextEntry, removeChatInputContextEntry, removeDockButton, removeGuildContextEntry } from "../pluginDock";

const cl = classNameFactory("vc-msgtimer-");
const logger = new Logger("MessageTimer");

interface PendingDeletion {
    channelId: string;
    messageId: string;
    deleteAt: number;
}

const settings = definePluginSettings({
    active: {
        type: OptionType.BOOLEAN,
        description: "Auto-delete your messages after the configured lifespan.",
        default: false,
    },
    messageLifespan: {
        type: OptionType.NUMBER,
        description: "Duration (in ms) before a message is deleted.",
        default: 60000,
    },
    excludedChannels: {
        type: OptionType.STRING,
        description: "Channel IDs to exclude, separated by /",
        default: "",
    },
    excludedServers: {
        type: OptionType.STRING,
        description: "Server IDs to exclude, separated by /",
        default: "",
    },
    keybind: {
        type: OptionType.STRING,
        description: "Keybind to toggle message timer on/off.",
        default: "",
    },
}).withPrivateSettings<{
    pendingDeletions: PendingDeletion[];
}>();

const LAUNCH_PURGE_DELAY = 1250;
const SCHEDULE_WINDOW_MS = 30 * 60 * 1000;
const PERIODIC_INTERVAL_MS = 60 * 1000;

const scheduledTimers = new Set<ReturnType<typeof setTimeout>>();

function getPendingQueue(): PendingDeletion[] {
    try {
        const raw = settings.store.pendingDeletions;
        if (!raw || !Array.isArray(raw)) return [];
        return JSON.parse(JSON.stringify(raw)) as PendingDeletion[];
    } catch {
        return [];
    }
}

function savePendingQueue(queue: PendingDeletion[]) {
    settings.store.pendingDeletions = queue;
}

function addToPendingQueue(entry: PendingDeletion) {
    const queue = getPendingQueue();
    queue.push(entry);
    savePendingQueue(queue);
}

function removeFromPendingQueue(messageId: string) {
    savePendingQueue(getPendingQueue().filter(e => e.messageId !== messageId));
}

function matchesKeybind(e: KeyboardEvent) {
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

function handleKeybind(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
    if (!matchesKeybind(e)) return;
    e.preventDefault();
    setActive(!settings.store.active);
}

function setActive(val: boolean) {
    settings.store.active = val;
    showToast(
        `Message Timer ${val ? "enabled" : "disabled"}`,
        val ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE,
    );
    registerDock();
}

function getExcludedList(raw: string): string[] {
    return raw.split("/").filter(s => s !== "");
}

function toggleExclusion(raw: string, id: string): string {
    const list = getExcludedList(raw);
    const idx = list.indexOf(id);
    if (idx === -1) list.push(id);
    else list.splice(idx, 1);
    return list.join("/");
}

async function deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    try {
        await RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` });
        return true;
    } catch (e: any) {
        if (e?.status === 429) {
            const wait = (e?.body?.retry_after ?? 3) * 1000;
            await sleep(wait);
            return deleteMessage(channelId, messageId);
        }
        if (e?.status === 404 || e?.status === 403) return true;
        logger.error("Delete failed", messageId, e);
        return false;
    }
}

function scheduleDeletion(entry: PendingDeletion, delay: number) {
    const timer = setTimeout(async () => {
        scheduledTimers.delete(timer);
        const success = await deleteMessage(entry.channelId, entry.messageId);
        if (success) removeFromPendingQueue(entry.messageId);
    }, delay);
    scheduledTimers.add(timer);
}

function onMessageCreate(e: any) {
    if (!settings.store.active) return;
    if (e.message.author.id !== UserStore.getCurrentUser().id) return;
    if (getExcludedList(settings.store.excludedChannels).includes(e.channelId)) return;
    if (getExcludedList(settings.store.excludedServers).includes(e.guildId)) return;

    const deleteAt = Date.now() + settings.store.messageLifespan;
    const entry: PendingDeletion = { channelId: e.channelId, messageId: e.message.id, deleteAt };
    addToPendingQueue(entry);
    scheduleDeletion(entry, settings.store.messageLifespan);
}

let processingQueue = false;

async function processExpiredDeletions(isLaunch = false) {
    if (processingQueue) return;
    processingQueue = true;
    try {
        const queue = getPendingQueue();
        if (queue.length === 0) return;

        const now = Date.now();
        const expired = queue.filter(e => e.deleteAt <= now);
        const pending = queue.filter(e => e.deleteAt > now);

        if (expired.length > 0) {
            logger.info(`Purging ${expired.length} expired message${expired.length === 1 ? "" : "s"}${isLaunch ? " from prior session" : ""}`);
            for (const entry of expired) {
                await deleteMessage(entry.channelId, entry.messageId);
                await sleep(LAUNCH_PURGE_DELAY);
            }
            savePendingQueue(pending);
        }

        for (const entry of pending) {
            const delay = entry.deleteAt - now;
            if (delay <= SCHEDULE_WINDOW_MS) scheduleDeletion(entry, delay);
        }
    } catch (e) {
        logger.error("Queue error", e);
    } finally {
        processingQueue = false;
    }
}

let queueInterval: ReturnType<typeof setInterval> | null = null;

function clearQueue() {
    scheduledTimers.forEach(t => clearTimeout(t));
    scheduledTimers.clear();
    savePendingQueue([]);
    showToast("Pending deletions cleared", Toasts.Type.SUCCESS);
}

function TimerIcon({ width = 20, height = 20, className }: { width?: number; height?: number; className?: string; }) {
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="13" r="8" stroke="currentColor" strokeWidth="2" />
            <path d="M12 9v4l2.5 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 2h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M12 2v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M18.5 5.5l1 -1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

function ClockSmallIcon({ className }: { className?: string; }) {
    return (
        <svg className={className} viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z" />
        </svg>
    );
}

type TimeUnit = "seconds" | "minutes" | "hours" | "days";

interface Preset {
    label: string;
    ms: number;
}

const PRESETS: Preset[] = [
    { label: "30s", ms: 30_000 },
    { label: "1 min", ms: 60_000 },
    { label: "5 min", ms: 5 * 60_000 },
    { label: "30 min", ms: 30 * 60_000 },
    { label: "1 hour", ms: 60 * 60_000 },
    { label: "6 hours", ms: 6 * 60 * 60_000 },
    { label: "1 day", ms: 24 * 60 * 60_000 },
    { label: "3 days", ms: 3 * 24 * 60 * 60_000 },
    { label: "1 week", ms: 7 * 24 * 60 * 60_000 },
];

function formatLifespan(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = m / 60;
    if (h < 24) return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`;
    const d = h / 24;
    return d % 1 === 0 ? `${d}d` : `${d.toFixed(1)}d`;
}

function unitFor(ms: number): TimeUnit {
    if (ms >= 24 * 60 * 60_000) return "days";
    if (ms >= 60 * 60_000) return "hours";
    if (ms >= 60_000) return "minutes";
    return "seconds";
}

function TimerSettingsModal({ modalProps }: { modalProps: { onClose(): void; transitionState: number; }; }) {
    const [active, setActiveLocal] = useState(settings.store.active);
    const [lifespan, setLifespan] = useState(settings.store.messageLifespan);
    const [unit, setUnit] = useState<TimeUnit>(unitFor(settings.store.messageLifespan));
    const [pending, setPending] = useState(getPendingQueue().length);

    useEffect(() => {
        const id = setInterval(() => setPending(getPendingQueue().length), 2000);
        return () => clearInterval(id);
    }, []);

    const applyLifespan = useCallback((ms: number) => {
        settings.store.messageLifespan = ms;
        setLifespan(ms);
        setUnit(unitFor(ms));
    }, []);

    const toggle = useCallback((val: boolean) => {
        settings.store.active = val;
        setActiveLocal(val);
        registerDock();
    }, []);

    const sliderConfig = {
        seconds: { markers: makeRange(5, 60, 5), min: 5, max: 60, initial: Math.max(5, Math.min(60, lifespan / 1000)), toMs: (v: number) => v * 1000, render: (v: number) => `${Math.round(v)}s` },
        minutes: { markers: makeRange(1, 60, 5), min: 1, max: 60, initial: Math.max(1, Math.min(60, lifespan / 60_000)), toMs: (v: number) => v * 60_000, render: (v: number) => `${Math.round(v)}m` },
        hours: { markers: makeRange(1, 24, 2), min: 1, max: 24, initial: Math.max(1, Math.min(24, lifespan / 3_600_000)), toMs: (v: number) => Math.round(v) * 3_600_000, render: (v: number) => `${Math.round(v)}h` },
        days: { markers: makeRange(1, 14, 1), min: 1, max: 14, initial: Math.max(1, Math.min(14, lifespan / 86_400_000)), toMs: (v: number) => Math.round(v) * 86_400_000, render: (v: number) => `${Math.round(v)}d` },
    };
    const cfg = sliderConfig[unit];

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM} className={cl("modal")}>
            <ModalHeader className={cl("header")}>
                <div className={cl("title-row")}>
                    <div className={cl("title-icon")}>
                        <TimerIcon width={22} height={22} />
                    </div>
                    <div className={cl("title-text")}>
                        <Span size="lg" weight="bold" color="text-default">Message Timer</Span>
                        <Span size="xs" color="text-muted">Auto-delete your messages after a chosen duration</Span>
                    </div>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <div className={cl("body")}>
                <ScrollerThin fade className={cl("scroller")}>
                    <div className={cl("content")}>
                        <Card className={classes(cl("master"), active ? cl("master-on") : cl("master-off"))} variant={active ? "brand" : "primary"}>
                            <div className={cl("master-inner")}>
                                <div className={cl("master-info")}>
                                    <ClockSmallIcon className={cl("master-icon")} />
                                    <div>
                                        <Span size="md" weight="bold" color="text-default">
                                            {active ? "Timer Active" : "Timer Disabled"}
                                        </Span>
                                        <br />
                                        <Span size="xs" color="text-muted">
                                            {active ? `Deleting after ${formatLifespan(lifespan)}` : "Messages are not being auto-deleted"}
                                        </Span>
                                        {pending > 0 && (
                                            <>
                                                {" · "}
                                                <span className={cl("pending-badge")}>
                                                    <Span size="xs" color="text-muted">{pending} pending</Span>
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>
                                <FormSwitch title="" value={active} onChange={toggle} hideBorder />
                            </div>
                        </Card>

                        <div className={cl("section-label")}>
                            <Span size="sm" weight="bold" color="text-muted">QUICK PRESETS</Span>
                        </div>

                        <div className={cl("presets")}>
                            {PRESETS.map(p => (
                                <button
                                    key={p.label}
                                    type="button"
                                    className={classes(cl("preset"), lifespan === p.ms && cl("preset-active"))}
                                    onClick={() => applyLifespan(p.ms)}
                                >
                                    <Span size="md" weight={lifespan === p.ms ? "bold" : "semibold"} color={lifespan === p.ms ? "text-default" : "text-subtle"}>
                                        {p.label}
                                    </Span>
                                </button>
                            ))}
                        </div>

                        <div className={cl("section-label")}>
                            <Span size="sm" weight="bold" color="text-muted">CUSTOM DURATION</Span>
                        </div>

                        <Card className={cl("control")} variant="primary" outline>
                            <div className={cl("control-header")}>
                                <div className={cl("control-label")}>
                                    <Span size="md" weight="semibold" color="text-default">Time Unit</Span>
                                    <Span size="xs" color="text-muted">Scale for the duration slider</Span>
                                </div>
                            </div>
                            <div className={cl("unit-select")}>
                                <Select
                                    options={[
                                        { label: "Seconds", value: "seconds" },
                                        { label: "Minutes", value: "minutes" },
                                        { label: "Hours", value: "hours" },
                                        { label: "Days", value: "days" },
                                    ]}
                                    select={(v: string) => setUnit(v as TimeUnit)}
                                    isSelected={(v: string) => v === unit}
                                    serialize={String}
                                    placeholder="Time unit"
                                />
                            </div>
                        </Card>

                        <Card className={cl("control")} variant="primary" outline>
                            <div className={cl("control-header")}>
                                <div className={cl("control-label")}>
                                    <Span size="md" weight="semibold" color="text-default">Duration</Span>
                                    <Span size="xs" color="text-muted">How long before your messages are deleted</Span>
                                </div>
                                <Span size="lg" weight="bold" color="text-default" className={cl("control-value")}>
                                    {formatLifespan(lifespan)}
                                </Span>
                            </div>
                            <div className={cl("control-slider")}>
                                <Slider
                                    disabled={false}
                                    markers={cfg.markers}
                                    minValue={cfg.min}
                                    maxValue={cfg.max}
                                    initialValue={cfg.initial}
                                    onValueChange={debounce((v: number) => applyLifespan(cfg.toMs(v)), 50)}
                                    onValueRender={cfg.render}
                                    onMarkerRender={cfg.render}
                                    stickToMarkers={unit === "hours" || unit === "days"}
                                />
                            </div>
                        </Card>

                        <Divider />

                        <Card className={cl("hint")} variant="primary">
                            <Span size="xs" color="text-muted">
                                Messages are tracked persistently across restarts. Anything past its deadline when Discord reopens is purged on launch with a {LAUNCH_PURGE_DELAY / 1000}s delay between deletes.
                            </Span>
                        </Card>

                        {pending > 0 && (
                            <Card className={cl("hint")} variant="warning">
                                <div className={cl("queue-row")}>
                                    <Span size="sm" color="text-default">{pending} message{pending === 1 ? "" : "s"} pending deletion</Span>
                                    <Button size="sm" variant="secondary" onClick={() => { clearQueue(); setPending(0); }}>Clear queue</Button>
                                </div>
                            </Card>
                        )}
                    </div>
                </ScrollerThin>
            </div>

            <ModalFooter>
                <div className={cl("footer")}>
                    <Span size="xs" color="text-muted" className={cl("keybind-hint")}>
                        {settings.store.keybind}
                    </Span>
                    <Button variant="secondary" onClick={modalProps.onClose}>Done</Button>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}

function openTimerModal() {
    openModal(modalProps => <TimerSettingsModal modalProps={modalProps} />);
}

function renderChatContextEntry() {
    settings.use(["active", "excludedChannels"]);
    const channel = getCurrentChannel();
    if (!channel) return null;
    const isExcluded = getExcludedList(settings.store.excludedChannels).includes(channel.id);
    const enabled = settings.store.active;
    return (
        <Menu.MenuItem id="msg-timer" label="Message Timer">
            <Menu.MenuCheckboxItem
                id="mt-exclude-channel"
                label="Exclude this channel"
                action={() => {
                    settings.store.excludedChannels = toggleExclusion(settings.store.excludedChannels, channel.id);
                }}
                checked={isExcluded}
            />
            <Menu.MenuCheckboxItem
                id="mt-enabled"
                label="Enabled"
                action={() => setActive(!enabled)}
                checked={enabled}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem id="mt-settings" label="Settings" action={openTimerModal} />
        </Menu.MenuItem>
    );
}

function renderGuildContextEntry(guild: any) {
    settings.use(["active", "excludedServers"]);
    if (!guild) return null;
    const isExcluded = getExcludedList(settings.store.excludedServers).includes(guild.id);
    const enabled = settings.store.active;
    return (
        <Menu.MenuItem id="msg-timer" label="Message Timer">
            <Menu.MenuCheckboxItem
                id="mt-exclude-server"
                label="Exclude this server"
                action={() => {
                    settings.store.excludedServers = toggleExclusion(settings.store.excludedServers, guild.id);
                }}
                checked={isExcluded}
            />
            <Menu.MenuCheckboxItem
                id="mt-enabled"
                label="Enabled"
                action={() => setActive(!enabled)}
                checked={enabled}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem id="mt-settings" label="Settings" action={openTimerModal} />
        </Menu.MenuItem>
    );
}

function registerDock() {
    const pendingCount = getPendingQueue().length;
    const status = settings.store.active ? "ON" : "OFF";
    addDockButton("messageTimer", {
        icon: TimerIcon,
        tooltipText: pendingCount > 0
            ? `Message Timer (${status}) · ${pendingCount} pending`
            : `Message Timer (${status})`,
        glowing: settings.store.active,
        glowColor: "green",
        onClick: () => setActive(!settings.store.active),
        onContextMenu: e => {
            e.preventDefault();
            openTimerModal();
        },
    });
}

export default definePlugin({
    name: "Message Timer",
    description: "Auto-deletes your messages after a configurable lifespan. Persists across restarts, purges overdue messages on launch.",
    authors: [{ name: "gabe", id: 1467949308816003193n }],
    dependencies: ["PluginDock"],
    settings,
    openSettingsModal: openTimerModal,
    start() {
        registerDock();
        addChatInputContextEntry("messageTimer", renderChatContextEntry);
        addGuildContextEntry("messageTimer", renderGuildContextEntry);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        document.addEventListener("keydown", handleKeybind, true);
        setTimeout(() => processExpiredDeletions(true), 3000);
        queueInterval = setInterval(() => processExpiredDeletions(false), PERIODIC_INTERVAL_MS);
    },
    stop() {
        removeDockButton("messageTimer");
        removeChatInputContextEntry("messageTimer");
        removeGuildContextEntry("messageTimer");
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        document.removeEventListener("keydown", handleKeybind, true);
        if (queueInterval) {
            clearInterval(queueInterval);
            queueInterval = null;
        }
        scheduledTimers.forEach(t => clearTimeout(t));
        scheduledTimers.clear();
    },
});
