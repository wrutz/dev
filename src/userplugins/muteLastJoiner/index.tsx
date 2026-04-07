/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { Toasts, UserStore } from "@webpack/common";

const logger = new Logger("LocalMuteLastJoiner");

const SelectedChannelStore = findStoreLazy("SelectedChannelStore") as {
    getVoiceChannelId(): string | null;
} | null;

const VoiceStateStore = findStoreLazy("VoiceStateStore") as {
    getVoiceStatesForChannel(channelId: string): Record<string, unknown>;
} | null;

// Current Discord builds appear to expose local voice controls through methods
// named like these. If Discord changes internals, these lookups are the first
// place to adjust.
const MediaEngineStore = findByPropsLazy("isLocalMute", "getLocalVolume") as {
    isLocalMute(userId: string, context?: unknown): boolean;
    getLocalVolume?(userId: string, context?: unknown): number;
} | null;

const MediaEngineActions = findByPropsLazy("toggleLocalMute", "setLocalVolume") as {
    toggleLocalMute(userId: string, context?: unknown): void;
    setLocalVolume?(userId: string, volume: number, context?: unknown): void;
} | null;

const settings = definePluginSettings({
    triggerKey: {
        type: OptionType.STRING,
        description: "Main key for the shortcut. Example: M, F8, Pause, Enter",
        default: "M"
    },
    requireCtrl: {
        type: OptionType.BOOLEAN,
        description: "Require Ctrl",
        default: true
    },
    requireAlt: {
        type: OptionType.BOOLEAN,
        description: "Require Alt",
        default: true
    },
    requireShift: {
        type: OptionType.BOOLEAN,
        description: "Require Shift",
        default: false
    },
    useVolumeFallback: {
        type: OptionType.BOOLEAN,
        description: "If local mute lookup fails, set the target's local volume to 0 as a fallback",
        default: true
    }
});

type FluxVoiceState = {
    userId: string;
    channelId: string | null;
    oldChannelId?: string | null;
};

const joinHistoryByChannel = new Map<string, string[]>();

function toast(message: string, type: number) {
    Toasts.show({
        id: Toasts.genId(),
        message,
        type
    });
}

function normalizeKey(key: string) {
    const k = key.trim().toLowerCase();

    switch (k) {
        case " ":
            return "space";
        case "esc":
            return "escape";
        default:
            return k;
    }
}

function eventKey(e: KeyboardEvent) {
    return normalizeKey(e.key);
}

function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;

    const tag = target.tagName;
    return target.isContentEditable
        || tag === "INPUT"
        || tag === "TEXTAREA"
        || tag === "SELECT";
}

function removeUserFromChannelHistory(channelId: string, userId: string) {
    const history = joinHistoryByChannel.get(channelId);
    if (!history) return;

    const next = history.filter(id => id !== userId);
    if (next.length) joinHistoryByChannel.set(channelId, next);
    else joinHistoryByChannel.delete(channelId);
}

function addUserToChannelHistory(channelId: string, userId: string) {
    const history = joinHistoryByChannel.get(channelId) ?? [];
    const next = history.filter(id => id !== userId);
    next.push(userId);
    joinHistoryByChannel.set(channelId, next);
}

function getTrackedLastJoiner(channelId: string): string | null {
    if (!VoiceStateStore) return null;

    const myId = UserStore.getCurrentUser()?.id;
    const currentStates = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
    const currentIds = new Set(Object.keys(currentStates));

    const history = joinHistoryByChannel.get(channelId);
    if (!history?.length) return null;

    for (let i = history.length - 1; i >= 0; i--) {
        const userId = history[i];
        if (userId !== myId && currentIds.has(userId)) {
            return userId;
        }
    }

    return null;
}

function muteTrackedLastJoinerLocally() {
    const channelId = SelectedChannelStore?.getVoiceChannelId();
    if (!channelId) {
        toast("You are not in a voice channel.", Toasts.Type.FAILURE);
        return;
    }

    const targetUserId = getTrackedLastJoiner(channelId);
    if (!targetUserId) {
        toast("No tracked last joiner yet. Someone needs to join after the plugin loads.", Toasts.Type.FAILURE);
        return;
    }

    const user = UserStore.getUser(targetUserId);
    const displayName = user?.globalName || user?.username || "that user";

    try {
        if (MediaEngineStore?.isLocalMute && MediaEngineActions?.toggleLocalMute) {
            if (MediaEngineStore.isLocalMute(targetUserId)) {
                toast(`${displayName} is already locally muted.`, Toasts.Type.SUCCESS);
                return;
            }

            MediaEngineActions.toggleLocalMute(targetUserId);
            toast(`Locally muted ${displayName}.`, Toasts.Type.SUCCESS);
            return;
        }

        if (settings.store.useVolumeFallback && MediaEngineActions?.setLocalVolume) {
            // 0 is silence for the local volume path.
            MediaEngineActions.setLocalVolume(targetUserId, 0);
            toast(`Set ${displayName}'s local volume to 0.`, Toasts.Type.SUCCESS);
            return;
        }

        toast("Could not find Discord's local mute functions on this build.", Toasts.Type.FAILURE);
    } catch (err) {
        logger.error("Failed to locally mute last joiner:", err);
        toast(`Failed to locally mute ${displayName}.`, Toasts.Type.FAILURE);
    }
}

function matchesHotkey(e: KeyboardEvent) {
    const triggerKey = normalizeKey(settings.store.triggerKey || "");
    if (!triggerKey) return false;

    return eventKey(e) === triggerKey
        && e.ctrlKey === settings.store.requireCtrl
        && e.altKey === settings.store.requireAlt
        && e.shiftKey === settings.store.requireShift
        && !e.metaKey;
}

function onKeyDown(e: KeyboardEvent) {
    if (e.repeat) return;
    if (isTypingTarget(e.target)) return;
    if (!matchesHotkey(e)) return;

    e.preventDefault();
    e.stopPropagation();

    muteTrackedLastJoinerLocally();
}

export default definePlugin({
    name: "LocalMuteLastJoiner",
    description: "Locally mutes the last user who joined your current voice channel with a keybind.",
    authors: [{
        name: "Your Name",
        id: 0n
    }],
    settings,

    start() {
        joinHistoryByChannel.clear();
        document.addEventListener("keydown", onKeyDown);
    },

    stop() {
        document.removeEventListener("keydown", onKeyDown);
        joinHistoryByChannel.clear();
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: FluxVoiceState[]; }) {
            const myId = UserStore.getCurrentUser()?.id;

            for (const { userId, channelId, oldChannelId } of voiceStates) {
                if (!userId || userId === myId) continue;

                if (oldChannelId && oldChannelId !== channelId) {
                    removeUserFromChannelHistory(oldChannelId, userId);
                }

                if (channelId && channelId !== oldChannelId) {
                    addUserToChannelHistory(channelId, userId);
                }
            }
        }
    }
});