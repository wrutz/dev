/*
 * Main-process native: read/write fakedms.json on disk.
 * Runs in Electron main process; called via VencordNative.pluginHelpers["FakeDms"].
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import type { IpcMainInvokeEvent } from "electron";

import { SETTINGS_DIR } from "../../main/utils/constants";

const FAKEDMS_FILE = join(SETTINGS_DIR, "fakedms.json");

export async function getFakes(_event: IpcMainInvokeEvent): Promise<unknown[]> {
    try {
        const raw = readFileSync(FAKEDMS_FILE, "utf-8");
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT")
            console.error("[FakeDMs] getFakes read error", e);
        return [];
    }
}

export async function setFakes(_event: IpcMainInvokeEvent, data: unknown[]): Promise<void> {
    try {
        const arr = Array.isArray(data) ? data : [];
        writeFileSync(FAKEDMS_FILE, JSON.stringify(arr), "utf-8");
    } catch (e) {
        console.error("[FakeDMs] setFakes write error", e);
    }
}
