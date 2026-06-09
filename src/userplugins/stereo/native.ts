/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, IpcMainInvokeEvent } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const INSTALLS = ["discord", "discordcanary", "discordptb"];

interface InstallInfo {
    install: string;
    label: string;
    voiceDir: string | null;
    nodePath: string | null;
    indexPath: string | null;
    hasNodeBackup: boolean;
    hasIndexBackup: boolean;
    error?: string;
    nodeSize?: number;
    bakSize?: number;
    patches: Record<string, boolean | null>;
}

function labelFor(install: string): string {
    if (install === "discord") return "Stable";
    if (install === "discordcanary") return "Canary";
    if (install === "discordptb") return "PTB";
    return install;
}

function findVoiceDir(installName: string): { voiceDir: string; nodePath: string; indexPath: string; } | null {
    const base = path.join(os.homedir(), ".config", installName);
    let entries: string[];
    try {
        entries = fs.readdirSync(base).sort().reverse();
    } catch {
        return null;
    }
    for (const entry of entries) {
        const candidates = [
            path.join(base, entry, "modules", "discord_voice", "discord_voice.node"),
            path.join(base, entry, "modules", "discord_voice-1", "discord_voice", "discord_voice.node"),
        ];
        for (const node of candidates) {
            if (fs.existsSync(node)) {
                const voiceDir = path.dirname(node);
                return {
                    voiceDir,
                    nodePath: node,
                    indexPath: path.join(voiceDir, "index.js"),
                };
            }
        }
    }
    return null;
}

function bytesFind(buf: Buffer, pattern: number[], startAt = 0): number {
    outer: for (let i = startAt; i <= buf.length - pattern.length; i++) {
        for (let j = 0; j < pattern.length; j++) {
            if (buf[i + j] !== pattern[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function bytesIncludes(buf: Buffer, pattern: number[]): boolean {
    return bytesFind(buf, pattern) >= 0;
}

function bytesCount(buf: Buffer, pattern: number[]): number {
    let count = 0;
    let i = 0;
    while (i <= buf.length - pattern.length) {
        const f = bytesFind(buf, pattern, i);
        if (f < 0) break;
        count++;
        i = f + 1;
    }
    return count;
}

function detectPatches(nodeBuf: Buffer | null, bakBuf: Buffer | null, indexContent: string | null): Record<string, boolean | null> {
    if (!nodeBuf) return {};

    const len = bakBuf ? Math.min(nodeBuf.length, bakBuf.length) : 0;

    // 1. Stereo cmovae→mov+nop. Detect by comparing bak vs current at the SAME
    //    offset for the cmovae 48 0F 43 D0 → 48 89 C2 90 flip.
    let stereoCmovae: boolean | null = null;
    if (bakBuf) {
        let flips = 0;
        for (let i = 0; i < len - 3; i++) {
            if (
                bakBuf[i] === 0x48 && bakBuf[i + 1] === 0x0F && bakBuf[i + 2] === 0x43 && bakBuf[i + 3] === 0xD0
                && nodeBuf[i] === 0x48 && nodeBuf[i + 1] === 0x89 && nodeBuf[i + 2] === 0xC2 && nodeBuf[i + 3] === 0x90
            ) flips++;
        }
        stereoCmovae = flips > 0;
    }

    // 2. CreateAudioFrameToProcess channels 1→2. Detect flips at SAME offset:
    //    bak has 41 [BC|BD|BE|BF] 01 00 00 00, current has 02 at offset+2.
    let audioChannels: boolean | null = null;
    if (bakBuf) {
        const regs = new Set([0xBC, 0xBD, 0xBE, 0xBF]);
        let flips = 0;
        for (let i = 0; i < len - 5; i++) {
            if (
                bakBuf[i] === 0x41 && regs.has(bakBuf[i + 1])
                && bakBuf[i + 2] === 0x01 && bakBuf[i + 3] === 0x00 && bakBuf[i + 4] === 0x00 && bakBuf[i + 5] === 0x00
                && nodeBuf[i] === 0x41 && nodeBuf[i + 1] === bakBuf[i + 1]
                && nodeBuf[i + 2] === 0x02
            ) flips++;
        }
        audioChannels = flips > 0;
    }

    // 3. (Removed: bitrate cap — handled by plugin at runtime.)

    // 4. ApplyConfig kills. Detect at-offset flips from jcc (74/75) → jmp (EB).
    let applyConfigKills: boolean | null = null;
    if (bakBuf) {
        let flips = 0;
        for (let i = 0; i < len; i++) {
            const b = bakBuf[i];
            if ((b === 0x74 || b === 0x75) && nodeBuf[i] === 0xEB) flips++;
        }
        applyConfigKills = flips > 0;
    }

    // 5. multi_channel_capture injection: marker present in current, not in bak.
    let multiChannelCapture: boolean | null = null;
    const marker = [0x41, 0xC6, 0x87, 0x3D, 0x01, 0x00, 0x00, 0x01];
    const currentHasMarker = bytesIncludes(nodeBuf, marker);
    if (bakBuf) {
        const bakHasMarker = bytesIncludes(bakBuf, marker);
        multiChannelCapture = currentHasMarker && !bakHasMarker;
    } else {
        multiChannelCapture = currentHasMarker;
    }

    // 6. Kill Audio Network Adaptor: bak has 55 (push rbp) at function start,
    //    current has C3 (ret) at the same offset.
    let audioNetworkAdaptor: boolean | null = null;
    if (bakBuf) {
        let flips = 0;
        for (let i = 0; i < len; i++) {
            if (bakBuf[i] === 0x55 && nodeBuf[i] === 0xC3) flips++;
        }
        audioNetworkAdaptor = flips > 0;
    }

    // 7. Opus AUDIO mode: bak has 41 BD 00 08 00 00, current has 41 BD 01 08 00 00.
    let opusAudioMode: boolean | null = null;
    if (bakBuf) {
        let flips = 0;
        for (let i = 0; i < len - 5; i++) {
            if (
                bakBuf[i] === 0x41 && bakBuf[i + 1] === 0xBD
                && bakBuf[i + 2] === 0x00 && bakBuf[i + 3] === 0x08 && bakBuf[i + 4] === 0x00 && bakBuf[i + 5] === 0x00
                && nodeBuf[i] === 0x41 && nodeBuf[i + 1] === 0xBD
                && nodeBuf[i + 2] === 0x01 && nodeBuf[i + 3] === 0x08 && nodeBuf[i + 4] === 0x00 && nodeBuf[i + 5] === 0x00
            ) flips++;
        }
        opusAudioMode = flips > 0;
    }

    return {
        stereoCmovae,
        audioChannels,
        applyConfigKills,
        multiChannelCapture,
        audioNetworkAdaptor,
        opusAudioMode,
    };
}

function readSafe(filePath: string): Buffer | null {
    try { return fs.readFileSync(filePath); } catch { return null; }
}

function readTextSafe(filePath: string): string | null {
    try { return fs.readFileSync(filePath, "utf-8"); } catch { return null; }
}

export async function captureRect(_e: IpcMainInvokeEvent, rect: { x: number; y: number; width: number; height: number; }): Promise<string | null> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const r = {
        x: Math.max(0, Math.floor(rect.x)),
        y: Math.max(0, Math.floor(rect.y)),
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
    };
    const img = await win.webContents.capturePage(r);
    return img.toPNG().toString("base64");
}

export async function saveScreenshot(_e: IpcMainInvokeEvent, base64: string, name: string): Promise<string> {
    const dir = path.join(os.homedir(), "Pictures", "EquicordModals");
    fs.mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const file = path.join(dir, `${safe}-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(base64, "base64"));
    return file;
}

export async function getPatchStates(_e: IpcMainInvokeEvent): Promise<InstallInfo[]> {
    const result: InstallInfo[] = [];
    for (const install of INSTALLS) {
        const found = findVoiceDir(install);
        if (!found) {
            result.push({
                install,
                label: labelFor(install),
                voiceDir: null,
                nodePath: null,
                indexPath: null,
                hasNodeBackup: false,
                hasIndexBackup: false,
                patches: {},
            });
            continue;
        }
        const { voiceDir, nodePath, indexPath } = found;
        const bakNodePath = nodePath + ".bak";
        const bakIndexPath = indexPath + ".bak";
        const hasNodeBackup = fs.existsSync(bakNodePath);
        const hasIndexBackup = fs.existsSync(bakIndexPath);
        try {
            const nodeBuf = readSafe(nodePath);
            const bakBuf = hasNodeBackup ? readSafe(bakNodePath) : null;
            const indexContent = readTextSafe(indexPath);
            const patches = detectPatches(nodeBuf, bakBuf, indexContent);
            result.push({
                install,
                label: labelFor(install),
                voiceDir,
                nodePath,
                indexPath,
                hasNodeBackup,
                hasIndexBackup,
                nodeSize: nodeBuf?.length,
                bakSize: bakBuf?.length,
                patches,
            });
        } catch (e: any) {
            result.push({
                install,
                label: labelFor(install),
                voiceDir,
                nodePath,
                indexPath,
                hasNodeBackup,
                hasIndexBackup,
                error: e?.message ?? String(e),
                patches: {},
            });
        }
    }
    return result;
}
