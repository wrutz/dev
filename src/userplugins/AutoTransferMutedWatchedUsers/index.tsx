/*
 * Vencord / Equicord user plugin
 * Auto transfers watched users when they join your current voice channel.
 */

import { definePluginSettings } from "@api/Settings";
import { getCurrentChannel } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelStore, Toasts, UserStore } from "@webpack/common";

const VoiceStateStore = findStoreLazy("VoiceStateStore");
const MessageCreator = findByPropsLazy("sendMessage", "getSendMessageOptionsForReply");
const PendingReplyStore = findByPropsLazy("getPendingReply");

type VoiceState = {
    userId: string;
    channelId?: string | null;
};

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Enable the automation",
        default: true
    },
    watchedUsers: {
        type: OptionType.STRING,
        description: "Comma separated usernames or global display names to watch",
        default: ""
    },
    triggerCommand: {
        type: OptionType.STRING,
        description: "Command sent into the voice channel chat",
        default: "!vc"
    },
    actionLabel: {
        type: OptionType.STRING,
        description: "Button label to click on the controller message",
        default: "Transfer"
    },
    selectPromptText: {
        type: OptionType.STRING,
        description: "Part of the followup message text that contains the dropdown",
        default: "Select a member to"
    },
    pollMs: {
        type: OptionType.SLIDER,
        description: "How often to scan your current voice channel for joins",
        default: 1200,
        markers: [500, 800, 1200, 1600, 2000],
        stickToMarkers: false
    },
    uiTimeoutMs: {
        type: OptionType.SLIDER,
        description: "How long to wait for the controller UI",
        default: 12000,
        markers: [4000, 8000, 12000, 16000, 20000],
        stickToMarkers: false
    },
    debugToasts: {
        type: OptionType.BOOLEAN,
        description: "Show toast messages while the automation runs",
        default: true
    }
});

let intervalId: number | null = null;
let lastChannelId: string | null = null;
let previousMembers = new Set<string>();
const inFlightUsers = new Set<string>();

function normalize(value: string | null | undefined): string {
    return (value ?? "").trim().toLowerCase();
}

function watchedSet(): Set<string> {
    return new Set(
        settings.store.watchedUsers
            .split(",")
            .map(normalize)
            .filter(Boolean)
    );
}

function showToast(message: string) {
    if (!settings.store.debugToasts) return;

    try {
        Toasts.show({
            message,
            id: `auto-transfer-${Date.now()}`,
            type: Toasts.Type?.MESSAGE ?? 0
        });
    } catch {
        console.log("[AutoTransferWatchedUsers]", message);
    }
}

function getCurrentVoiceChannelId(): string | null {
    const me = UserStore.getCurrentUser();
    if (!me) return null;

    const myVoiceState = VoiceStateStore.getVoiceStateForUser(me.id) as VoiceState | undefined;
    return myVoiceState?.channelId ?? null;
}

function getVoiceStatesForCurrentChannel(): VoiceState[] {
    const channelId = getCurrentVoiceChannelId();
    if (!channelId) return [];

    const states = VoiceStateStore.getVoiceStatesForChannel(channelId) as Record<string, VoiceState> | undefined;
    if (!states) return [];

    return Object.values(states);
}

function getUserNames(userId: string): string[] {
    const user = UserStore.getUser(userId);
    if (!user) return [];

    return [user.username, user.globalName, user.displayName]
        .filter(Boolean)
        .map((x: string) => x.trim())
        .filter(Boolean);
}

function isWatchedUser(userId: string): boolean {
    const watch = watchedSet();
    if (!watch.size) return false;

    return getUserNames(userId).some(name => watch.has(normalize(name)));
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function visibleText(element: Element | null | undefined): string {
    return normalize(element?.textContent?.replace(/\s+/g, " "));
}

async function waitForElement<T extends Element>(finder: () => T | null | undefined, timeoutMs: number): Promise<T> {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        const found = finder();
        if (found) return found;
        await delay(120);
    }

    throw new Error("Timed out waiting for UI element");
}

function getNewestButtonByLabel(label: string): HTMLButtonElement | null {
    const target = normalize(label);
    const buttons = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
    const matches = buttons.filter(button => visibleText(button) === target);
    return matches.at(-1) ?? null;
}

function findLatestPromptContainer(promptText: string): HTMLElement | null {
    const target = normalize(promptText);
    const candidates = Array.from(document.querySelectorAll("[class], section, article, div")) as HTMLElement[];
    const matches = candidates.filter(node => visibleText(node).includes(target));
    return matches.at(-1) ?? null;
}

function findComboTrigger(root: ParentNode): HTMLElement | null {
    return (
        root.querySelector('[role="combobox"]') as HTMLElement | null
    ) ?? (
        root.querySelector('[aria-haspopup="listbox"]') as HTMLElement | null
    );
}

function clickElement(element: HTMLElement) {
    element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.click();
}

function findSearchInput(root?: ParentNode): HTMLInputElement | null {
    const scoped = root?.querySelector('input') as HTMLInputElement | null;
    if (scoped) return scoped;

    return document.querySelector('input[role="combobox"], input') as HTMLInputElement | null;
}

function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
}

function findOptionByNames(names: string[]): HTMLElement | null {
    const lowered = names.map(normalize).filter(Boolean);
    const selectors = [
        '[role="option"]',
        '[aria-selected]',
        '[id*="option"]',
        '[class*="option"]',
        '[class*="selectable"]',
        '[class*="item"]'
    ].join(", ");

    const options = Array.from(document.querySelectorAll(selectors)) as HTMLElement[];

    for (const option of options) {
        const text = visibleText(option);
        if (lowered.some(name => text === name || text.includes(name))) {
            return option;
        }
    }

    return null;
}

async function chooseUserFromDropdown(promptRoot: HTMLElement, names: string[]) {
    await chooseUserFromDropdown(promptRoot, names);
    showToast(`Selected ${names[0]} in transfer dropdown`);
}

async function handleNewJoin(state: VoiceState) {
    const me = UserStore.getCurrentUser();
    if (!me || state.userId === me.id) return;
    if (inFlightUsers.has(state.userId)) return;
    if (!isWatchedUser(state.userId)) return;

    inFlightUsers.add(state.userId);

    try {
        await clickTransferAndSelectUser(state.userId);
    } catch (error) {
        console.error("[AutoTransferWatchedUsers] Failed to automate transfer", error);
        showToast("Auto transfer failed. Open devtools for details.");
    } finally {
        await delay(1500);
        inFlightUsers.delete(state.userId);
    }
}

function tick() {
    if (!settings.store.enabled) return;

    const channelId = getCurrentVoiceChannelId();
    if (!channelId) {
        lastChannelId = null;
        previousMembers.clear();
        return;
    }

    const states = getVoiceStatesForCurrentChannel();
    const currentMembers = new Set(states.map(state => state.userId));

    if (lastChannelId !== channelId) {
        lastChannelId = channelId;
        previousMembers = currentMembers;
        return;
    }

    for (const state of states) {
        if (!previousMembers.has(state.userId)) {
            void handleNewJoin(state);
        }
    }

    previousMembers = currentMembers;
}

function startLoop() {
    stopLoop();
    intervalId = window.setInterval(tick, settings.store.pollMs);
    tick();
}

function stopLoop() {
    if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
    }
}

export default definePlugin({
    name: "AutoTransferWatchedUsers",
    description: "When a watched user joins your current voice channel, send !vc, click Transfer, and select that user.",
    authors: [{
        name: "Your Name",
        id: 0n
    }],
    settings,
    start() {
        startLoop();
    },
    stop() {
        stopLoop();
        lastChannelId = null;
        previousMembers.clear();
        inFlightUsers.clear();
    }
});
