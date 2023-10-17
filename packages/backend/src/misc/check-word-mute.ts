import RE2 from "re2";
import type { Note } from "@/models/entities/note.js";
import { DriveFile } from "@/models/entities/drive-file";
import { scyllaClient, type ScyllaNote } from "@/db/scylla.js";

type NoteLike = {
	userId: Note["userId"];
	text: Note["text"];
	files?: DriveFile[];
	cw?: Note["cw"];
};

function checkWordMute(
	note: NoteLike | ScyllaNote,
	mutedWords: Array<string | string[]>,
): boolean {
	if (note == null) return false;

	let text = `${note.cw ?? ""} ${note.text ?? ""}`;
	if (note.files && note.files.length > 0)
		text += ` ${note.files.map((f) => f.comment ?? "").join(" ")}`;

	if (scyllaClient) {
		const scyllaNote = note as ScyllaNote;
		text += `${scyllaNote.replyCw ?? ""} ${scyllaNote.replyText ?? ""} ${
			scyllaNote.renoteCw ?? ""
		} ${scyllaNote.renoteText ?? ""}`;

		if (scyllaNote.replyFiles && scyllaNote.replyFiles.length > 0) {
			text += ` ${scyllaNote.replyFiles.map((f) => f.comment ?? "").join(" ")}`;
		}
		if (scyllaNote.renoteFiles && scyllaNote.renoteFiles.length > 0) {
			text += ` ${scyllaNote.renoteFiles
				.map((f) => f.comment ?? "")
				.join(" ")}`;
		}
	}
	text = text.trim();

	if (text === "") return false;

	for (const mutePattern of mutedWords) {
		if (Array.isArray(mutePattern)) {
			// Clean up
			const keywords = mutePattern.filter((keyword) => keyword !== "");

			if (
				keywords.length > 0 &&
				keywords.every((keyword) =>
					text.toLowerCase().includes(keyword.toLowerCase()),
				)
			)
				return true;
		} else {
			// represents RegExp
			const regexp = mutePattern.match(/^\/(.+)\/(.*)$/);

			// This should never happen due to input sanitisation.
			if (!regexp) {
				console.warn(`Found invalid regex in word mutes: ${mutePattern}`);
				continue;
			}

			try {
				if (new RE2(regexp[1], regexp[2]).test(text)) return true;
			} catch (err) {
				// This should never happen due to input sanitisation.
			}
		}
	}

	return false;
}

export async function getWordHardMute(
	note: NoteLike,
	meId: string | null | undefined,
	mutedWords?: Array<string | string[]>,
): Promise<boolean> {
	if (note.userId === meId || mutedWords == null) return false;

	let ng = false;

	if (mutedWords.length > 0) {
		ng = checkWordMute(note, mutedWords);

		if (!scyllaClient) {
			ng =
				ng ||
				checkWordMute(note.reply, mutedWords) ||
				checkWordMute(note.renote, mutedWords);
		}
	}

	return ng;
}
