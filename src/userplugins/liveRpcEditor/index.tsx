/*
 * Live RPC Editor - Edit custom presence with live preview. Alt+R to open. Clone any user's activities.
 * Right-click user: Copy stream URL, or Clone to Live RPC Editor.
 */

import "./style.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { addDockButton, removeDockButton } from "../pluginDock";
import { Flex } from "@components/Flex";
import { definePluginSettings } from "@api/Settings";
import { classNameFactory } from "@utils/css";
import { copyToClipboard } from "@utils/clipboard";
import { getCurrentChannel } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { findByCodeLazy, findComponentByCodeLazy, findStoreLazy } from "@webpack";
// Fetches activity metadata (e.g. button_urls) when Discord doesn't include it in presence
const getMetadataFromApi = findByCodeLazy("null/undefined") as ((activity: Activity, userId: string) => Promise<{ button_urls?: string[] } | null>) | undefined;
import {
    ApplicationAssetUtils,
    Button,
    FluxDispatcher,
    Forms,
    Menu,
    React,
    ScrollerThin,
    Select,
    TextInput,
    Toasts,
    UserStore,
    useState,
    useEffect,
    useRef,
    useMemo,
} from "@webpack/common";
import { ModalRoot, ModalContent, ModalHeader, ModalFooter, ModalProps, ModalSize, openModal, ModalCloseButton } from "@utils/modal";
import type { Activity } from "@vencord/discord-types";

const SOCKET_ID = "LiveRpcEditor";
const ACTIVITY_TYPES = [
    { label: "Playing", value: 0 },
    { label: "Streaming", value: 1 },
    { label: "Listening", value: 2 },
    { label: "Watching", value: 3 },
    { label: "Custom", value: 4 },
    { label: "Competing", value: 5 },
];
const SKIP_ACTIVITY_NAMES = ["Custom Status", "Spotify", "Hang Status"];

const useProfileThemeStyle = findByCodeLazy("profileThemeStyle:", "--profile-gradient-primary-color");
const ActivityView = findComponentByCodeLazy(".party?(0", "USER_PROFILE_ACTIVITY");
const UserProfilePopout = findComponentByCodeLazy('"UserProfilePopout"', "disableUserProfileLink:");
const AccountPopout = findComponentByCodeLazy("getAnyStreamForUser", "useUserTag");
const PresenceStore = findStoreLazy("PresenceStore") as { getActivities(userId: string): Activity[] };

const cl = classNameFactory("vc-liverpc-");

const settings = definePluginSettings({
    previewSize: {
        type: OptionType.SELECT,
        description: "Size of the live preview panel in the editor modal.",
        options: [
            { label: "Small", value: "small", default: false },
            { label: "Medium", value: "medium", default: true },
            { label: "Large", value: "large", default: false },
        ],
    },
    rpcActive: {
        type: OptionType.BOOLEAN,
        description: "RPC presence active.",
        default: false,
    },
    keybind: {
        type: OptionType.STRING,
        description: "Keybind to open the Live RPC Editor.",
        default: "",
    },
}).withPrivateSettings<{
    savedFormState: Record<string, unknown> | null;
    presets: Record<string, Record<string, unknown>>;
}>();

function emptyActivity(): Record<string, unknown> {
    return {
        name: "",
        application_id: "",
        state: "",
        state_url: "",
        details: "",
        details_url: "",
        type: 0,
        flags: 1,
        url: "",
        timestamps: undefined,
        assets: {},
        buttons: [],
        metadata: { button_urls: [] },
        status_display_type: undefined,
        party: undefined,
    };
}

function activityToFormState(act: Activity | Record<string, unknown>): Record<string, unknown> {
    const a = act as Record<string, unknown>;
    const rawButtons = Array.isArray(a.buttons) ? a.buttons : [];
    let buttons: string[] = [];
    let button_urls: string[] = Array.isArray((a.metadata as { button_urls?: string[] } | undefined)?.button_urls)
        ? [...(a.metadata as { button_urls: string[] }).button_urls]
        : [];
    if (rawButtons.length > 0) {
        if (typeof rawButtons[0] === "string") {
            buttons = [...(rawButtons as string[])];
        } else {
            const fromObjs: string[] = [];
            (rawButtons as { label?: string; url?: string }[]).forEach((b) => {
                if (b?.label != null) buttons.push(String(b.label));
                if (b?.url != null) fromObjs.push(String(b.url));
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

            if (fromObjs.length > 0) button_urls = fromObjs;
        }
    }
    // Streaming (type 1): Watch button uses the same URL as activity.url (Twitch/YouTube). Put it where it belongs.
    const streamUrl = (a as any).url?.trim?.();
    if (Number(a.type) === 1 && streamUrl) {
        if (button_urls.length === 0 && buttons.length > 0) button_urls = [streamUrl];
        else if (buttons.length === 0) {
            buttons = ["Watch"];
            button_urls = [streamUrl];
        }
    }
    const rawAssets = a.assets as Record<string, string> | undefined;
    const assets = rawAssets ? { ...rawAssets } : {};
    const explicit: Record<string, unknown> = {
        name: a.name ?? "",
        application_id: String(a.application_id ?? (act as any).applicationId ?? ""),
        state: a.state ?? "",
        state_url: (a as any).state_url ?? "",
        details: a.details ?? "",
        details_url: (a as any).details_url ?? "",
        type: a.type ?? 0,
        flags: a.flags ?? 1,
        url: (a as any).url ?? "",
        timestamps: a.timestamps ? { ...(a.timestamps as object) } : undefined,
        assets,
        buttons,
        metadata: { button_urls },
        status_display_type: (a as any).status_display_type ?? undefined,
        party: a.party ? { ...(a.party as object) } : undefined,
    };
    const passthroughKeys = ["id", "created_at", "session_id", "sync_id", "platform", "emoji"];
    for (const k of passthroughKeys) {
        if (a[k] !== undefined && a[k] !== null) explicit[k] = a[k];
    }
    return explicit;
}

function formStateToActivity(state: Record<string, unknown>): Activity | null {
    const name = String(state.name ?? "").trim();
    if (!name) return null;
    const activity: Activity = {
        name,
        type: Number(state.type) ?? 0,
        flags: Number(state.flags) ?? 1,
    };
    const appId = String(state.application_id ?? "").trim();
    if (appId) activity.application_id = appId;
    const stateStr = String(state.state ?? "").trim();
    if (stateStr) activity.state = stateStr;
    const stateUrl = String((state as any).state_url ?? "").trim();
    if (stateUrl) (activity as any).state_url = stateUrl;
    const details = String(state.details ?? "").trim();
    if (details) activity.details = details;
    const detailsUrl = String((state as any).details_url ?? "").trim();
    if (detailsUrl) (activity as any).details_url = detailsUrl;
    const streamUrl = (state.type as number) === 1 && (state as any).url ? String((state as any).url).trim() : "";
    if (streamUrl) activity.url = streamUrl;
    const ts = state.timestamps as { start?: number; end?: number } | undefined;
    if (ts && (ts.start != null || ts.end != null)) {
        activity.timestamps = {};
        if (ts.start != null) activity.timestamps.start = ts.start;
        if (ts.end != null) activity.timestamps.end = ts.end;
    }
    const assets = state.assets as Record<string, string> | undefined;
    if (assets && (assets.large_image || assets.small_image || assets.large_text || assets.small_text || assets.large_url || assets.small_url)) {
        activity.assets = {};
        if (assets.large_image) activity.assets.large_image = assets.large_image;
        if (assets.large_text) activity.assets.large_text = assets.large_text;
        if (assets.large_url) activity.assets.large_url = assets.large_url;
        if (assets.small_image) activity.assets.small_image = assets.small_image;
        if (assets.small_text) activity.assets.small_text = assets.small_text;
        if (assets.small_url) activity.assets.small_url = assets.small_url;
    }
    let buttons = (state.buttons as string[] | undefined)?.filter(Boolean) ?? [];
    let buttonUrls = ((state.metadata as any)?.button_urls as string[] | undefined)?.filter(Boolean) ?? [];
    if ((state.type as number) === 1 && streamUrl) {
        if (buttonUrls[0] !== streamUrl) {
            buttons = ["Watch", ...buttons.filter((_, i) => i > 0)];
            buttonUrls = [streamUrl, ...buttonUrls.filter((_, i) => i > 0)];
        }
    }
    if (buttons.length || buttonUrls.length) {
        activity.buttons = buttons.slice(0, 2);
        activity.metadata = { button_urls: buttonUrls.slice(0, 2) };
    }
    const statusDisplayType = (state as any).status_display_type;
    if (statusDisplayType != null) (activity as any).status_display_type = statusDisplayType;
    const party = state.party as { id?: string; size?: [number, number] } | undefined;
    if (party && (party.id || (Array.isArray(party.size) && party.size.length >= 2))) {
        activity.party = {};
        if (party.id) activity.party.id = party.id;
        if (Array.isArray(party.size) && party.size.length >= 2) activity.party.size = [Number(party.size[0]), Number(party.size[1])];
    }
    const passthroughKeys = ["id", "created_at", "session_id", "sync_id", "platform", "emoji"];
    for (const k of passthroughKeys) {
        const v = (state as Record<string, unknown>)[k];
        if (v !== undefined && v !== null) (activity as Record<string, unknown>)[k] = v;
    }
    return activity;
}

async function resolveAssetIds(activity: Activity): Promise<Activity> {
    const clone = JSON.parse(JSON.stringify(activity)) as Activity;
    const appId = clone.application_id;
    if (!appId || !clone.assets) return clone;
    try {
        if (clone.assets.large_image && !/^\d+$/.test(clone.assets.large_image) && !clone.assets.large_image.startsWith("mp:")) {
            const keys = await ApplicationAssetUtils.fetchAssetIds(appId, [clone.assets.large_image]);
            if (keys[0]) clone.assets.large_image = keys[0];
        }
        if (clone.assets.small_image && !/^\d+$/.test(clone.assets.small_image) && !clone.assets.small_image.startsWith("mp:")) {
            const keys = await ApplicationAssetUtils.fetchAssetIds(appId, [clone.assets.small_image]);
            if (keys[0]) clone.assets.small_image = keys[0];
        }
    } catch (_) {}
    return clone;
}

function dispatchActivity(activity: Activity | null) {
    const payload: any = { type: "LOCAL_ACTIVITY_UPDATE", socketId: SOCKET_ID };
    if (activity) {
        const clone = JSON.parse(JSON.stringify(activity)) as Activity;
        clone.id = clone.id ?? Array(18).fill(0).map(() => Math.floor(Math.random() * 10)).join("");
        if (!clone.metadata) clone.metadata = {};
        (clone.metadata as any).socketId = SOCKET_ID;
        payload.activity = clone;
    } else {
        payload.activity = null;
    }
    FluxDispatcher.dispatch(payload);
}

function SectionTitle({ children }: { children: React.ReactNode }) {
    return <Forms.FormTitle tag="h3" className={cl("section-title")}>{children}</Forms.FormTitle>;
}

function ProfilePreview({ activity }: { activity: Activity | null }) {
    const user = UserStore.getCurrentUser();
    const channel = getCurrentChannel();
    const [tick, setTick] = useState(0);

    // Re-render every 500ms until the user-profile popout chunk loads (it's lazy on PTB).
    useEffect(() => {
        if ((globalThis as any).__VC_UserProfilePopout) return;
        const t = setInterval(() => {
            if ((globalThis as any).__VC_UserProfilePopout) {
                setTick(x => x + 1);
                clearInterval(t);
            }
        }, 500);
        return () => clearInterval(t);
    }, []);

    const Popout = (globalThis as any).__VC_UserProfilePopout;
    if (Popout) {
        return (
            <Popout
                user={user}
                currentUser={user}
                guildId={channel?.getGuildId()}
                channelId={channel?.id}
                openedAt={Date.now()}
                closePopout={() => { }}
                setPopoutRef={() => { }}
                disableUserProfileLink={true}
                disableAutoFocus={true}
            />
        );
    }
    const Acct = (globalThis as any).__VC_AccountPopout;
    if (Acct) {
        return <Acct currentUser={user} onClose={() => { }} openedAt={Date.now()} />;
    }
    if (activity) {
        return (
            <div className={cl("preview-fallback")}>
                <ActivityView user={user} currentUser={user} activity={activity} application={null} />
            </div>
        );
    }
    return <div className={cl("preview-empty")}>Open a profile popout once to load the preview.</div>;
}

function LiveRpcEditorModal({ modalProps }: { modalProps: ModalProps }) {
    const pendingMetadataRef = useRef<{ activity: Activity; userId: string } | null>(null);
    const [formState, setFormState] = useState<Record<string, unknown>>(() => {
        const p = pendingInitialActivity;
        const u = pendingInitialUserId;
        pendingInitialActivity = null;
        pendingInitialUserId = null;
        if (p && u) pendingMetadataRef.current = { activity: p, userId: u };
        if (p) return activityToFormState(p);
        const saved = settings.store.savedFormState;
        if (saved && typeof saved === "object" && typeof (saved as any).name === "string" && (saved as any).name.trim())
            return { ...saved };
        return emptyActivity();
    });
    const [cloneUserId, setCloneUserId] = useState("");
    const [cloneActivities, setCloneActivities] = useState<Activity[]>([]);
    const [cloneLoading, setCloneLoading] = useState(false);
    const [presetName, setPresetName] = useState("");
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const { profileThemeStyle } = useProfileThemeStyle?.({}) ?? {};

    const activity = useMemo(() => formStateToActivity(formState), [formState]);

    useEffect(() => {
        if (!activity) {
            dispatchActivity(null);
            settings.store.savedFormState = null;
            return;
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            resolveAssetIds(activity).then(a => {
                dispatchActivity(a);
                try { settings.store.savedFormState = JSON.parse(JSON.stringify(formState)); } catch { }
            });
            debounceRef.current = null;
        }, 400);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [activity, formState]);

    // When opened from user context menu with an activity that has buttons but no URLs, fetch metadata from API
    useEffect(() => {
        const pending = pendingMetadataRef.current;
        if (!pending || !getMetadataFromApi) return;
        const buttons = (formState.buttons as string[]) ?? [];
        const urls = (formState.metadata as { button_urls?: string[] })?.button_urls ?? [];
        if (buttons.length === 0 || urls.length > 0) {
            pendingMetadataRef.current = null;
            return;
        }
        const applyUrls = (urls: string[]) => {
            if (urls?.length) {
                setFormState(prev => ({
                    ...prev,
                    metadata: { ...(prev.metadata as object), button_urls: urls },
                }));
            }
        };
        Promise.resolve()
            .then(async () => {
                if (getMetadataFromApi) {
                    const meta = await getMetadataFromApi(pending.activity, pending.userId);
                    if (meta?.button_urls?.length) return meta.button_urls;
                }
                if (typeof PresenceStore.getActivityMetadata === "function") {
                    const cached = PresenceStore.getActivityMetadata(pending.userId);
                    return cached?.button_urls ?? (pending.activity.id && cached?.[pending.activity.id]?.button_urls);
                }
                return null;
            })
            .then(urls => Array.isArray(urls) && urls.length > 0 && applyUrls(urls))
            .catch(() => {})
            .finally(() => { pendingMetadataRef.current = null; });
    }, []);

    useEffect(() => {
        if ((formState.type as number) !== 1) return;
        const url = String((formState as any).url ?? "").trim();
        if (!url) return;
        const buttons = (formState.buttons as string[]) ?? [];
        const urls = ((formState.metadata as any)?.button_urls as string[]) ?? [];
        if (buttons[0] || urls[0]) return;
        setFormState(prev => {
            const next = { ...prev };
            const prevButtons = [...((prev.buttons as string[]) ?? [])];
            const prevUrls = [...(((prev.metadata as any)?.button_urls as string[]) ?? [])];
            prevButtons[0] = "Watch";
            prevUrls[0] = url;
            (next as any).buttons = prevButtons;
            (next as any).metadata = { ...(prev.metadata as object), button_urls: prevUrls };
            return next;
        });
    }, [formState.type, (formState as any).url]);

    // Do NOT clear activity on modal close - only "Clear presence" or plugin stop clears it

    function updateField(path: string[], value: unknown) {
        setFormState(prev => {
            const next = JSON.parse(JSON.stringify(prev));
            let cur: any = next;
            for (let i = 0; i < path.length - 1; i++) {
                const k = path[i];
                if (cur[k] == null) cur[k] = {};
                cur = cur[k];
            }
            cur[path[path.length - 1]] = value;
            return next;
        });
    }

    function loadUserActivities() {
        const uid = cloneUserId.trim();
        if (!uid) return;
        setCloneLoading(true);
        try {
            const activities = PresenceStore.getActivities(uid) ?? [];
            const filtered = activities.filter((a: Activity) => !SKIP_ACTIVITY_NAMES.includes(a.name));
            setCloneActivities(filtered);
        } finally {
            setCloneLoading(false);
        }
    }

    async function cloneActivity(act: Activity, sourceUserId?: string) {
        const state = activityToFormState(act);
        state.application_id = state.application_id || (act as any).application_id;
        const buttons = (state.buttons as string[]) ?? [];
        const urls = (state.metadata as { button_urls?: string[] })?.button_urls ?? [];
        if (buttons.length > 0 && urls.length === 0 && sourceUserId) {
            try {
                if (getMetadataFromApi) {
                    const meta = await getMetadataFromApi(act, sourceUserId);
                    if (meta?.button_urls?.length) {
                        state.metadata = { button_urls: meta.button_urls };
                    }
                }
                if (!(state.metadata as { button_urls?: string[] }).button_urls?.length && typeof PresenceStore.getActivityMetadata === "function") {
                    const cached = PresenceStore.getActivityMetadata(sourceUserId);
                    const resolved = cached?.button_urls ?? (act.id && cached?.[act.id]?.button_urls);
                    if (Array.isArray(resolved) && resolved.length > 0) {
                        state.metadata = { button_urls: resolved };
                    }
                }
            } catch (_) {}
        }
        setFormState(state);
        setCloneActivities([]);
    }

    const assets = (formState.assets as Record<string, string>) ?? {};

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader className={cl("modal-header")}>
                <Forms.FormTitle tag="h2" className={cl("modal-title")}>Live RPC Editor</Forms.FormTitle>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent className={cl("modal-content")}>
                <div className={cl("wrap")}>
                    <ScrollerThin className={cl("form-scroll")} orientation="vertical">
                        <div className={cl("form-inner")}>

                            {/* Two columns, both starting at the same level */}
                            <div className={cl("form-columns")}>
                                <div className={cl("form-col")}>
                                    <SectionTitle>Basic info</SectionTitle>
                                    <Forms.FormTitle tag="label" className={cl("label")}>Application ID</Forms.FormTitle>
                                    <TextInput value={String(formState.application_id ?? "")} onChange={v => updateField(["application_id"], v)} placeholder="e.g. 123456789" />
                                    <Forms.FormTitle tag="label" className={cl("label")}>Name *</Forms.FormTitle>
                                    <TextInput value={String(formState.name ?? "")} onChange={v => updateField(["name"], v)} placeholder="Game or app name" />
                                    <Forms.FormTitle tag="label" className={cl("label")}>Type</Forms.FormTitle>
                                    <Select
                                        placeholder="Activity type"
                                        options={ACTIVITY_TYPES.map(t => ({ label: t.label, value: t.value }))}
                                        maxVisibleItems={8}
                                        closeOnSelect={true}
                                        select={v => updateField(["type"], v)}
                                        isSelected={v => v === (formState.type as number)}
                                        serialize={v => String(v)}
                                    />
                                    <Forms.FormTitle tag="label" className={cl("label")}>State</Forms.FormTitle>
                                    <TextInput value={String(formState.state ?? "")} onChange={v => updateField(["state"], v)} placeholder="e.g. In menu" />
                                    <Forms.FormTitle tag="label" className={cl("label")}>State URL (clickable)</Forms.FormTitle>
                                    <TextInput value={String((formState as any).state_url ?? "")} onChange={v => updateField(["state_url"], v)} placeholder="https://..." />
                                    <Forms.FormTitle tag="label" className={cl("label")}>Details</Forms.FormTitle>
                                    <TextInput value={String(formState.details ?? "")} onChange={v => updateField(["details"], v)} placeholder="e.g. Level 42" />
                                    <Forms.FormTitle tag="label" className={cl("label")}>Details URL (clickable)</Forms.FormTitle>
                                    <TextInput value={String((formState as any).details_url ?? "")} onChange={v => updateField(["details_url"], v)} placeholder="https://..." />
                                    {(formState.type as number) === 1 && (
                                        <>
                                            <Forms.FormTitle tag="label" className={cl("label")}>Stream URL</Forms.FormTitle>
                                            <TextInput value={String((formState as any).url ?? "")} onChange={v => updateField(["url"], v)} placeholder="https://twitch.tv/..." />
                                        </>
                                    )}

                                    <hr className={cl("divider")} />

                                    <SectionTitle>Timestamps</SectionTitle>
                                    <div className={cl("field-row")}>
                                        <div>
                                            <Forms.FormTitle tag="label" className={cl("label")}>Start (ms)</Forms.FormTitle>
                                            <TextInput
                                                value={String((formState.timestamps as any)?.start ?? "")}
                                                onChange={v => updateField(["timestamps", "start"], v ? Number(v) : undefined)}
                                                placeholder="e.g. 1713200000000"
                                            />
                                        </div>
                                        <div>
                                            <Forms.FormTitle tag="label" className={cl("label")}>End (ms)</Forms.FormTitle>
                                            <TextInput
                                                value={String((formState.timestamps as any)?.end ?? "")}
                                                onChange={v => updateField(["timestamps", "end"], v ? Number(v) : undefined)}
                                                placeholder="e.g. 1713203600000"
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className={cl("form-col")}>
                                    <SectionTitle>Images & assets</SectionTitle>
                                    <Forms.FormTitle tag="label" className={cl("label")}>Large image key</Forms.FormTitle>
                                    <TextInput value={String(assets.large_image ?? "")} onChange={v => updateField(["assets", "large_image"], v)} placeholder="Image key or URL" />
                                    <Forms.FormTitle tag="label" className={cl("label")}>Large image text</Forms.FormTitle>
                                    <TextInput value={String(assets.large_text ?? "")} onChange={v => updateField(["assets", "large_text"], v)} placeholder="Tooltip" />
                                    <Forms.FormTitle tag="label" className={cl("label")}>Large image URL (clickable)</Forms.FormTitle>
                                    <TextInput value={String(assets.large_url ?? "")} onChange={v => updateField(["assets", "large_url"], v)} placeholder="https://..." />
                                    <Forms.FormTitle tag="label" className={cl("label")}>Small image key</Forms.FormTitle>
                                    <TextInput value={String(assets.small_image ?? "")} onChange={v => updateField(["assets", "small_image"], v)} placeholder="Image key or URL" />
                                    <Forms.FormTitle tag="label" className={cl("label")}>Small image text</Forms.FormTitle>
                                    <TextInput value={String(assets.small_text ?? "")} onChange={v => updateField(["assets", "small_text"], v)} placeholder="Tooltip" />
                                    <Forms.FormTitle tag="label" className={cl("label")}>Small image URL (clickable)</Forms.FormTitle>
                                    <TextInput value={String(assets.small_url ?? "")} onChange={v => updateField(["assets", "small_url"], v)} placeholder="https://..." />

                                    <hr className={cl("divider")} />

                                    <SectionTitle>Buttons</SectionTitle>
                                    <Forms.FormTitle tag="label" className={cl("label")}>Button 1</Forms.FormTitle>
                                    <div className={cl("field-row")}>
                                        <TextInput
                                            value={String(((formState.buttons as string[]) ?? [])[0] ?? "")}
                                            onChange={v => {
                                                const arr = [...((formState.buttons as string[]) ?? [])];
                                                arr[0] = v;
                                                updateField(["buttons"], arr);
                                            }}
                                            placeholder="Label"
                                        />
                                        <TextInput
                                            value={String(((formState.metadata as any)?.button_urls ?? [])[0] ?? "")}
                                            onChange={v => {
                                                const arr = [...(((formState.metadata as any)?.button_urls as string[]) ?? [])];
                                                arr[0] = v;
                                                updateField(["metadata", "button_urls"], arr);
                                            }}
                                            placeholder="URL"
                                        />
                                    </div>
                                    <Forms.FormTitle tag="label" className={cl("label")}>Button 2</Forms.FormTitle>
                                    <div className={cl("field-row")}>
                                        <TextInput
                                            value={String(((formState.buttons as string[]) ?? [])[1] ?? "")}
                                            onChange={v => {
                                                const arr = [...((formState.buttons as string[]) ?? [])];
                                                while (arr.length < 2) arr.push("");
                                                arr[1] = v;
                                                updateField(["buttons"], arr);
                                            }}
                                            placeholder="Label"
                                        />
                                        <TextInput
                                            value={String(((formState.metadata as any)?.button_urls ?? [])[1] ?? "")}
                                            onChange={v => {
                                                const arr = [...(((formState.metadata as any)?.button_urls as string[]) ?? [])];
                                                while (arr.length < 2) arr.push("");
                                                arr[1] = v;
                                                updateField(["metadata", "button_urls"], arr);
                                            }}
                                            placeholder="URL"
                                        />
                                    </div>
                                </div>
                            </div>

                            <hr className={cl("divider")} />

                            {/* Top bar: Clone + Presets side by side */}
                            <div className={cl("top-bar")}>
                                <div>
                                    <SectionTitle>Clone from user</SectionTitle>
                                    <Flex style={{ gap: "8px", alignItems: "center", marginTop: "8px" }}>
                                        <TextInput
                                            value={cloneUserId}
                                            onChange={setCloneUserId}
                                            placeholder="User ID"
                                            style={{ flex: 1 }}
                                        />
                                        <Button size={Button.Sizes.SMALL} onClick={loadUserActivities} disabled={cloneLoading}>
                                            {cloneLoading ? "Loading..." : "Load activities"}
                                        </Button>
                                    </Flex>
                                    {cloneActivities.length > 0 && (
                                        <div className={cl("clone-buttons")} style={{ marginTop: "8px" }}>
                                            {cloneActivities.map((act, i) => (
                                                <Button
                                                    key={act.id ?? i}
                                                    size={Button.Sizes.SMALL}
                                                    look={Button.Looks.OUTLINED}
                                                    color={Button.Colors.PRIMARY}
                                                    onClick={() => cloneActivity(act, cloneUserId.trim() || undefined)}
                                                >
                                                    {act.name}
                                                </Button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div>
                                    <SectionTitle>Presets</SectionTitle>
                                    <Flex style={{ gap: "8px", alignItems: "center", marginTop: "8px" }}>
                                        <TextInput
                                            value={presetName}
                                            onChange={setPresetName}
                                            placeholder="Preset name"
                                            style={{ flex: 1 }}
                                        />
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            disabled={!presetName.trim() || !String(formState.name ?? "").trim()}
                                            onClick={() => {
                                                const name = presetName.trim();
                                                if (!name) return;
                                                try {
                                                    const clean = JSON.parse(JSON.stringify(formState));
                                                    const existing = JSON.parse(JSON.stringify(settings.store.presets ?? {}));
                                                    existing[name] = clean;
                                                    settings.store.presets = existing;
                                                    setPresetName("");
                                                    Toasts.show({ id: Toasts.genId(), message: `Saved preset "${name}"`, type: Toasts.Type.SUCCESS });
                                                } catch {
                                                    Toasts.show({ id: Toasts.genId(), message: "Failed to save preset", type: Toasts.Type.FAILURE });
                                                }
                                            }}
                                        >
                                            Save
                                        </Button>
                                    </Flex>
                                    {Object.keys(settings.store.presets ?? {}).length > 0 && (
                                        <div className={cl("clone-buttons")} style={{ marginTop: "8px" }}>
                                            {Object.entries(settings.store.presets ?? {}).map(([name, state]) => (
                                                <div key={name} className={cl("preset-chip")}>
                                                    <Button
                                                        size={Button.Sizes.SMALL}
                                                        look={Button.Looks.OUTLINED}
                                                        color={Button.Colors.PRIMARY}
                                                        onClick={() => setFormState({ ...state })}
                                                    >
                                                        {name}
                                                    </Button>
                                                    <Button
                                                        size={Button.Sizes.SMALL}
                                                        look={Button.Looks.LINK}
                                                        color={Button.Colors.PRIMARY}
                                                        onClick={() => {
                                                            try {
                                                                const presets = JSON.parse(JSON.stringify(settings.store.presets ?? {}));
                                                                delete presets[name];
                                                                settings.store.presets = presets;
                                                                Toasts.show({ id: Toasts.genId(), message: `Deleted "${name}"`, type: Toasts.Type.SUCCESS });
                                                            } catch { }
                                                        }}
                                                    >
                                                        ✕
                                                    </Button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <hr className={cl("divider")} />
                        </div>
                    </ScrollerThin>

                    <div
                        className={cl("preview-panel")}
                        style={{
                            ...profileThemeStyle,
                            width: 340,
                        }}
                    >
                        <div className={cl("preview-popout")}>
                            <ProfilePreview activity={activity} />
                        </div>

                        <div className={cl("actions")}>
                            <Button
                                look={Button.Looks.OUTLINED}
                                color={Button.Colors.DANGER}
                                onClick={() => {
                                    setFormState(emptyActivity());
                                    dispatchActivity(null);
                                    settings.store.savedFormState = null;
                                }}
                            >
                                Clear presence
                            </Button>
                        </div>
                    </div>
                </div>
            </ModalContent>
            <ModalFooter className={cl("modal-footer")}>
                <Button color={Button.Colors.BRAND} onClick={modalProps.onClose}>Done</Button>
            </ModalFooter>
        </ModalRoot>
    );
}

let pendingInitialActivity: Activity | null = null;
let pendingInitialUserId: string | null = null;

function openLiveRpcEditor(initialActivity?: Activity | null, sourceUserId?: string | null) {
    pendingInitialActivity = initialActivity ?? null;
    pendingInitialUserId = sourceUserId ?? null;
    openModal(modalProps => <LiveRpcEditorModal modalProps={modalProps} />);
}

function buildUserContextMenu(children: React.ReactElement[], props: { user?: { id: string } }) {
    const userId = props?.user?.id;
    if (!userId || userId === UserStore.getCurrentUser()?.id) return;
    const activities = (PresenceStore.getActivities(userId) ?? []).filter(
        (a: Activity) => !SKIP_ACTIVITY_NAMES.includes(a.name)
    );
    if (activities.length === 0) return;
    const streamingWithUrl = activities.filter((a: Activity) => a.type === 1 && (a as any).url?.trim?.());
    children.push(
        <Menu.MenuGroup key="live-rpc-editor">
            {streamingWithUrl.length > 0 && (
                <>
                    <Menu.MenuItem
                        id="live-rpc-copy-stream-url"
                        label="Copy stream URL"
                        action={() => {
                            const url = (streamingWithUrl[0] as any).url?.trim?.();
                            if (url) {
                                copyToClipboard(url);
                                Toasts.show({
                                    id: Toasts.genId(),
                                    message: "Copied stream URL",
                                    type: Toasts.Type.SUCCESS,
                                    options: { position: Toasts.Position.BOTTOM },
                                });
                            }
                        }}
                    />
                    {streamingWithUrl.length > 1 && streamingWithUrl.slice(1).map((act, i) => (
                        <Menu.MenuItem
                            key={i}
                            id={`live-rpc-copy-stream-${i}`}
                            label={act.name ? `Copy stream: ${act.name}` : "Copy stream URL"}
                            action={() => {
                                const url = (act as any).url?.trim?.();
                                if (url) {
                                    copyToClipboard(url);
                                    Toasts.show({
                                        id: Toasts.genId(),
                                        message: "Copied stream URL",
                                        type: Toasts.Type.SUCCESS,
                                        options: { position: Toasts.Position.BOTTOM },
                                    });
                                }
                            }}
                        />
                    ))}
                </>
            )}
            <Menu.MenuItem
                id="clone-to-live-rpc-editor"
                label="Clone to Live RPC Editor"
                children={activities.map((act, i) => (
                    <Menu.MenuItem
                        key={act.id ?? i}
                        id={`live-rpc-clone-${act.id ?? i}`}
                        label={act.name}
                        action={() => openLiveRpcEditor(act, userId)}
                    />
                ))}
            />
        </Menu.MenuGroup>
    );
}

function RpcIcon({ colorClass, width, height }: { color?: string; colorClass?: string; width?: number; height?: number; }) {
    return (
        <svg className={colorClass} width={width ?? 20} height={height ?? 20} viewBox="0 0 24 24" fill="currentColor">
            <path d="m13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z" />
        </svg>
    );
}

function registerRpcDock() {
    addDockButton("liverpc", {
        icon: RpcIcon,
        tooltipText: "Live RPC Editor",
        glowing: settings.store.rpcActive,
        glowColor: "green",
        onClick: () => {
            settings.store.rpcActive = !settings.store.rpcActive;
            if (settings.store.rpcActive) {
                const saved = settings.store.savedFormState;
                if (saved && typeof saved === "object" && typeof (saved as any).name === "string" && (saved as any).name.trim()) {
                    const act = formStateToActivity(saved as Record<string, unknown>);
                    if (act) resolveAssetIds(act).then(dispatchActivity);
                }
            } else {
                dispatchActivity(null);
            }
            registerRpcDock();
        },
        onContextMenu: e => { e.preventDefault(); openLiveRpcEditor(); },
    });
}

export default definePlugin({
    name: "Live RPC Editor",
    openSettingsModal: () => openLiveRpcEditor(),
    description: "Edit custom presence with live preview. Alt+R to open. Clone any user's activities. Right-click user: Copy stream URL or Clone to Live RPC Editor. Presence persists across restarts.",
    authors: [{ name: "gabe", id: 1467949308816003193n }],
    settings,
    contextMenus: { "user-context": buildUserContextMenu },
    patches: [
        {
            find: ".USER_PROFILE_ACCOUNT_POPOUT)",
            replacement: {
                match: /function (\i)\(\i\)\{let \i,\i,\i,\i,\i,\i,\i,\i,\i,\{currentUser:\i,onClose:\i,setPopoutRef:\i,highlightBadge:\i,openedAt:\i,className:\i\}/,
                replace: "globalThis.__VC_AccountPopout=$1;$&",
            },
        },
        {
            find: ".USER_PROFILE_ACTIVITY_BUTTONS),",
            replacement: {
                match: /.getId\(\)===\i\.id/,
                replace: "$& && false"
            }
        },
        {
            find: "getAnyDiscoverableStreamForUser(e),[e]",
            replacement: {
                match: /return t===(\i)\.(\i)\.BLOCKED\?null:(\i)/,
                replace: "return t===$1.$2.BLOCKED||$self.shouldHideStream(e)?null:$3",
            }
        },
        {
            find: "getVisibleRunningGames().find",
            replacement: {
                match: /null==(\i)&&\((\i)=.{0,60}"43zohO".{0,10},(\i)=!0\)/,
                replace: "false"
            }
        },
        {
            find: "CUSTOM_STATUS:return 4",
            replacement: {
                match: /let (\i)=(\i)=>\{switch\(\2\.type\)\{case (\i)\.\i\.CUSTOM_STATUS:return 4/,
                replace: 'let $1=$2=>{if($2.metadata?.socketId==="LiveRpcEditor")return 5;switch($2.type){case $3.$pd.CUSTOM_STATUS:return 4',
            }
        },
    ],
    dependencies: ["PluginDock"],
    start() {
        if (!settings.store.presets) settings.store.presets = {};
        const saved = settings.store.savedFormState;
        if (saved && typeof saved === "object" && typeof (saved as any).name === "string" && (saved as any).name.trim()) {
            settings.store.rpcActive = true;
            const act = formStateToActivity(saved as Record<string, unknown>);
            if (act) {
                resolveAssetIds(act).then(dispatchActivity);
            }
        }
        registerRpcDock();
        const handler = (e: KeyboardEvent) => {
            if (matchKb(e, settings.store.keybind)) {
                e.preventDefault();
                openLiveRpcEditor();
            }
        };
        document.addEventListener("keydown", handler, true);
        this._keyHandler = handler;
    },
    stop() {
        removeDockButton("liverpc");
        if (this._keyHandler) document.removeEventListener("keydown", this._keyHandler, true);
        dispatchActivity(null);
    },

    shouldHideStream(userId: string) {
        if (!settings.store.rpcActive || userId !== UserStore.getCurrentUser()?.id) return false;
        const saved = settings.store.savedFormState;
        return saved && typeof saved === "object" && typeof (saved as any).name === "string" && !!(saved as any).name.trim();
    },
});
