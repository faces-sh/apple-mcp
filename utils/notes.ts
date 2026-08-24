import { run } from "@jxa/run";
import { ToolFailure, isPermissionDenial, throwAppleFailure } from "./native";
import { rawBody } from "./failure";

// We drive Notes through JXA (@jxa/run) rather than by interpolating user input into an AppleScript
// source string. JXA returns REAL JS objects/arrays (so there is no "string return treated as array"
// bug), and every user-controlled value (search text, title, body, folder name) is passed as a
// serialized *argument* to the script — so there is no script injection. JXA still goes through Apple
// Events, so the same Automation (kTCCServiceAppleEvents) permission applies: a denial surfaces as a
// thrown error which we convert to a typed ToolFailure (charter #2: denied is not empty is not broke).

// Maximum notes to scan in any one pass (guards against pathological note stores).
const MAX_NOTES = 1000;
// Per-note content cap for list/search previews. plaintext() can be very large; we return generous
// but bounded content so a single note can't blow up the response.
const MAX_CONTENT_PREVIEW = 2000;
// Folder used when the caller does not name one.
const DEFAULT_FOLDER = "Claude";

// The one sentence each outcome puts on line 1 of the envelope. It says WHAT DID NOT HAPPEN and
// stops: the envelope spec forbids inventing a remedy, because this server knows what macOS refused
// and knows nothing about what the person should do about it.
const NOTES_SUMMARIES = {
	denied: "Could not reach your notes: macOS denied access to Notes.",
	notRunning: "Could not reach your notes: the Notes app could not be reached.",
	timedOut: "Could not reach your notes: Notes did not answer in time.",
	failed: "Could not reach your notes.",
};
const NOTES_CREATE_SUMMARIES = {
	denied: "Could not create the note: macOS denied access to Notes.",
	notRunning: "Could not create the note: the Notes app could not be reached.",
	timedOut: "Could not create the note: Notes did not answer in time.",
	failed: "Could not create the note.",
};

type Note = {
	name: string;
	content: string;
	creationDate?: Date;
	modificationDate?: Date;
};

// `createNote` throws on every failure now, so this describes a note that EXISTS. There is no
// success flag to read and no failure message to render: a result object that could mean either was
// how "Failed to create note: ..." reached callers as ordinary text.
type CreateNoteResult = {
	note: Note;
	folderName: string;
	usedDefaultFolder: boolean;
};

type FolderNotesResult = {
	success: boolean;
	notes?: Note[];
	message?: string;
};

// Raw shapes returned across the JXA boundary (JSON-serialized; Dates arrive as epoch millis).
type RawNote = { name: string; content: string };
/** A bounded scan plus the bookkeeping that lets an all-failed pass be told apart from an empty one. */
type RawScan = {
	items: RawNote[];
	attempted: number;
	skipped: number;
	firstError: string;
};

/**
 * Fail when a scan touched notes and could not read a single one.
 *
 * Skipping an individual unreadable note is right: one bad note must not lose the other nine hundred.
 * But if every note we touched threw, "[]" is not an empty Notes library, it is a broken read reported
 * as a fact about the user's data, and that is exactly the swallowed failure the envelope spec exists
 * to stop. So the scan counts its skips and keeps the first thing Notes said, and an all-skipped pass
 * fails loudly with that verbatim.
 */
function failIfEverythingWasSkipped(scan: RawScan, summaryPrefix: string): void {
	if (scan.attempted > 0 && scan.skipped === scan.attempted) {
		throw new ToolFailure(
			"applescript_error",
			`${summaryPrefix}: all ${scan.attempted} notes failed to read.`,
			rawBody(scan.firstError),
		);
	}
}
type RawFolderNote = {
	name: string;
	content: string;
	creationDate: number | null;
	modificationDate: number | null;
};

/** Probe Notes access. Returns access state; never masks a non-permission failure. */
async function requestNotesAccess(): Promise<{
	hasAccess: boolean;
	message: string;
}> {
	try {
		await run(() => {
			// Touching the app's name is enough to trigger the Automation prompt / denial.
			return Application("Notes").name();
		});
		return { hasAccess: true, message: "Notes access is granted." };
	} catch (error) {
		if (isPermissionDenial(error)) {
			return { hasAccess: false, message: NOTES_SUMMARIES.denied };
		}
		// Not a denial, so this probe cannot answer the question it was asked. Surface it rather than
		// reporting "no access" for something that was never about access.
		throwAppleFailure(error, NOTES_SUMMARIES);
	}
}

/**
 * All notes across every folder, with name and a (bounded) plaintext preview. Empty array is a
 * genuine authorized-but-empty result; a permission denial throws a ToolFailure instead.
 */
async function getAllNotes(): Promise<Note[]> {
	let scan: RawScan;
	try {
		scan = (await run(
			(opts: { max: number; maxLen: number }) => {
				const Notes = Application("Notes");
				const all = Notes.notes();
				const out: { name: string; content: string }[] = [];
				const count = Math.min(all.length, opts.max);
				let skipped = 0;
				let firstError = "";
				for (let i = 0; i < count; i++) {
					try {
						const note = all[i];
						const rawName = note.name();
						let content = note.plaintext();
						content = typeof content === "string" ? content : "";
						if (content.length > opts.maxLen) {
							content = content.slice(0, opts.maxLen) + "…";
						}
						out.push({
							name: typeof rawName === "string" && rawName ? rawName : "Untitled Note",
							content,
						});
					} catch (_e) {
						// Skip an individual unreadable note; do not abort the whole scan.
						skipped++;
						if (!firstError) firstError = String(_e);
					}
				}
				return { items: out, attempted: count, skipped, firstError };
			},
			{ max: MAX_NOTES, maxLen: MAX_CONTENT_PREVIEW },
		)) as RawScan;
	} catch (error) {
		throwAppleFailure(error, NOTES_SUMMARIES);
	}

	failIfEverythingWasSkipped(scan, "Could not list your notes");
	return scan.items.map((n) => ({ name: n.name, content: n.content }));
}

/**
 * Notes whose title or body contains `searchText` (case-insensitive). Matching happens inside the
 * JXA pass using the *passed argument* (never interpolated source), so it is injection-safe and only
 * transfers the hits. Empty array = no match; a permission denial throws a ToolFailure.
 */
async function findNote(searchText: string): Promise<Note[]> {
	if (!searchText || searchText.trim() === "") return [];

	let scan: RawScan;
	try {
		scan = (await run(
			(opts: { search: string; max: number; maxLen: number }) => {
				const Notes = Application("Notes");
				const all = Notes.notes();
				const out: { name: string; content: string }[] = [];
				const needle = opts.search.toLowerCase();
				const count = Math.min(all.length, opts.max);
				let skipped = 0;
				let firstError = "";
				for (let i = 0; i < count; i++) {
					try {
						const note = all[i];
						const rawName = note.name();
						const rawPlain = note.plaintext();
						const name = typeof rawName === "string" ? rawName : "";
						const plain = typeof rawPlain === "string" ? rawPlain : "";
						const haystack = (name + "\n" + plain).toLowerCase();
						if (haystack.indexOf(needle) === -1) continue;
						let content = plain;
						if (content.length > opts.maxLen) {
							content = content.slice(0, opts.maxLen) + "…";
						}
						out.push({ name: name || "Untitled Note", content });
					} catch (_e) {
						// Skip an individual unreadable note; do not abort the whole scan.
						skipped++;
						if (!firstError) firstError = String(_e);
					}
				}
				return { items: out, attempted: count, skipped, firstError };
			},
			{ search: searchText, max: MAX_NOTES, maxLen: MAX_CONTENT_PREVIEW },
		)) as RawScan;
	} catch (error) {
		throwAppleFailure(error, NOTES_SUMMARIES);
	}

	failIfEverythingWasSkipped(scan, "Could not search your notes");
	return scan.items.map((n) => ({ name: n.name, content: n.content }));
}

/**
 * Create a note. Notes derives the title from the first line of the body, so we prepend `title`. If
 * `folderName` (default "Claude") does not exist we create it and report `usedDefaultFolder: true`.
 * Every failure throws a typed ToolFailure: a denial, an unreachable Notes app, a missing title.
 */
async function createNote(
	title: string,
	body: string,
	folderName: string = DEFAULT_FOLDER,
): Promise<CreateNoteResult> {
	if (!title || title.trim() === "") {
		throw new ToolFailure(
			"bad_request",
			"Could not create the note: no title was given.",
		);
	}

	const targetFolder =
		folderName && folderName.trim() !== "" ? folderName : DEFAULT_FOLDER;
	// Notes treats the first line of the body as the note's title.
	const noteBody = `${title}\n${body ?? ""}`;

	try {
		const result = (await run(
			(opts: { folderName: string; body: string }) => {
				const Notes = Application("Notes");

				// Locate the target folder by name (exact match on the passed argument).
				let folder: unknown = null;
				const folders = Notes.folders();
				for (let i = 0; i < folders.length; i++) {
					try {
						if (folders[i].name() === opts.folderName) {
							folder = folders[i];
							break;
						}
					} catch (_e) {
						// Skip an unreadable folder.
					}
				}

				let createdFolder = false;
				if (!folder) {
					folder = Notes.make({
						new: "folder",
						withProperties: { name: opts.folderName },
					});
					createdFolder = true;
				}

				Notes.make({
					new: "note",
					at: folder,
					withProperties: { body: opts.body },
				});

				return { folderName: opts.folderName, usedDefaultFolder: createdFolder };
			},
			{ folderName: targetFolder, body: noteBody },
		)) as { folderName: string; usedDefaultFolder: boolean };

		return {
			note: { name: title, content: body ?? "" },
			folderName: result.folderName,
			usedDefaultFolder: result.usedDefaultFolder,
		};
	} catch (error) {
		// EVERY failure here throws, including the ones that used to come back as success:false with the
		// reason folded into a sentence. A caller reading a result object cannot tell "the note was not
		// created" from "the note was created and here is a note about it", and the reason Notes gave
		// was being rewritten on its way out. Now it travels verbatim on the envelope instead.
		throwAppleFailure(error, NOTES_CREATE_SUMMARIES);
	}
}

/**
 * Scan a single folder by name. Returns `{ found, notes }` with each note's bounded content plus its
 * creation/modification timestamps (epoch millis). `found: false` means the folder genuinely does not
 * exist; a permission denial throws a ToolFailure.
 */
async function scanFolder(
	folderName: string,
): Promise<{ found: boolean; notes: Note[] }> {
	try {
		const raw = (await run(
			(opts: { folderName: string; max: number; maxLen: number }) => {
				const Notes = Application("Notes");

				let folder: unknown = null;
				const folders = Notes.folders();
				for (let i = 0; i < folders.length; i++) {
					try {
						if (folders[i].name() === opts.folderName) {
							folder = folders[i];
							break;
						}
					} catch (_e) {
						// Skip an unreadable folder.
					}
				}
				if (!folder) return { found: false, notes: [] };

				const folderNotes = (folder as { notes: () => unknown[] }).notes();
				const out: {
					name: string;
					content: string;
					creationDate: number | null;
					modificationDate: number | null;
				}[] = [];
				const count = Math.min(folderNotes.length, opts.max);
				for (let i = 0; i < count; i++) {
					try {
						const note = folderNotes[i] as {
							name: () => string;
							plaintext: () => string;
							creationDate: () => Date | null;
							modificationDate: () => Date | null;
						};
						const rawName = note.name();
						let content = note.plaintext();
						content = typeof content === "string" ? content : "";
						if (content.length > opts.maxLen) {
							content = content.slice(0, opts.maxLen) + "…";
						}
						let created: number | null = null;
						let modified: number | null = null;
						try {
							const d = note.creationDate();
							created = d ? d.getTime() : null;
						} catch (_e) {
							// Leave creation date absent.
						}
						try {
							const d = note.modificationDate();
							modified = d ? d.getTime() : null;
						} catch (_e) {
							// Leave modification date absent.
						}
						out.push({
							name: typeof rawName === "string" && rawName ? rawName : "Untitled Note",
							content,
							creationDate: created,
							modificationDate: modified,
						});
					} catch (_e) {
						// Skip an individual unreadable note; do not abort the whole scan.
					}
				}
				return { found: true, notes: out };
			},
			{ folderName, max: MAX_NOTES, maxLen: MAX_CONTENT_PREVIEW },
		)) as { found: boolean; notes: RawFolderNote[] };

		return {
			found: raw.found,
			notes: raw.notes.map((n) => ({
				name: n.name,
				content: n.content,
				creationDate: n.creationDate != null ? new Date(n.creationDate) : undefined,
				modificationDate:
					n.modificationDate != null ? new Date(n.modificationDate) : undefined,
			})),
		};
	} catch (error) {
		throwAppleFailure(error, NOTES_SUMMARIES);
	}
}

/** All notes in a named folder. success:false (with message) only when the folder does not exist. */
async function getNotesFromFolder(folderName: string): Promise<FolderNotesResult> {
	const { found, notes } = await scanFolder(folderName); // throws ToolFailure on denial
	if (!found) {
		return { success: false, message: `Folder "${folderName}" not found.` };
	}
	return { success: true, notes };
}

/** The `limit` most recently modified notes in a named folder (newest first). */
async function getRecentNotesFromFolder(
	folderName: string,
	limit: number = 5,
): Promise<FolderNotesResult> {
	const { found, notes } = await scanFolder(folderName); // throws ToolFailure on denial
	if (!found) {
		return { success: false, message: `Folder "${folderName}" not found.` };
	}
	const sorted = [...notes].sort((a, b) => {
		const ta = a.modificationDate ? a.modificationDate.getTime() : 0;
		const tb = b.modificationDate ? b.modificationDate.getTime() : 0;
		return tb - ta;
	});
	return { success: true, notes: sorted.slice(0, Math.max(0, limit)) };
}

/**
 * Notes in a named folder whose modification date falls within [fromDate, toDate] (ISO strings;
 * either bound optional), newest first, capped at `limit`.
 */
async function getNotesByDateRange(
	folderName: string,
	fromDate?: string,
	toDate?: string,
	limit: number = 20,
): Promise<FolderNotesResult> {
	const { found, notes } = await scanFolder(folderName); // throws ToolFailure on denial
	if (!found) {
		return { success: false, message: `Folder "${folderName}" not found.` };
	}

	const from = fromDate ? Date.parse(fromDate) : NaN;
	const to = toDate ? Date.parse(toDate) : NaN;

	const filtered = notes.filter((n) => {
		const t = n.modificationDate ? n.modificationDate.getTime() : null;
		if (t === null) return false;
		if (!Number.isNaN(from) && t < from) return false;
		if (!Number.isNaN(to) && t > to) return false;
		return true;
	});

	filtered.sort((a, b) => {
		const ta = a.modificationDate ? a.modificationDate.getTime() : 0;
		const tb = b.modificationDate ? b.modificationDate.getTime() : 0;
		return tb - ta;
	});

	return { success: true, notes: filtered.slice(0, Math.max(0, limit)) };
}

export default {
	getAllNotes,
	findNote,
	createNote,
	getNotesFromFolder,
	getRecentNotesFromFolder,
	getNotesByDateRange,
	requestNotesAccess,
};
