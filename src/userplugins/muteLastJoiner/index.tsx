/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import {
    ChannelStore,
    PermissionStore,
    PermissionsBits,
    RestAPI,
    Toasts,
    UserStore,
    showToast
} from "@webpack/common";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const SelectedChannelStore = findStoreLazy("SelectedChannelStore") as {
    getVoiceChannelId(): string | null;
} | null;

const VoiceStateStore = findStoreLazy("VoiceStateStore") as {
    getVoiceStatesForChannel(channelId: string): Record<string, any>;
} | null;

/**
 * Per-channel join history.
 * The last item in the array is the newest tracked joiner still in that VC.
 *
 * Note:
 * This starts tracking from the moment the plugin is loaded.
 * It cannot know who joined "last" before the plugin started.
 */
const joinHistoryByChannel = new Map<string, string[]>();

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
    const states = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
    const currentIds = new Set(Object.keys(states));

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

async function muteTrackedLastJoiner() {
    const channelId = SelectedChannelStore?.getVoiceChannelId();
    if (!channelId) {
        showToast("You are not in a voice channel.", Toasts.Type.FAILURE);
        return;
    }

    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.guild_id) {
        showToast("This only works in guild voice channels.", Toasts.Type.FAILURE);
        return;
    }

    if (!PermissionStore.can(PermissionsBits.MUTE_MEMBERS, channel)) {
        showToast("You do not have Mute Members permission here.", Toasts.Type.FAILURE);
        return;
    }

    const targetUserId = getTrackedLastJoiner(channelId);
    if (!targetUserId) {
        showToast("No tracked joiner yet. Someone needs to join after the plugin loads.", Toasts.Type.MESSAGE);
        return;
    }

    const user = UserStore.getUser(targetUserId);
    const displayName = user?.globalName || user?.username || "that user";

    try {
        await RestAPI.patch({
            url: `/guilds/${channel.guild_id}/members/${targetUserId}`,
            body: { mute: true }
        });

        showToast(`Muted ${displayName}.`, Toasts.Type.SUCCESS);
    } catch (err) {
        console.error("[MuteLastJoiner] Failed to mute user:", err);
        showToast(`Failed to mute ${displayName}.`, Toasts.Type.FAILURE);
    }
}

function getIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Zm5-3a1 1 0 1 0-2 0 3 3 0 1 1-6 0 1 1 0 1 0-2 0 5 5 0 0 0 4 4.9V21H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-1.1A5 5 0 0 0 17 11Z"
            />
            <path
                fill="var(--status-danger)"
                d="M3.7 2.3a1 1 0 0 0-1.4 1.4l18 18a1 1 0 0 0 1.4-1.4l-18-18Z"
            />
        </svg>
    );
}

function MuteLastJoinerButton() {
    const onClick = () => {
        void muteTrackedLastJoiner();
    };

    if (!PanelButton) {
        return <Button onClick={onClick}>Mute last joiner</Button>;
    }

    return (
        <PanelButton
            tooltipText="Mute last joined user"
            icon={getIcon()}
            onClick={onClick}
        />
    );
}

interface FluxVoiceState {
    userId: string;
    channelId: string | null;
    oldChannelId?: string | null;
}

export default definePlugin({
    name: "MuteLastJoiner",
    description: "Adds a voice panel button that mutes the last user who joined your current VC.",
    authors: [{
        name: "your_name",
        id: 0n
    }],

    start() {
        joinHistoryByChannel.clear();
    },

    stop() {
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
    },

    patches: [
        {
            find: "renderNoiseCancellation",
            replacement: {
                match: /children:\[(?=\i\?this\.renderNoiseCancellation\(\))/,
                replace: "$&$self.muteLastJoinerButton(),"
            }
        }
    ],

    muteLastJoinerButton: ErrorBoundary.wrap(MuteLastJoinerButton, { noop: true })
});