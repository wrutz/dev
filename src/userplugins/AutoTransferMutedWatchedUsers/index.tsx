/*
 * Vencord / Equicord user plugin
 * Auto transfers watched users when they join your current voice channel.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelStore, Toasts, UserStore } from "@webpack/common";

const VoiceStateStore = findStoreLazy("VoiceStateStore");
const SelectedChannelStore = findStoreLazy("SelectedChannelStore");
const MessageActions = findByPropsLazy("sendMessage", "editMessage");

type VoiceState = {
    userId: string;
    channelId?: string | null;
};

type SelectedChannelStoreType = {
    getChannelId?: () => string | null;
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
    commandChannelId: {
        type: OptionType.STRING,
        description: "Optional channel ID to send the trigger command into. Leave blank to use the currently open chat.",
        default: ""
    },
    preferSelectedChat: {
        type: OptionType.BOOLEAN,
        description: "Send the trigger command to the currently open chat first",
        default: true
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
    preClickDelayMs: {
        type: OptionType.SLIDER,
        description: "Delay after sending the trigger command before searching for the controller button",
        default: 500,
        markers: [0, 250, 500, 750, 1000, 1500],
        stickToMarkers: false
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
            id: Toasts.genId?.() ?? `auto-transfer-${Date.now()}`,
            type: Toasts.Type?.MESSAGE ?? 0
        });
    } catch {
        console.log("[AutoTransferMutedWatchedUsers]", message);
    }
}

function getCurrentVoiceChannelId(): string | null {
    const me = UserStore.getCurrentUser();
    if (!me) return null;

    const myVoiceState = VoiceStateStore.getVoiceStateForUser(me.id) as VoiceState | undefined;
    return myVoiceState?.channelId ?? null;
}

function getSelectedChannelId(): string | null {
    try {
        return (SelectedChannelStore as SelectedChannelStoreType)?.getChannelId?.() ?? null;
    } catch {
        return null;
    }
}

function getCommandTargetChannelId(): string | null {
    const override = settings.store.commandChannelId.trim();
    if (override) return override;

    if (settings.store.preferSelectedChat) {
        const selectedId = getSelectedChannelId();
        if (selectedId) return selectedId;
    }

    return getCurrentVoiceChannelId();
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

function isVisible(element: Element | null | undefined): element is HTMLElement {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function fireClick(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const pointerInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX,
        clientY,
        pointerType: "mouse"
    };
    const mouseInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 1,
        clientX,
        clientY
    };

    element.dispatchEvent(new MouseEvent("mouseover", mouseInit));
    element.dispatchEvent(new MouseEvent("mousemove", mouseInit));

    if (typeof PointerEvent !== "undefined") {
        element.dispatchEvent(new PointerEvent("pointerover", pointerInit));
        element.dispatchEvent(new PointerEvent("pointerenter", pointerInit));
        element.dispatchEvent(new PointerEvent("pointermove", pointerInit));
        element.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
    }

    element.dispatchEvent(new MouseEvent("mousedown", mouseInit));
    element.focus();

    if (typeof PointerEvent !== "undefined") {
        element.dispatchEvent(new PointerEvent("pointerup", { ...pointerInit, buttons: 0 }));
    }

    element.dispatchEvent(new MouseEvent("mouseup", { ...mouseInit, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...mouseInit, buttons: 0 }));
    HTMLElement.prototype.click.call(element);
}

function findComboTrigger(root: ParentNode): HTMLElement | null {
    const exact = root.querySelector('[role="button"][aria-haspopup="listbox"]') as HTMLElement | null;
    if (isVisible(exact)) return exact;

    const explicit = Array.from(root.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]')) as HTMLElement[];
    const visibleExplicit = explicit.filter(isVisible);
    if (visibleExplicit.length) return visibleExplicit.at(-1) ?? null;

    const fallbackButtons = Array.from(root.querySelectorAll('button, [role="button"]')) as HTMLElement[];
    const visibleButtons = fallbackButtons.filter(isVisible);
    return visibleButtons.at(-1) ?? null;
}

function getComboListbox(combo: HTMLElement): HTMLElement | null {
    const controlsId = combo.getAttribute("aria-controls");
    if (controlsId) {
        const controlled = document.getElementById(controlsId);
        if (isVisible(controlled)) return controlled;
    }

    const expanded = Array.from(document.querySelectorAll('[role="listbox"]')) as HTMLElement[];
    return expanded.filter(isVisible).at(-1) ?? null;
}

function getComboInput(combo: HTMLElement): HTMLElement {
    return (combo.querySelector("input") as HTMLElement | null)
        ?? (combo.querySelector('[contenteditable="true"]') as HTMLElement | null)
        ?? (combo.querySelector('[tabindex]') as HTMLElement | null)
        ?? combo;
}

function getClickableComboTarget(combo: HTMLElement): HTMLElement {
    return (combo.querySelector(':scope > [class*="wrapper"]') as HTMLElement | null)
        ?? (combo.querySelector('[class*="wrapper"]') as HTMLElement | null)
        ?? (combo.querySelector('[class*="select"]') as HTMLElement | null)
        ?? (combo.querySelector('input') as HTMLElement | null)
        ?? (combo.querySelector('[role="button"]') as HTMLElement | null)
        ?? (combo.querySelector('[class*="control"]') as HTMLElement | null)
        ?? (combo.querySelector('[class*="container"]') as HTMLElement | null)
        ?? combo;
}

function pressKey(element: HTMLElement, key: string) {
    const keyMap: Record<string, { code: string; keyCode: number }> = {
        Enter: { code: "Enter", keyCode: 13 },
        ArrowDown: { code: "ArrowDown", keyCode: 40 },
        " ": { code: "Space", keyCode: 32 }
    };

    const mapped = keyMap[key] ?? { code: key, keyCode: 0 };
    const init = {
        key,
        code: mapped.code,
        keyCode: mapped.keyCode,
        which: mapped.keyCode,
        bubbles: true,
        cancelable: true,
        composed: true
    };

    element.dispatchEvent(new KeyboardEvent("keydown", init));
    element.dispatchEvent(new KeyboardEvent("keypress", init));
    element.dispatchEvent(new KeyboardEvent("keyup", init));
}

function setNativeInputValue(element: HTMLElement, value: string) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;

    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
}

function isDropdownOpen(combo: HTMLElement, names: string[] = []): boolean {
    if (combo.getAttribute("aria-expanded") === "true") return true;
    if (combo.getAttribute("data-state") === "open") return true;

    const clickable = getClickableComboTarget(combo);
    if (clickable.getAttribute("aria-expanded") === "true") return true;
    if (clickable.getAttribute("data-state") === "open") return true;

    if (getComboListbox(combo)) return true;
    if (names.length && findOptionByNames(names, combo)) return true;
    return false;
}

function clickElementCenter(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y);
    if (target instanceof HTMLElement) {
        fireClick(target);
    }
}

function getDropdownCandidates(combo: HTMLElement): HTMLElement[] {
    const clickable = getClickableComboTarget(combo);
    const input = getComboInput(combo);
    const wrapper = combo.querySelector(':scope > [class*="wrapper"]') as HTMLElement | null;
    const icon = combo.querySelector('svg') as HTMLElement | null;
    const unique: HTMLElement[] = [];

    const push = (candidate: Element | null | undefined) => {
        if (candidate instanceof HTMLElement && isVisible(candidate) && !unique.includes(candidate)) {
            unique.push(candidate);
        }
    };

    push(combo);
    push(wrapper);
    push(clickable);
    push(input);
    push(icon);
    push(combo.parentElement);
    push(clickable.parentElement);

    const nested = Array.from(combo.querySelectorAll('input, button, [role="button"], [tabindex], [class*="wrapper"], [class*="select"], [class*="control"], [class*="container"], [class*="value"], [class*="indicator"], svg'));
    for (const candidate of nested) push(candidate);

    return unique;
}

async function openDropdown(combo: HTMLElement, names: string[]) {
    const candidates = getDropdownCandidates(combo);

    for (const candidate of candidates) {
        candidate.scrollIntoView({ block: "nearest" });
        candidate.focus();
        await delay(40);

        fireClick(candidate);
        await delay(160);
        if (isDropdownOpen(combo, names)) return;

        clickElementCenter(candidate);
        await delay(160);
        if (isDropdownOpen(combo, names)) return;

        pressKey(combo, "ArrowDown");
        await delay(160);
        if (isDropdownOpen(combo, names)) return;

        pressKey(combo, "Enter");
        await delay(160);
        if (isDropdownOpen(combo, names)) return;

        pressKey(combo, " ");
        await delay(160);
        if (isDropdownOpen(combo, names)) return;
    }

    throw new Error("Could not open dropdown");
}

async function selectDropdownOption(combo: HTMLElement, names: string[]) {
    const input = getComboInput(combo);
    input.focus();

    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
        input.select();
        setNativeInputValue(input, names[0] ?? "");
        await delay(220);
    }

    let option = findOptionByNames(names, combo);

    if (!option) {
        pressKey(input, "ArrowDown");
        await delay(180);
        option = findOptionByNames(names, combo);
    }

    if (!option) {
        throw new Error("Could not find matching dropdown option");
    }

    option.scrollIntoView({ block: "nearest" });
    option.focus();
    await delay(50);
    fireClick(option);
    await delay(150);
    pressKey(input, "Enter");
}

function findOptionByNames(names: string[], combo?: HTMLElement | null): HTMLElement | null {
    const lowered = names.map(normalize).filter(Boolean);
    const listbox = combo ? getComboListbox(combo) : null;
    const roots: ParentNode[] = listbox ? [listbox, document] : [document];

    for (const root of roots) {
        const options = Array.from(root.querySelectorAll('[role="option"], [aria-selected], [class*="option"], [class*="Option"], [class*="item"], [data-list-item-id]')) as HTMLElement[];
        const visibleOptions = options.filter(isVisible);

        for (const name of lowered) {
            const exact = visibleOptions.find(option => visibleText(option) === name);
            if (exact) return exact;
        }

        for (const option of visibleOptions) {
            const text = visibleText(option);
            if (lowered.some(name => text.includes(name))) {
                return option;
            }
        }
    }

    return null;
}

function getVisibleComposer(): HTMLElement | null {
    const selectors = [
        '[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"]',
        'textarea'
    ];

    const candidates = Array.from(document.querySelectorAll(selectors.join(","))) as HTMLElement[];
    return candidates.filter(isVisible).at(-1) ?? null;
}

function setComposerValue(element: HTMLElement, value: string): boolean {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        descriptor?.set?.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    if (element.isContentEditable) {
        element.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);

        const inserted = document.execCommand("insertText", false, value);
        if (!inserted) {
            element.textContent = value;
            element.dispatchEvent(new InputEvent("input", {
                bubbles: true,
                cancelable: true,
                composed: true,
                inputType: "insertText",
                data: value
            }));
        }

        return true;
    }

    return false;
}

function sendCommand(content: string): string {
    const channelId = getCommandTargetChannelId();

    try {
        if (channelId) {
            MessageActions.sendMessage(channelId, {
                content,
                tts: false,
                invalidEmojis: [],
                validNonShortcutEmojis: []
            });
            showToast(`Sent ${content} with MessageActions`);
            return channelId;
        }
    } catch (error) {
        console.warn("[AutoTransferWatchedUsers] MessageActions.sendMessage failed, falling back to the open composer", error);
    }

    const composer = getVisibleComposer();
    if (!composer) throw new Error("Could not find an open chat composer for the trigger command");

    fireClick(composer);
    composer.focus();
    if (!setComposerValue(composer, content)) {
        throw new Error("Could not write the trigger command into the chat composer");
    }

    pressKey(composer, "Enter");
    showToast(`Sent ${content} with composer fallback`);
    return "composer";
}

async function clickTransferAndSelectUser(userId: string) {
    const channelId = getCurrentVoiceChannelId();
    if (!channelId) throw new Error("You are not in a voice channel");

    const names = getUserNames(userId);
    if (!names.length) throw new Error("Could not resolve target user names");

    sendCommand(settings.store.triggerCommand);
    await delay(settings.store.preClickDelayMs);

    const button = await waitForElement(
        () => getNewestButtonByLabel(settings.store.actionLabel),
        settings.store.uiTimeoutMs
    );

    button.click();
    showToast(`Clicked ${settings.store.actionLabel} for ${names[0]}`);

    const promptRoot = await waitForElement(
        () => findLatestPromptContainer(settings.store.selectPromptText),
        settings.store.uiTimeoutMs
    );

    const combo = await waitForElement(
        () => findComboTrigger(promptRoot) ?? findComboTrigger(document),
        settings.store.uiTimeoutMs
    );

    await openDropdown(combo, names);

    await waitForElement(
        () => findOptionByNames(names, combo),
        settings.store.uiTimeoutMs
    );

    await selectDropdownOption(combo, names);
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
        console.error("[AutoTransferMutedWatchedUsers] Failed to automate transfer", error);
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
    description: "When a watched user joins your current voice channel, send the trigger command, click Transfer, and select that user.",
    authors: [{ name: "Your Name", id: 0n }],
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
