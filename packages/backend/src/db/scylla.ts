import config from "@/config/index.js";
import type { Channel } from "@/models/entities/channel.js";
import type { Note } from "@/models/entities/note.js";
import type { NoteReaction } from "@/models/entities/note-reaction.js";
import { Client, types, tracker } from "cassandra-driver";
import type { User } from "@/models/entities/user.js";
import { Cache } from "@/misc/cache.js";
import { getTimestamp } from "@/misc/gen-id.js";
import Logger from "@/services/logger.js";
import { getWordHardMute } from "@/misc/check-word-mute.js";
import type { UserProfile } from "@/models/entities/user-profile.js";
import { scyllaQueries } from "@/db/cql.js";
import { notificationTypes } from "@/types.js";

export const scyllaLogger = new Logger("scylla");

function newClient(): Client | null {
	if (!config.scylla) {
		return null;
	}

	const requestTracker = new tracker.RequestLogger({
		slowThreshold: 1000,
	});

	const client = new Client({
		contactPoints: config.scylla.nodes,
		localDataCenter: config.scylla.localDataCentre,
		keyspace: config.scylla.keyspace,
		pooling: {
			coreConnectionsPerHost: {
				[types.distance.local]: config.scylla.connections?.local || 2,
				[types.distance.remote]: config.scylla.connections?.remote || 1,
			},
			maxRequestsPerConnection:
				config.scylla.connections?.maxRequestsPerConnection || 2048,
		},
		requestTracker,
		credentials: config.scylla.credentials,
	});

	client.on("log", (level, loggerName, message, _furtherInfo) => {
		const msg = `${loggerName} - ${message}`;
		switch (level) {
			case "info":
				scyllaLogger.info(msg);
				break;
			case "warning":
				scyllaLogger.warn(msg);
				break;
			case "error":
				scyllaLogger.error(msg);
				break;
		}
	});
	client.on("slow", (message) => {
		scyllaLogger.warn(message);
	});
	client.on("large", (message) => {
		scyllaLogger.warn(message);
	});

	return client;
}

export const scyllaClient = newClient();
export const prepared = scyllaQueries;

const localPostCountCache = new Cache<number>("localPostCount", 1000 * 60 * 60);
const allPostCountCache = new Cache<number>("allPostCount", 1000 * 60 * 60);
const reactionCountCache = new Cache<number>("reactionCount", 1000 * 60 * 60);

export async function fetchPostCount(local = false): Promise<number> {
	if (!scyllaClient) {
		throw new Error("ScyllaDB is disabled");
	}

	if (local) {
		return await localPostCountCache.fetch(null, () =>
			scyllaClient
				.execute("SELECT COUNT(*) FROM local_note_by_user_id", [], {
					prepare: true,
				})
				.then((result) => result.first().get("count"))
				.then(Number),
		);
	}

	return await allPostCountCache.fetch(null, () =>
		scyllaClient
			.execute("SELECT COUNT(*) FROM note", [], { prepare: true })
			.then((result) => result.first().get("count"))
			.then(Number),
	);
}

export async function fetchReactionCount(): Promise<number> {
	if (!scyllaClient) {
		throw new Error("ScyllaDB is disabled");
	}

	return await reactionCountCache.fetch(null, () =>
		scyllaClient
			.execute("SELECT COUNT(*) FROM reaction", [], { prepare: true })
			.then((result) => result.first().get("count"))
			.then(Number),
	);
}

export interface ScyllaNotification {
	targetId: string;
	createdAtDate: Date;
	createdAt: Date;
	id: string;
	notifierId: string | null;
	notifierHost: string | null;
	type: (typeof notificationTypes)[number];
	entityId: string | null;
	reaction: string | null;
	choice: number | null;
	customBody: string | null;
	customHeader: string | null;
	customIcon: string | null;
}

export function parseScyllaNotification(row: types.Row): ScyllaNotification {
	return {
		targetId: row.get("targetId"),
		createdAtDate: row.get("createdAt"),
		createdAt: row.get("createdAt"),
		id: row.get("id"),
		type: row.get("type"),
		notifierId: row.get("notifierId") || null,
		notifierHost: row.get("notifierHost") || null,
		entityId: row.get("entityId") || null,
		reaction: row.get("reaction") ?? null,
		choice: row.get("choice") ?? null,
		customBody: row.get("customBody") || null,
		customHeader: row.get("customHeader") || null,
		customIcon: row.get("customIcon") || null,
	};
}

export interface ScyllaDriveFile {
	id: string;
	type: string;
	createdAt: Date | string;
	name: string;
	comment: string | null;
	blurhash: string | null;
	url: string;
	thumbnailUrl: string | null;
	isSensitive: boolean;
	isLink: boolean;
	md5: string;
	size: number;
	width: number | null;
	height: number | null;
}

export function getScyllaDrivePublicUrl(
	file: ScyllaDriveFile,
	thumbnail = false,
): string | null {
	const isImage =
		file.type &&
		[
			"image/png",
			"image/apng",
			"image/gif",
			"image/jpeg",
			"image/webp",
			"image/svg+xml",
			"image/avif",
		].includes(file.type);

	return thumbnail
		? file.thumbnailUrl || (isImage ? file.url : null)
		: file.url;
}

export interface ScyllaNoteEditHistory {
	content: string | null;
	cw: string | null;
	files: ScyllaDriveFile[];
	updatedAt: Date;
}

export interface ScyllaPoll {
	expiresAt: Date | null;
	multiple: boolean;
	choices: Record<number, string>;
}

export interface ScyllaPollVote {
	noteId: string;
	userId: string;
	userHost: string | null;
	choice: Set<number>;
	createdAt: Date;
}

export function parseScyllaPollVote(row: types.Row): ScyllaPollVote {
	return {
		noteId: row.get("noteId"),
		userId: row.get("userId"),
		userHost: row.get("userHost") || null,
		choice: new Set(row.get("choice") ?? []),
		createdAt: row.get("createdAt"),
	};
}

export type ScyllaNote = Note & {
	createdAtDate: Date;
	files: ScyllaDriveFile[];
	noteEdit: ScyllaNoteEditHistory[];
	replyText: string | null;
	replyCw: string | null;
	replyFiles: ScyllaDriveFile[];
	renoteText: string | null;
	renoteCw: string | null;
	renoteFiles: ScyllaDriveFile[];
	poll: ScyllaPoll | null;
};

export function parseScyllaNote(row: types.Row): ScyllaNote {
	const files: ScyllaDriveFile[] = row.get("files") ?? [];
	const userHost = row.get("userHost");

	return {
		createdAtDate: row.get("createdAt"),
		createdAt: row.get("createdAt"),
		id: row.get("id"),
		visibility: row.get("visibility"),
		text: row.get("content") || null,
		lang: row.get("lang") || null,
		name: row.get("name") || null,
		cw: row.get("cw") || null,
		localOnly: row.get("localOnly"),
		renoteCount: row.get("renoteCount"),
		repliesCount: row.get("repliesCount"),
		uri: row.get("uri") || null,
		url: row.get("url") || null,
		score: row.get("score"),
		files,
		fileIds: files.map((file) => file.id),
		attachedFileTypes: files.map((file) => file.type) ?? [],
		visibleUserIds: row.get("visibleUserIds") ?? [],
		mentions: row.get("mentions") ?? [],
		emojis: row.get("emojis") ?? [],
		tags: row.get("tags") ?? [],
		hasPoll: row.get("hasPoll") ?? false,
		poll: row.get("poll") ?? null,
		threadId: row.get("threadId") || null,
		channelId: row.get("channelId") || null,
		userId: row.get("userId"),
		userHost: userHost !== "local" ? userHost : null,
		replyId: row.get("replyId") || null,
		replyUserId: row.get("replyUserId") || null,
		replyUserHost: row.get("replyUserHost") || null,
		replyText: row.get("replyContent") || null,
		replyCw: row.get("replyCw") || null,
		replyFiles: row.get("replyFiles") ?? [],
		renoteId: row.get("renoteId") || null,
		renoteUserId: row.get("renoteUserId") || null,
		renoteUserHost: row.get("renoteUserHost") || null,
		renoteText: row.get("renoteContent") || null,
		renoteCw: row.get("renoteCw") || null,
		renoteFiles: row.get("renoteFiles") ?? [],
		reactions: row.get("reactions") ?? {},
		noteEdit: row.get("noteEdit") ?? [],
		updatedAt: row.get("updatedAt") ?? null,
		mentionedRemoteUsers: row.get("mentionedRemoteUsers") || "[]",
		/* unused postgres denormalization */
		channel: null,
		renote: null,
		reply: null,
		user: null,
	};
}

export function parseHomeTimeline(
	row: types.Row,
): { feedUserId: string } & ScyllaNote {
	const note = parseScyllaNote(row);

	return {
		feedUserId: row.get("feedUserId"),
		...note,
	};
}

export type ScyllaNoteReaction = NoteReaction;

export type FeedType =
	| "home"
	| "local"
	| "recommended"
	| "global"
	| "renotes"
	| "user"
	| "channel"
	| "notification"
	| "list"
	| "reaction"
	| "antenna";

export function parseScyllaReaction(row: types.Row): ScyllaNoteReaction {
	return {
		id: row.get("id"),
		noteId: row.get("noteId"),
		userId: row.get("userId"),
		reaction: row.get("reaction"),
		createdAt: row.get("createdAt"),
	};
}

export function preparePaginationQuery(
	kind: FeedType,
	ps: {
		untilId?: string;
		untilDate?: number;
		sinceId?: string;
		sinceDate?: number;
	},
): { query: string; untilDate: Date; sinceDate: Date | null } {
	const queryParts: string[] = [];

	switch (kind) {
		case "home":
			queryParts.push(prepared.homeTimeline.select.byUserAndDate);
			break;
		case "local":
			queryParts.push(prepared.localTimeline.select.byDate);
			break;
		case "recommended":
		case "global":
			queryParts.push(prepared.globalTimeline.select.byDate);
			break;
		case "renotes":
			queryParts.push(prepared.note.select.byRenoteId);
			break;
		case "user":
		case "list":
			queryParts.push(prepared.note.select.byUserId);
			break;
		case "channel":
			queryParts.push(prepared.note.select.byChannelId);
			break;
		case "notification":
			queryParts.push(prepared.notification.select.byTargetId);
			break;
		case "reaction":
			queryParts.push(prepared.reaction.select.byUserId);
			break;
		default:
			queryParts.push(prepared.note.select.byDate);
	}

	queryParts.push(`AND "createdAt" < ?`);

	let until = new Date();
	if (ps.untilId) {
		until = new Date(getTimestamp(ps.untilId));
	}
	if (ps.untilDate && ps.untilDate < until.getTime()) {
		until = new Date(ps.untilDate);
	}
	let since: Date | null = null;
	if (ps.sinceId) {
		since = new Date(getTimestamp(ps.sinceId));
	}
	if (ps.sinceDate && (!since || ps.sinceDate > since.getTime())) {
		since = new Date(ps.sinceDate);
	}
	if (since !== null) {
		queryParts.push(`AND "createdAt" > ?`);
	}

	queryParts.push("LIMIT ?");

	const query = queryParts.join(" ");

	return {
		query,
		untilDate: until,
		sinceDate: since,
	};
}

export async function execPaginationQuery(
	kind: FeedType,
	ps: {
		limit: number;
		untilId?: string;
		untilDate?: number;
		sinceId?: string;
		sinceDate?: number;
		noteId?: string;
		channelId?: string;
		userIds?: string[];
	},
	filter?: {
		note?: (_: ScyllaNote[]) => ScyllaNote[];
		reaction?: (_: ScyllaNoteReaction[]) => Promise<ScyllaNoteReaction[]>;
		notification?: (_: ScyllaNotification[]) => Promise<ScyllaNotification[]>;
	},
	userId?: User["id"],
	maxPartitions = config.scylla?.sparseTimelineDays ?? 14,
): Promise<ScyllaNote[] | ScyllaNotification[] | ScyllaNoteReaction[]> {
	if (!scyllaClient) return [];

	switch (kind) {
		case "home":
		case "user":
		case "notification":
		case "reaction":
			if (!userId) throw new Error(`Feed ${kind} needs userId`);
			break;
		case "renotes":
			if (!ps.noteId) throw new Error(`Feed ${kind} needs noteId`);
			break;
		case "channel":
			if (!ps.channelId) throw new Error(`Feed ${kind} needs channelId`);
			break;
		case "list":
			if (!ps.userIds || ps.userIds.length === 0)
				throw new Error(`Feed ${kind} needs userIds`);
			break;
	}

	let { query, untilDate, sinceDate } = preparePaginationQuery(kind, ps);

	let scannedPartitions = 0;
	const found: ScyllaNote[] | ScyllaNotification[] | ScyllaNoteReaction[] = [];
	const queryLimit = config.scylla?.queryLimit ?? 100;
	let foundLimit = ps.limit;
	if (kind === "list" && ps.userIds) {
		foundLimit *= ps.userIds.length;
	}

	// Try to get posts of at most <maxPartitions> in the single request
	while (found.length < foundLimit && scannedPartitions < maxPartitions) {
		const params: (Date | string | string[] | number)[] = [];
		if (kind === "home" && userId) {
			params.push(userId, untilDate, untilDate);
		} else if (["user", "reaction"].includes(kind) && userId) {
			params.push(userId, untilDate);
		} else if (kind === "renotes" && ps.noteId) {
			params.push(ps.noteId, untilDate);
		} else if (kind === "channel" && ps.channelId) {
			params.push(ps.channelId, untilDate);
		} else if (kind === "notification" && userId) {
			params.push(userId, untilDate, untilDate);
		} else if (kind === "list" && ps.userIds) {
			const targetId = ps.userIds.pop();
			if (!targetId) break;
			params.push(targetId, untilDate);
		} else {
			params.push(untilDate, untilDate);
		}

		if (sinceDate) {
			params.push(sinceDate);
		}

		const fetchLimit =
			kind === "list" ? Math.min(ps.limit, queryLimit) : queryLimit;
		params.push(fetchLimit);

		const result = await scyllaClient.execute(query, params, {
			prepare: true,
		});

		if (result.rowLength > 0) {
			if (kind === "notification") {
				const notifications = result.rows.map(parseScyllaNotification);
				(found as ScyllaNotification[]).push(
					...(filter?.notification
						? await filter.notification(notifications)
						: notifications),
				);
				untilDate = notifications[notifications.length - 1].createdAt;
			} else if (kind === "reaction") {
				const reactions = result.rows.map(parseScyllaReaction);
				(found as ScyllaNoteReaction[]).push(
					...(filter?.reaction ? await filter.reaction(reactions) : reactions),
				);
				untilDate = reactions[reactions.length - 1].createdAt;
			} else {
				const notes = result.rows.map(parseScyllaNote);
				(found as ScyllaNote[]).push(
					...(filter?.note ? filter.note(notes) : notes),
				);
				untilDate = notes[notes.length - 1].createdAt;
			}
		}

		if (result.rowLength < fetchLimit) {
			// Reached the end of partition. Queries posts created one day before.
			scannedPartitions++;
			const yesterday = new Date(untilDate.getTime() - 86400000);
			yesterday.setHours(23, 59, 59, 990);
			untilDate = yesterday;
			if (sinceDate && untilDate < sinceDate) break;
		}
	}

	if (kind === "notification") {
		return found as ScyllaNotification[];
	} else if (kind === "reaction") {
		return found as ScyllaNoteReaction[];
	}

	return found as ScyllaNote[];
}

export function filterVisibility(
	notes: ScyllaNote[],
	user: { id: User["id"] } | null,
	followingIds: User["id"][],
): ScyllaNote[] {
	let filtered = notes;

	if (!user) {
		filtered = filtered.filter((note) =>
			["public", "home"].includes(note.visibility),
		);
	} else {
		filtered = filtered.filter(
			(note) =>
				["public", "home"].includes(note.visibility) ||
				note.userId === user.id ||
				note.visibleUserIds.includes(user.id) ||
				note.mentions.includes(user.id) ||
				(note.visibility === "followers" &&
					(followingIds.includes(note.userId) || note.replyUserId === user.id)),
		);
	}

	return filtered;
}

export function filterChannel(
	notes: ScyllaNote[],
	user: { id: User["id"] } | null,
	followingIds: Channel["id"][],
): ScyllaNote[] {
	let filtered = notes;

	if (!user) {
		filtered = filtered.filter((note) => !note.channelId);
	} else {
		const channelNotes = filtered.filter((note) => !!note.channelId);
		if (channelNotes.length > 0) {
			filtered = filtered.filter(
				(note) => !note.channelId || followingIds.includes(note.channelId),
			);
		}
	}

	return filtered;
}

export function filterReply(
	notes: ScyllaNote[],
	withReplies: boolean,
	user: { id: User["id"] } | null,
): ScyllaNote[] {
	let filtered = notes;

	if (!user) {
		filtered = filtered.filter(
			(note) => !note.replyId || note.replyUserId === note.userId,
		);
	} else if (!withReplies) {
		filtered = filtered.filter(
			(note) =>
				!note.replyId ||
				note.replyUserId === user.id ||
				note.userId === user.id ||
				note.replyUserId === note.userId,
		);
	}

	return filtered;
}

export function filterMutedUser(
	notes: ScyllaNote[],
	mutedIds: User["id"][],
	mutedInstances: UserProfile["mutedInstances"],
	exclude?: User,
): ScyllaNote[] {
	let userIds: User["id"][] = mutedIds;

	if (exclude) {
		userIds = mutedIds.filter((id) => id !== exclude.id);
	}

	return notes.filter(
		(note) =>
			!userIds.includes(note.userId) &&
			!(note.replyUserId && userIds.includes(note.replyUserId)) &&
			!(note.renoteUserId && userIds.includes(note.renoteUserId)) &&
			!(note.userHost && mutedInstances.includes(note.userHost)) &&
			!(note.replyUserHost && mutedInstances.includes(note.replyUserHost)) &&
			!(note.renoteUserHost && mutedInstances.includes(note.renoteUserHost)),
	);
}

export function filterMutedNote(
	notes: ScyllaNote[],
	user: { id: User["id"] },
	mutedWords: string[][],
): ScyllaNote[] {
	if (mutedWords.length > 0) {
		return notes.filter((note) => !getWordHardMute(note, user, mutedWords));
	}

	return notes;
}

export function filterBlockUser(
	notes: ScyllaNote[],
	blockIds: User["id"][],
): ScyllaNote[] {
	return notes.filter(
		(note) =>
			!blockIds.includes(note.userId) &&
			!(note.replyUserId && blockIds.includes(note.replyUserId)) &&
			!(note.renoteUserId && blockIds.includes(note.renoteUserId)),
	);
}

export function filterMutedRenotes(
	notes: ScyllaNote[],
	muteeIds: User["id"][],
): ScyllaNote[] {
	return notes.filter(
		(note) => note.text || !note.renoteId || !muteeIds.includes(note.userId),
	);
}
