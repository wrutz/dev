/*
 * Types and serialization for permanent fake messages.
 * Persistence is done via plugin Settings (VencordNative.settings) in index.tsx.
 */

export interface StoredFakeMessage {
    id: string;
    channelId: string;
    message: Record<string, unknown>;
}

/** Build a plain object suitable for storage (no class instances). */
export function serializeMessageForStore(m: {
    id: string;
    channel_id: string;
    timestamp: string;
    edited_timestamp?: string | null;
    content?: string;
    author?: { id: string; username?: string; global_name?: string; globalName?: string; avatar?: string; discriminator?: string; [k: string]: unknown };
    [k: string]: unknown;
}): Record<string, unknown> {
    const author = m.author as Record<string, unknown> | undefined;
    const a = author ? {
        id: author.id,
        username: author.username,
        global_name: author.global_name ?? author.globalName,
        avatar: author.avatar,
        discriminator: author.discriminator,
    } : null;
    return {
        id: m.id,
        channel_id: m.channel_id,
        timestamp: m.timestamp,
        edited_timestamp: m.edited_timestamp ?? null,
        content: m.content ?? "",
        flags: m.flags ?? 0,
        author: a,
        attachments: m.attachments ?? [],
        embeds: m.embeds ?? [],
        stickerItems: m.stickerItems ?? [],
        components: m.components ?? [],
        mentions: m.mentions ?? [],
        mentionRoles: m.mentionRoles ?? [],
        mentionChannels: m.mentionChannels ?? [],
        mentionEveryone: m.mentionEveryone ?? false,
        tts: m.tts ?? false,
        type: m.type ?? 0,
        messageReference: m.messageReference ?? undefined,
    };
}
