import { run } from "@jxa/run";
import {
	ToolFailure,
	assertAlignedColumns,
	grantSentence,
	isPermissionDenial,
	throwAppleFailure,
} from "./native";

// We drive Notes through JXA (@jxa/run) rather than by interpolating user input into an AppleScript
// source string. JXA returns REAL JS objects/arrays (so there is no "string return treated as array"
// bug), and every user-controlled value (search text, title, body, folder name) is passed as a
// serialized *argument* to the script — so there is no script injection. JXA still goes through Apple
// Events, so the same Automation (kTCCServiceAppleEvents) permission applies: a denial surfaces as a
// thrown error which we convert to a typed ToolFailure (charter #2: denied is not empty is not broke).

// ONE APPLE EVENT PER PROPERTY, NOT PER NOTE. This is the whole shape of every read below, and it is
// worth stating once because the obvious code does the opposite.
//
// The cost of talking to Notes is the NUMBER of Apple Events, not the volume of data. Measured on a
// real store of 3,152 notes:
//
//     Notes.notes.name()          0.20s   3,152 titles, ONE event
//     Notes.notes.plaintext()     0.24s   3.5 MB of bodies, ONE event
//     note.name() + note.plaintext(), one note at a time    1.08s PER NOTE
//
// So a loop that walks notes and asks each one for its title and body costs 1.08s x n, and asking the
// collection for all titles then all bodies costs 0.44s for the entire store. That is 0.44s against
// roughly 3,400s, and it is not a tuning difference: one is n round trips, the other is two.
//
// The same fact governs the folder scan, which pulled four properties per note (2.25s/note measured,
// 51.8s for a 29-note folder) and now pulls four arrays for the whole folder in one pass.
//
// WHAT THIS COSTS: the old loops guarded each note individually, so one unreadable note lost only
// itself. A collection read is a single event, so there is no per-note granularity left to skip with.
// A value Notes will not give is `missing value`, which arrives as a non-string and is coerced exactly
// the way the per-note path coerced a bad read (`noteName`, `notePreview` below). A read that fails
// OUTRIGHT now fails the call, loudly and verbatim, instead of returning a partial store as if it were
// the whole one. Password-protected notes are the case worth knowing about here and this store has
// none of them (0 of 3,152), so what a locked note does under a collection read is NOT something
// anybody has measured; treat it as open.

// Maximum notes RETURNED in any one pass.
//
// RAISED FROM 1000, and the truncation is now REPORTED rather than silent, for the same reason the
// contacts cap was: 1000 was not a pathological note store, it was smaller than this one. A real Mac
// here holds 3,152 notes, so 2,152 of them were invisible to every list AND every search, and the scan
// took the FIRST n, which means a note the user could see in Notes simply was not there when they asked
// for it. "No notes found" was indistinguishable from "not looked at".
//
// The cap now bounds the RESULT, not the reach: the bulk read always sees the whole store, so a search
// searches all of it and only the returned list is trimmed. What must never happen again is losing
// notes QUIETLY, so when the cap bites, the answer says so.
const MAX_NOTES = 5000;
// Per-note content cap for list/search previews. plaintext() can be very large; we return generous
// but bounded content so a single note can't blow up the response.
const MAX_CONTENT_PREVIEW = 2000;
// Folder used when the caller does not name one.
const DEFAULT_FOLDER = "Claude";

/** How many notes the last read returned, and how many there were to return. Read by the caller so a
 *  short answer can say whether it is the whole answer. Null once the cap stops biting. */
export let lastNotesTruncation: { shown: number; total: number } | null = null;

function recordTruncation(shown: number, total: number): void {
	lastNotesTruncation = total > shown ? { shown, total } : null;
}

// The one sentence each outcome puts on line 1 of the envelope. It says WHAT DID NOT HAPPEN, and for
// a denial it also NAMES the permission that is missing and the app to enable it for.
//
// Naming it is not inventing a remedy. Only this server can tell a denied Automation grant from a
// denied Contacts one, so nothing upstream could reconstruct that sentence, and dropping it deletes it
// rather than moving it somewhere better. What stays out is anything we would be guessing: no "then
// try again", no theory about why the grant is missing.
export const NOTES_SUMMARIES = {
	denied:
		"Could not reach your notes: macOS denied access to Notes. " +
		grantSentence("Automation > Notes"),
	notRunning: "Could not reach your notes: the Notes app could not be reached.",
	timedOut: "Could not reach your notes: Notes did not answer in time.",
	failed: "Could not reach your notes.",
};
export const NOTES_CREATE_SUMMARIES = {
	denied:
		"Could not create the note: macOS denied access to Notes. " +
		grantSentence("Automation > Notes"),
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

/** Aligned columns for a set of notes: `names[i]` and `bodies[i]` describe the same note. */
type NoteColumns = { names: unknown[]; bodies: unknown[] };
/** The same, plus the two timestamps (epoch millis, or null where Notes had none). */
type FolderColumns = NoteColumns & {
	found: boolean;
	created: (number | null)[];
	modified: (number | null)[];
};

/** A title Notes could not give us is still a note, and it is what the per-note loop called it. */
function noteName(raw: unknown): string {
	return typeof raw === "string" && raw ? raw : "Untitled Note";
}

/** A body Notes would not give us reads as empty, bounded either way. */
function notePreview(raw: unknown): string {
	const text = typeof raw === "string" ? raw : "";
	return text.length > MAX_CONTENT_PREVIEW
		? text.slice(0, MAX_CONTENT_PREVIEW) + "…"
		: text;
}

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
 * Every title and every body in the store, as two aligned columns, in two Apple Events.
 *
 * The columns cross the boundary WHOLE, and the trimming and the matching happen in TypeScript, where
 * they can be tested without a Mac. That is a deliberate choice about where the payload sits: @jxa/run
 * pipes the script's JSON through osascript's stdout with a 100 MB ceiling, and the whole of this store
 * is 3.5 MB, so there is room by a factor of thirty. A store big enough to breach it fails LOUDLY on
 * the buffer, which is the right answer; it never comes back quietly short.
 *
 * Trimming inside the script would bound the payload, and it would also mean a search could only see
 * the first 2,000 characters of a note, which is not what the per-note loop did.
 */
async function readStoreColumns(): Promise<NoteColumns> {
	let columns: NoteColumns;
	try {
		columns = (await run(() => {
			const Notes = Application("Notes");
			let names: unknown[] = [];
			let bodies: unknown[] = [];
			// Retaken once if the store moves between the two events; see assertAlignedColumns.
			for (let attempt = 0; attempt < 2; attempt++) {
				names = Notes.notes.name();
				bodies = Notes.notes.plaintext();
				if (names.length === bodies.length) break;
			}
			return { names, bodies };
		})) as NoteColumns;
	} catch (error) {
		throwAppleFailure(error, NOTES_SUMMARIES);
	}
	assertAlignedColumns(
		[columns.names.length, columns.bodies.length],
		"Could not read your notes: the note store changed while it was being read.",
	);
	return columns;
}

/**
 * All notes across every folder, with name and a (bounded) plaintext preview. Empty array is a
 * genuine authorized-but-empty result; a permission denial throws a ToolFailure instead.
 */
async function getAllNotes(): Promise<Note[]> {
	const { names, bodies } = await readStoreColumns();
	const total = names.length;
	const count = Math.min(total, MAX_NOTES);
	const out: Note[] = [];
	for (let i = 0; i < count; i++) {
		out.push({ name: noteName(names[i]), content: notePreview(bodies[i]) });
	}
	recordTruncation(count, total);
	return out;
}

/**
 * Notes whose title or body contains `searchText` (case-insensitive). The whole store is read in two
 * Apple Events and matched here, so the search sees EVERY note rather than the first thousand.
 * Empty array = no match; a permission denial throws a ToolFailure.
 *
 * Matching in JS rather than with a `whose` clause is measured, not assumed. Both find the same 14
 * notes for the same needle on this store, and `Notes.notes.whose({ plaintext: { _contains: needle } })`
 * took 2.51s against 0.49s for reading both columns and matching here. The predicate also cannot see a
 * title, so it would have to be run twice and merged to answer the question this one answers.
 */
async function findNote(searchText: string): Promise<Note[]> {
	if (!searchText || searchText.trim() === "") return [];

	const { names, bodies } = await readStoreColumns();
	const needle = searchText.toLowerCase();
	const hits: Note[] = [];
	for (let i = 0; i < names.length; i++) {
		const name = typeof names[i] === "string" ? (names[i] as string) : "";
		const body = typeof bodies[i] === "string" ? (bodies[i] as string) : "";
		if ((name + "\n" + body).toLowerCase().indexOf(needle) === -1) continue;
		hits.push({ name: name || "Untitled Note", content: notePreview(body) });
	}
	recordTruncation(Math.min(hits.length, MAX_NOTES), hits.length);
	return hits.slice(0, MAX_NOTES);
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

				// Locate the target folder by name. ONE Apple Event for every folder name, then an
				// index into the collection: 0.004s against 0.798s for asking each of this Mac's 45
				// folders its own name, which is work done before a note can even start being written.
				// Both find the same folder at the same index; verified by creating a note in a new
				// folder, a second in the same folder once it existed, reading them back, and deleting
				// the lot.
				const folderNames = Notes.folders.name();
				let index = -1;
				for (let i = 0; i < folderNames.length; i++) {
					if (folderNames[i] === opts.folderName) {
						index = i;
						break;
					}
				}

				let createdFolder = false;
				let folder: unknown;
				if (index >= 0) {
					folder = Notes.folders[index];
				} else {
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
 *
 * Five Apple Events, whatever the folder holds: the folder names, then four property columns. It used
 * to be one event per folder to find the folder plus four per note, which measured 51.8s for a folder
 * of 29 notes.
 */
async function scanFolder(
	folderName: string,
): Promise<{ found: boolean; notes: Note[] }> {
	let raw: FolderColumns;
	try {
		raw = (await run(
			(opts: { folderName: string }) => {
				const Notes = Application("Notes");

				const folderNames = Notes.folders.name();
				let index = -1;
				for (let i = 0; i < folderNames.length; i++) {
					if (folderNames[i] === opts.folderName) {
						index = i;
						break;
					}
				}
				if (index < 0) {
					return { found: false, names: [], bodies: [], created: [], modified: [] };
				}

				const folder = Notes.folders[index];
				const toMillis = (values: (Date | null)[]) =>
					values.map((d) => (d && typeof d.getTime === "function" ? d.getTime() : null));

				let names: unknown[] = [];
				let bodies: unknown[] = [];
				let created: (number | null)[] = [];
				let modified: (number | null)[] = [];
				// Retaken once if the folder moves between the events; see assertAlignedColumns.
				for (let attempt = 0; attempt < 2; attempt++) {
					names = folder.notes.name();
					bodies = folder.notes.plaintext();
					created = toMillis(folder.notes.creationDate());
					modified = toMillis(folder.notes.modificationDate());
					if (
						names.length === bodies.length &&
						names.length === created.length &&
						names.length === modified.length
					) {
						break;
					}
				}
				return { found: true, names, bodies, created, modified };
			},
			{ folderName },
		)) as FolderColumns;
	} catch (error) {
		throwAppleFailure(error, NOTES_SUMMARIES);
	}

	if (!raw.found) return { found: false, notes: [] };

	assertAlignedColumns(
		[raw.names.length, raw.bodies.length, raw.created.length, raw.modified.length],
		`Could not read your notes: the folder "${folderName}" changed while it was being read.`,
	);

	const total = raw.names.length;
	const count = Math.min(total, MAX_NOTES);
	const notes: Note[] = [];
	for (let i = 0; i < count; i++) {
		notes.push({
			name: noteName(raw.names[i]),
			content: notePreview(raw.bodies[i]),
			creationDate: raw.created[i] != null ? new Date(raw.created[i] as number) : undefined,
			modificationDate:
				raw.modified[i] != null ? new Date(raw.modified[i] as number) : undefined,
		});
	}
	recordTruncation(count, total);
	return { found: true, notes };
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
	truncation: () => lastNotesTruncation,
	getAllNotes,
	findNote,
	createNote,
	getNotesFromFolder,
	getRecentNotesFromFolder,
	getNotesByDateRange,
	requestNotesAccess,
};
