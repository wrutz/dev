/*
 * Equicord, a Discord client mod
 * Copyright (c) 2026 Equicord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import { Tooltip, useCallback, useEffect, useMemo, useState } from "@webpack/common";

import { addDockMutationListener, getDockItems, refreshDock, removeDockMutationListener } from "../pluginDock";
import { cl, parseStringArray } from "./shared";

interface DockSettings {
    dockOrder: string;
    dockHidden: string;
}

export function DockTab({ settings }: { settings: DockSettings; }) {
    const [, forceUpdate] = useState(0);
    const [dragId, setDragId] = useState<string | null>(null);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);

    useEffect(() => {
        const cb = () => forceUpdate(x => x + 1);
        addDockMutationListener(cb);
        return () => removeDockMutationListener(cb);
    }, []);

    const items = useMemo(() => {
        const raw = getDockItems();
        const order = parseStringArray(settings.dockOrder);
        const orderIndex = new Map(order.map((id, i) => [id, i]));
        return raw
            .map(([id, entry]) => ({ id, entry }))
            .sort((a, b) => {
                const ai = orderIndex.get(a.id);
                const bi = orderIndex.get(b.id);
                if (ai != null && bi != null) return ai - bi;
                if (ai != null) return -1;
                if (bi != null) return 1;
                return (a.entry.priority ?? 0) - (b.entry.priority ?? 0);
            });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings.dockOrder]);

    const hidden = useMemo(
        () => new Set(parseStringArray(settings.dockHidden)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [settings.dockHidden]
    );

    const toggleHidden = useCallback((id: string) => {
        const next = new Set(hidden);
        if (next.has(id)) next.delete(id); else next.add(id);
        settings.dockHidden = JSON.stringify(Array.from(next));
        refreshDock();
        forceUpdate(x => x + 1);
    }, [hidden, settings]);

    const commitOrder = useCallback((draggedId: string, beforeId: string | null) => {
        const currentOrder = items.map(i => i.id);
        const from = currentOrder.indexOf(draggedId);
        if (from === -1) return;
        currentOrder.splice(from, 1);
        if (beforeId == null) {
            currentOrder.push(draggedId);
        } else {
            const to = currentOrder.indexOf(beforeId);
            currentOrder.splice(to === -1 ? currentOrder.length : to, 0, draggedId);
        }
        settings.dockOrder = JSON.stringify(currentOrder);
        refreshDock();
        forceUpdate(x => x + 1);
    }, [items, settings]);

    if (items.length === 0) {
        return <div className={cl("empty")}>No dock buttons registered.</div>;
    }

    return (
        <div className={cl("dock-wrap")}>
            <div className={cl("dock-hint")}>Drag icons to reorder. Use the toggle under each icon to hide it from the dock.</div>
            <div className={cl("dock-strip")}>
                {items.map(({ id, entry }) => {
                    const isDragging = dragId === id;
                    const isDropTarget = dropTargetId === id && dragId && dragId !== id;
                    const isHidden = hidden.has(id);
                    const Icon = entry.props.icon;
                    return (
                        <div key={id} className={cl("dock-cell")}>
                            <Tooltip text={entry.props.tooltipText}>
                                {tooltipProps => (
                                    <div
                                        {...tooltipProps}
                                        className={classes(
                                            cl("dock-icon"),
                                            isDragging && cl("dock-icon-dragging"),
                                            isDropTarget && cl("dock-icon-drop"),
                                            isHidden && cl("dock-icon-hidden"),
                                        )}
                                        draggable
                                        onDragStart={e => {
                                            setDragId(id);
                                            e.dataTransfer.effectAllowed = "move";
                                            e.dataTransfer.setData("text/plain", id);
                                        }}
                                        onDragOver={e => { e.preventDefault(); setDropTargetId(id); }}
                                        onDragLeave={() => setDropTargetId(d => d === id ? null : d)}
                                        onDrop={e => {
                                            e.preventDefault();
                                            const dragged = e.dataTransfer.getData("text/plain");
                                            if (dragged && dragged !== id) commitOrder(dragged, id);
                                            setDragId(null);
                                            setDropTargetId(null);
                                        }}
                                        onDragEnd={() => { setDragId(null); setDropTargetId(null); }}
                                    >
                                        <Icon width={28} height={28} />
                                    </div>
                                )}
                            </Tooltip>
                            <button
                                type="button"
                                className={classes(cl("dock-visibility"), !isHidden && cl("dock-visibility-on"))}
                                onClick={() => toggleHidden(id)}
                                aria-label={`${isHidden ? "Show" : "Hide"} ${id}`}
                            >
                                <div className={cl("dock-visibility-knob")} />
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
