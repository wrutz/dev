/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { playAudio } from "@api/AudioPlayer";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { GuildMemberStore, GuildRoleStore, GuildStore, Toasts, UserStore, VoiceStateStore } from "@webpack/common";
import type { Guild, GuildMember } from "discord-types/general";

import { addDockButton, removeDockButton } from "../pluginDock";

const settings = definePluginSettings({
    active: {
        description: "AntiMod alert active.",
        type: OptionType.BOOLEAN,
        default: true,
        onChange: () => { try { registerDockButton(); } catch { } },
    },
});

function BellIcon({ colorClass, width, height }: { color?: string; colorClass?: string; width?: number; height?: number; }) {
    return (
        <svg className={colorClass} width={width ?? 20} height={height ?? 20} viewBox="0 0 24 24" fill="currentColor">
            <path d="M9.7 2.89c.18-.07.32-.24.37-.43a2 2 0 0 1 3.86 0c.05.2.19.36.38.43A7 7 0 0 1 19 9.5v2.09c0 .12.05.24.13.33l1.1 1.22a3 3 0 0 1 .77 2.01v.28c0 .67-.34 1.29-.95 1.56-1.31.6-4 1.51-8.05 1.51-4.05 0-6.74-.91-8.05-1.5-.61-.28-.95-.9-.95-1.57v-.28a3 3 0 0 1 .77-2l1.1-1.23a.5.5 0 0 0 .13-.33V9.5a7 7 0 0 1 4.7-6.61ZM9.18 19.84A.16.16 0 0 0 9 20a3 3 0 1 0 6 0c0-.1-.09-.17-.18-.16a24.86 24.86 0 0 1-5.64 0Z" />
        </svg>
    );
}

const MOD_ALERT_SOUND_URL = "https://www.myinstants.com/media/sounds/tmp_7901-951678082.mp3";

const MOD_PERMISSION_BITS: bigint[] = [
    (1n << 3n), (1n << 2n), (1n << 1n), (1n << 24n), (1n << 22n), (1n << 23n),
    (1n << 7n), (1n << 5n), (1n << 28n), (1n << 40n), (1n << 4n),
];

function getMemberEffectivePermissions(guild: Guild | undefined, member: GuildMember | null | undefined): bigint {
    if (!guild || !member) return 0n;
    if (guild.ownerId === member.userId) return MOD_PERMISSION_BITS.reduce((a, b) => a | b, 0n);
    const memberRoles = GuildRoleStore.getSortedRoles(guild.id)
        .filter(role => role.id === guild.id || member.roles.includes(role.id));
    return memberRoles.reduce((acc, role) => acc | (role.permissions ?? 0n), 0n);
}

function hasAnyModPermission(permissions: bigint): boolean {
    return MOD_PERMISSION_BITS.some(bit => (permissions & bit) === bit);
}

function hasModInChannel(channelId: string, guildId: string | undefined, myUserId: string): boolean {
    if (!guildId) return false;
    const guild = GuildStore.getGuild(guildId);
    const states = VoiceStateStore.getVoiceStatesForChannel(channelId);
    for (const vs of Object.values(states)) {
        if (vs.userId === myUserId) continue;
        const member = GuildMemberStore.getMember(guildId, vs.userId);
        if (hasAnyModPermission(getMemberEffectivePermissions(guild, member))) return true;
    }
    return false;
}

function getModLabelsInChannel(channelId: string, guildId: string | undefined, excludeUserId: string): string[] {
    if (!guildId) return [];
    const guild = GuildStore.getGuild(guildId);
    const states = VoiceStateStore.getVoiceStatesForChannel(channelId);
    const labels: string[] = [];
    for (const vs of Object.values(states)) {
        if (vs.userId === excludeUserId) continue;
        const member = GuildMemberStore.getMember(guildId, vs.userId);
        if (!hasAnyModPermission(getMemberEffectivePermissions(guild, member))) continue;
        const user = UserStore.getUser(vs.userId);
        const username = user?.username ?? vs.userId;
        const displayName = member?.nick ?? user?.globalName;
        labels.push(displayName ? `${username} (${displayName})` : username);
    }
    return labels;
}

function getModLabel(userId: string, guildId: string | undefined): string {
    const user = UserStore.getUser(userId);
    const member = guildId ? GuildMemberStore.getMember(guildId, userId) : null;
    const username = user?.username ?? userId;
    const displayName = member?.nick ?? user?.globalName;
    return displayName ? `${username} (${displayName})` : username;
}

let clientOldChannelId: string | undefined;

function registerDockButton() {
    addDockButton("antimod", {
        icon: BellIcon,
        tooltipText: "AntiMod Alert",
        glowing: settings.store.active,
        glowColor: "green",
        onClick: () => {
            settings.store.active = !settings.store.active;
            registerDockButton();
        },
    });
}

function showModAlert(message: string) {
    if (!settings.store.active) return;
    Toasts.show({
        message,
        id: "antimod-vc",
        type: Toasts.Type.FAILURE,
        options: { position: Toasts.Position.BOTTOM },
    });
    playAudio(MOD_ALERT_SOUND_URL);
}

export default definePlugin({
    name: "AntiMod",
    description: "Plays a sound when you join a voice channel that has a mod in it, or when a mod joins your voice channel.",
    authors: [{ name: "gabe", id: 1467949308816003193n }],
    dependencies: ["AudioPlayerAPI", "PluginDock"],
    settings,

    start() {
        registerDockButton();
    },

    stop() {
        removeDockButton("antimod");
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId?: string; channelId?: string | null; oldChannelId?: string | null; guildId?: string }> }) {
            const myId = UserStore.getCurrentUser().id;
            const myVoiceChannelId = VoiceStateStore.getVoiceStateForUser(myId)?.channelId;

            for (const state of voiceStates ?? []) {
                const { userId, channelId, oldChannelId, guildId } = state;
                if (!channelId || !guildId) continue;

                if (userId === myId) {
                    let prevChannelId = state.oldChannelId;
                    if (channelId !== clientOldChannelId) {
                        prevChannelId = clientOldChannelId;
                        clientOldChannelId = channelId ?? undefined;
                    }
                    if (prevChannelId === channelId) continue;
                    if (!hasModInChannel(channelId, guildId, myId)) continue;
                    const labels = getModLabelsInChannel(channelId, guildId, myId);
                    showModAlert(`MOD ALERT: ${labels.join(", ")} in this voice channel.`);
                    continue;
                }

                if (!("oldChannelId" in state) || channelId === oldChannelId) continue;
                if (channelId !== myVoiceChannelId) continue;
                const member = GuildMemberStore.getMember(guildId, userId);
                const guild = GuildStore.getGuild(guildId);
                if (!hasAnyModPermission(getMemberEffectivePermissions(guild, member))) continue;
                showModAlert(`MOD ALERT: ${getModLabel(userId, guildId)} joined.`);
            }
        },
    },
});


