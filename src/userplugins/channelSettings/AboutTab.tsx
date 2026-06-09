/*
 * Equicord, a Discord client mod
 * Copyright (c) 2026 Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { fetchUserProfile, openUserProfile } from "@utils/discord";
import { findStoreLazy } from "@webpack";
import { IconUtils, useEffect, useMemo, useState, UserStore, UserUtils } from "@webpack/common";

import { cl, getKeybindSettings, getMyPlugins, MY_DISCORD_ID } from "./shared";

const UserProfileStore = findStoreLazy("UserProfileStore") as {
    getUserProfile(id: string): {
        banner?: string;
        accentColor?: number;
        themeColors?: [number, number]; // [primary, secondary]
        bio?: string;
        profileEffectId?: string;
    } | undefined;
};

export function AboutTab() {
    const stats = useMemo(() => {
        const plugins = getMyPlugins();
        const enabled = plugins.filter(p => isPluginEnabled(p.name)).length;
        const keybinds = Array.from(getKeybindSettings().values()).reduce((sum, arr) => sum + arr.length, 0);
        return { total: plugins.length, enabled, keybinds };
    }, []);

    const [user, setUser] = useState(() => UserStore.getUser(MY_DISCORD_ID) || null);
    const [profile, setProfile] = useState(() => UserProfileStore.getUserProfile?.(MY_DISCORD_ID));

    useEffect(() => {
        if (!user) UserUtils.getUser?.(MY_DISCORD_ID).then(u => setUser(u)).catch(() => { });
        if (!profile?.banner) {
            fetchUserProfile(MY_DISCORD_ID).then(() => {
                setProfile(UserProfileStore.getUserProfile?.(MY_DISCORD_ID));
            }).catch(() => { });
        }
    }, []);

    const avatar = user?.getAvatarURL?.(undefined, 256, true) ?? IconUtils.getDefaultAvatarURL(MY_DISCORD_ID);
    const banner = profile?.banner
        ? IconUtils.getUserBannerURL?.({ id: MY_DISCORD_ID, banner: profile.banner, canAnimate: true, size: 600 })
        : null;
    const displayName = (user as any)?.globalName || user?.username || "gabe";
    const username = user?.username ? `@${user.username}` : "@gabe";
    const themeColors = profile?.themeColors;
    const accentHex = profile?.accentColor != null
        ? "#" + profile.accentColor.toString(16).padStart(6, "0")
        : ((user as any)?.accentColor != null
            ? "#" + (user as any).accentColor.toString(16).padStart(6, "0")
            : null);

    return (
        <div className={cl("about-wrap")}>
            <div
                className={cl("about-profile")}
                style={(() => {
                    const s: Record<string, string> = {};
                    if (accentHex) s["--vc-profile-accent"] = accentHex;
                    if (themeColors) {
                        s["--vc-profile-theme-1"] = "#" + themeColors[0].toString(16).padStart(6, "0");
                        s["--vc-profile-theme-2"] = "#" + themeColors[1].toString(16).padStart(6, "0");
                    }
                    return s;
                })() as any}
                onClick={() => openUserProfile(MY_DISCORD_ID)}
                role="button"
                tabIndex={0}
            >
                <div
                    className={cl("about-profile-banner") + (banner ? " " + cl("about-profile-banner-img") : "")}
                    style={banner ? { backgroundImage: `url(${banner})` } : undefined}
                />
                <div className={cl("about-profile-body")}>
                    <div className={cl("about-profile-avatar-ring")}>
                        <img className={cl("about-profile-avatar")} src={avatar} alt="" />
                    </div>
                    <div className={cl("about-profile-text")}>
                        <div className={cl("about-profile-name")}>{displayName}</div>
                        <div className={cl("about-profile-handle")}>{username}</div>
                    </div>
                    <div className={cl("about-profile-cta")}>View profile →</div>
                </div>
            </div>

            <div className={cl("about-stats")}>
                <div className={cl("about-stat")}>
                    <div className={cl("about-stat-value")}>{stats.total}</div>
                    <div className={cl("about-stat-label")}>Plugins</div>
                </div>
                <div className={cl("about-stat")}>
                    <div className={cl("about-stat-value")}>{stats.enabled}</div>
                    <div className={cl("about-stat-label")}>Enabled</div>
                </div>
                <div className={cl("about-stat")}>
                    <div className={cl("about-stat-value")}>{stats.keybinds}</div>
                    <div className={cl("about-stat-label")}>Keybinds</div>
                </div>
            </div>
            <div className={cl("about-blurb")}>
                ChannelSettings gives you one place to manage all your plugins. Any Discord channel you own can become a settings page by pasting its ID into this plugin's settings.
            </div>
        </div>
    );
}
