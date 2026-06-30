import { run } from "@jxa/run";
import {
	APP_NAME,
	PermissionError,
	isPermissionDenial,
	rethrowIfPermissionDenied,
} from "./native";

// We drive Notes through JXA (@jxa/run) rather than by interpolating user input into an AppleScript
// source string. JXA returns REAL JS objects/arrays (so there is no "string return treated as array"
// bug), and every user-controlled value (search text, title, body HTML, note id, folder name) is
// passed as a serialized *argument* to the script — so there is no script injection. JXA still goes
// through Apple Events, so the same Automation (kTCCServiceAppleEvents) permission applies: a denial
// surfaces as a thrown error which we convert to a typed PermissionError (denied ≠ empty ≠
// broke).
//
// Two perf invariants this module is built around (lessons paid for in production):
//   • Reads after a write are forbidden. A property read on a just-created/just-mutated note forces a
//     store/iCloud round-trip that blocks for SECONDS. Every create/update/delete returns the values
//     it SET (and identity it read *before* the write), never a re-read of the mutated note.
//   • Filter server-side. `search` uses `Notes.notes.whose({ _or:[{name:{_contains}},{plaintext:
//     {_contains}}] })` so the app returns only matching note references in one round-trip — we match
//     on TITLE *or* body text without loading every note's plaintext ourselves. `list` is the
//     deliberately heavy "show me everything" scan (bounded); `search` is the fast path.

// Maximum notes to scan in any one pass (guards against pathological note stores).
const MAX_NOTES = 1000;
// Per-note content cap for list previews. plaintext() can be very large; we return generous but
// bounded content so a single note can't blow up the response.
const MAX_CONTENT_PREVIEW = 2000;
// Folder used when the caller does not name one.
const DEFAULT_FOLDER = "Claude";

const NOTES_DENIED =
	`Notes access is not granted. In System Settings ▸ Privacy & Security ▸ Automation, grant ${APP_NAME} ` +
	"access to Notes, then try again.";

export type NoteFormat = "markdown" | "html" | "plain";

type NoteSummary = {
	name: string;
	id: string;
};

type Note = {
	name: string;
	content: string; // plaintext
	id?: string;
	body?: string; // HTML
	folderName?: string;
	creationDate?: Date;
	modificationDate?: Date;
};

type ListResult = {
	success: boolean;
	notes?: Note[];
	message?: string;
};

type CreateNoteResult = {
	success: boolean;
	note?: Note;
	message?: string;
	folderName?: string;
	createdFolder?: boolean;
};

type MutationResult = {
	success: boolean;
	id?: string;
	name?: string;
	message?: string;
};

type FolderInfo = {
	name: string;
	count: number | null;
};

type CreateFolderResult = {
	success: boolean;
	name: string;
	created: boolean; // false when the folder already existed (idempotent)
	message?: string;
};

// Raw shapes returned across the JXA boundary (JSON-serialized; Dates arrive as epoch millis).
type RawNote = {
	name: string;
	content: string;
	id: string | null;
	creationDate: number | null;
	modificationDate: number | null;
};
type RawFullNote = {
	found: boolean;
	name: string;
	content: string;
	body: string;
	id: string | null;
	folderName: string | null;
	creationDate: number | null;
	modificationDate: number | null;
};

// ── Markdown → HTML ───────────────────────────────────────────────────────────────────────────────
// Apple Notes stores each note's body as HTML and derives the note's TITLE from the first line. To let
// the agent produce nicely formatted notes (headings, bold/italic, lists, links, quotes, rules) we
// accept the body as Markdown (default) and convert it to HTML here, on the Node side, before handing
// the finished HTML string to JXA. `format:"html"` passes the caller's HTML through untouched;
// `format:"plain"` wraps text in line-preserving divs. This is a deliberately small, dependency-free
// converter — it covers the common block + inline constructs, not the full CommonMark grammar.

/** Escape the HTML metacharacters so user text is never interpreted as markup. */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Apply inline Markdown (links, bold, italic, code) to an already-HTML-escaped line. */
function inlineMarkdown(text: string): string {
	let t = escapeHtml(text);
	// Links: [label](url) — label keeps inline styling applied afterwards is unnecessary; keep simple.
	t = t.replace(
		/\[([^\]]+)\]\(([^)\s]+)\)/g,
		(_m, label: string, url: string) => `<a href="${url}">${label}</a>`,
	);
	// Inline code first so its contents aren't touched by emphasis rules.
	t = t.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
	// Bold (**x** / __x__) before italic so the double-marker wins.
	t = t.replace(/(\*\*|__)(.+?)\1/g, (_m, _mark, inner: string) => `<b>${inner}</b>`);
	// Italic (*x* / _x_).
	t = t.replace(/(\*|_)(?!\s)(.+?)(?<!\s)\1/g, (_m, _mark, inner: string) => `<i>${inner}</i>`);
	return t;
}

/** Convert a Markdown document to the HTML subset Apple Notes renders. */
function markdownToHtml(md: string): string {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const html: string[] = [];
	let listType: "ul" | "ol" | null = null;
	const closeList = () => {
		if (listType) {
			html.push(`</${listType}>`);
			listType = null;
		}
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		// Horizontal rule: ---, ***, ___
		if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
			closeList();
			html.push("<hr>");
			i++;
			continue;
		}
		// Heading: #..######
		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			closeList();
			const level = heading[1].length;
			html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
			i++;
			continue;
		}
		// Blockquote
		const quote = line.match(/^>\s?(.*)$/);
		if (quote) {
			closeList();
			html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
			i++;
			continue;
		}
		// Unordered list item
		const ul = line.match(/^\s*[-*+]\s+(.*)$/);
		if (ul) {
			if (listType !== "ul") {
				closeList();
				html.push("<ul>");
				listType = "ul";
			}
			html.push(`<li>${inlineMarkdown(ul[1])}</li>`);
			i++;
			continue;
		}
		// Ordered list item
		const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
		if (ol) {
			if (listType !== "ol") {
				closeList();
				html.push("<ol>");
				listType = "ol";
			}
			html.push(`<li>${inlineMarkdown(ol[1])}</li>`);
			i++;
			continue;
		}
		// Blank line ends a block.
		if (line.trim() === "") {
			closeList();
			i++;
			continue;
		}
		// Paragraph: gather consecutive lines until a blank or a block-level construct.
		closeList();
		const para = [line];
		i++;
		const blockStart = /^(#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+[.)]\s)/;
		const hr = /^\s*([-*_])\1{2,}\s*$/;
		while (
			i < lines.length &&
			lines[i].trim() !== "" &&
			!blockStart.test(lines[i]) &&
			!hr.test(lines[i])
		) {
			para.push(lines[i]);
			i++;
		}
		html.push(`<div>${para.map(inlineMarkdown).join("<br>")}</div>`);
	}
	closeList();
	return html.join("");
}

/** Wrap plain text in line-preserving divs (empty lines become a <br> spacer). */
function plainToHtml(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => (l.length ? `<div>${escapeHtml(l)}</div>` : "<div><br></div>"))
		.join("");
}

/** Convert a caller-supplied body into the HTML Apple Notes stores, per the requested format. */
function bodyToHtml(body: string, format: NoteFormat): string {
	switch (format) {
		case "html":
			return body;
		case "plain":
			return plainToHtml(body);
		case "markdown":
			return markdownToHtml(body);
	}
}

// ── Access probe ────────────────────────────────────────────────────────────────────────────────

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
			return { hasAccess: false, message: NOTES_DENIED };
		}
		throw error instanceof Error ? error : new Error(String(error));
	}
}

// ── Read: search (fast, title OR body) ────────────────────────────────────────────────────────────

/**
 * Notes whose TITLE *or* body text contains `searchText` (case-insensitive). FAST path: the match runs
 * server-side via `whose({ _or:[{name:{_contains}},{plaintext:{_contains}}] })`, so the app returns
 * only matching note references in one round-trip and we never load every note's plaintext ourselves.
 * Returns name + id (the id lets a follow-up get/update/delete target the exact note; use `get` to read
 * the full content of a hit). Empty array = no match; a permission denial throws.
 */
async function searchNotes(searchText: string): Promise<NoteSummary[]> {
	if (!searchText || searchText.trim() === "") return [];
	const needle = searchText.trim();

	try {
		const hits = (await run(
			(opts: { search: string; max: number }) => {
				const Notes = Application("Notes");
				const out: { name: string; id: string }[] = [];

				let matches: { name: () => string; id: () => string }[] = [];
				let whoseWorked = true;
				try {
					// Match TITLE or BODY text server-side in one round-trip (the app returns only the
					// matching note references; we never load plaintext across the whole store).
					matches = Notes.notes
						.whose({
							_or: [
								{ name: { _contains: opts.search } },
								{ plaintext: { _contains: opts.search } },
							],
						})();
				} catch (_e) {
					whoseWorked = false; // whose unsupported here → bounded fallback scan
				}

				if (whoseWorked) {
					const count = Math.min(matches.length, opts.max);
					for (let i = 0; i < count; i++) {
						try {
							out.push({ name: matches[i].name() || "Untitled Note", id: matches[i].id() });
						} catch (_e) {
							// Skip an individual unreadable match.
						}
					}
					return out;
				}

				// Fallback (only when whose is unsupported): bounded scan matching title OR body in JS.
				const all = Notes.notes();
				const needleLc = opts.search.toLowerCase();
				const count = Math.min(all.length, opts.max);
				for (let i = 0; i < count; i++) {
					try {
						const note = all[i] as {
							name: () => string;
							plaintext: () => string;
							id: () => string;
						};
						const name = note.name();
						let plain = "";
						try {
							plain = note.plaintext();
						} catch (_e) {
							plain = "";
						}
						const haystack = (
							(typeof name === "string" ? name : "") +
							"\n" +
							(typeof plain === "string" ? plain : "")
						).toLowerCase();
						if (haystack.indexOf(needleLc) !== -1) {
							out.push({ name: name || "Untitled Note", id: note.id() });
						}
					} catch (_e) {
						// Skip an individual unreadable note.
					}
				}
				return out;
			},
			{ search: needle, max: MAX_NOTES },
		)) as { name: string; id: string }[];

		return hits.map((h) => ({ name: h.name, id: h.id }));
	} catch (error) {
		rethrowIfPermissionDenied(error, NOTES_DENIED);
	}
}

// ── Read: list (heavy, full preview scan) ─────────────────────────────────────────────────────────

/**
 * Scan notes (a single folder when `folderName` is given, otherwise every folder) returning each
 * note's name, id, bounded plaintext preview and timestamps. This is the deliberately heavy "show me
 * everything" path, bounded by MAX_NOTES; for finding a note by title prefer `searchNotes`. Returns
 * `{ folderFound: false }` only when a named folder genuinely does not exist; a denial throws.
 */
async function scanNotes(
	folderName: string | undefined,
): Promise<{ folderFound: boolean; notes: Note[] }> {
	try {
		const raw = (await run(
			(opts: { folderName: string | null; max: number; maxLen: number }) => {
				const Notes = Application("Notes");

				let collection: { length: number; [k: number]: unknown };
				if (opts.folderName) {
					let folder: { notes: () => unknown[] } | null = null;
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
					collection = folder.notes() as unknown as {
						length: number;
						[k: number]: unknown;
					};
				} else {
					collection = Notes.notes() as unknown as {
						length: number;
						[k: number]: unknown;
					};
				}

				const out: {
					name: string;
					content: string;
					id: string | null;
					creationDate: number | null;
					modificationDate: number | null;
				}[] = [];
				const count = Math.min(collection.length, opts.max);
				for (let i = 0; i < count; i++) {
					try {
						const note = collection[i] as {
							name: () => string;
							plaintext: () => string;
							id: () => string;
							creationDate: () => Date | null;
							modificationDate: () => Date | null;
						};
						const rawName = note.name();
						let content = note.plaintext();
						content = typeof content === "string" ? content : "";
						if (content.length > opts.maxLen) {
							content = content.slice(0, opts.maxLen) + "…";
						}
						let id: string | null = null;
						try {
							id = note.id();
						} catch (_e) {
							// Leave id absent for this note.
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
							id,
							creationDate: created,
							modificationDate: modified,
						});
					} catch (_e) {
						// Skip an individual unreadable note; do not abort the whole scan.
					}
				}
				return { found: true, notes: out };
			},
			{ folderName: folderName ?? null, max: MAX_NOTES, maxLen: MAX_CONTENT_PREVIEW },
		)) as { found: boolean; notes: RawNote[] };

		return {
			folderFound: raw.found,
			notes: raw.notes.map((n) => ({
				name: n.name,
				content: n.content,
				id: n.id ?? undefined,
				creationDate: n.creationDate != null ? new Date(n.creationDate) : undefined,
				modificationDate:
					n.modificationDate != null ? new Date(n.modificationDate) : undefined,
			})),
		};
	} catch (error) {
		rethrowIfPermissionDenied(error, NOTES_DENIED);
	}
}

/**
 * List notes (optionally scoped to a folder), newest-modified first, with optional ISO date-range
 * filtering and a result cap. success:false (with message) only when a named folder does not exist.
 */
async function listNotes(opts: {
	folderName?: string;
	fromDate?: string;
	toDate?: string;
	limit?: number;
}): Promise<ListResult> {
	const { folderFound, notes } = await scanNotes(opts.folderName); // throws PermissionError on denial
	if (opts.folderName && !folderFound) {
		return { success: false, message: `Folder "${opts.folderName}" not found.` };
	}

	const from = opts.fromDate ? Date.parse(opts.fromDate) : NaN;
	const to = opts.toDate ? Date.parse(opts.toDate) : NaN;

	let result = notes;
	if (!Number.isNaN(from) || !Number.isNaN(to)) {
		result = result.filter((n) => {
			const t = n.modificationDate ? n.modificationDate.getTime() : null;
			if (t === null) return false;
			if (!Number.isNaN(from) && t < from) return false;
			if (!Number.isNaN(to) && t > to) return false;
			return true;
		});
	}

	result = [...result].sort((a, b) => {
		const ta = a.modificationDate ? a.modificationDate.getTime() : 0;
		const tb = b.modificationDate ? b.modificationDate.getTime() : 0;
		return tb - ta;
	});

	if (typeof opts.limit === "number" && opts.limit >= 0) {
		result = result.slice(0, opts.limit);
	}

	return { success: true, notes: result };
}

// ── Read: get one note's full content ─────────────────────────────────────────────────────────────

/**
 * The full content of a single note located by `noteId` (preferred, exact) or `title` (whose-contains,
 * preferring an exact title match). Returns name, plaintext, HTML body, id, containing folder and
 * timestamps. Reading a single located note (not a per-item scan) is cheap. Returns null when no note
 * matches; a permission denial throws.
 */
async function getNote(locate: {
	title?: string;
	noteId?: string;
}): Promise<Note | null> {
	if (!locate.noteId && !(locate.title && locate.title.trim())) return null;

	try {
		const raw = (await run(
			(opts: { title: string | null; noteId: string | null }) => {
				const Notes = Application("Notes");

				// Resolve the target note reference (id first, then title; exact title preferred).
				let note:
					| {
							name: () => string;
							plaintext: () => string;
							body: () => string;
							id: () => string;
							container: () => { name: () => string };
							creationDate: () => Date | null;
							modificationDate: () => Date | null;
					  }
					| null = null;
				if (opts.noteId) {
					try {
						const candidate = Notes.notes.byId(opts.noteId);
						candidate.name(); // throws if the id is invalid
						note = candidate;
					} catch (_e) {
						note = null;
					}
				}
				if (!note && opts.title) {
					let matches: { name: () => string }[] = [];
					try {
						matches = Notes.notes.whose({ name: { _contains: opts.title } })();
					} catch (_e) {
						matches = [];
					}
					for (let i = 0; i < matches.length; i++) {
						try {
							if (matches[i].name() === opts.title) {
								note = matches[i] as unknown as typeof note;
								break;
							}
						} catch (_e) {
							// Skip an unreadable match.
						}
					}
					if (!note && matches.length > 0) note = matches[0] as unknown as typeof note;
				}
				if (!note) {
					return {
						found: false,
						name: "",
						content: "",
						body: "",
						id: null,
						folderName: null,
						creationDate: null,
						modificationDate: null,
					};
				}

				let folderName: string | null = null;
				try {
					folderName = note.container().name();
				} catch (_e) {
					// Leave folder absent.
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
				const plain = note.plaintext();
				const html = note.body();
				let id: string | null = null;
				try {
					id = note.id();
				} catch (_e) {
					// Leave id absent.
				}
				return {
					found: true,
					name: note.name() || "Untitled Note",
					content: typeof plain === "string" ? plain : "",
					body: typeof html === "string" ? html : "",
					id,
					folderName,
					creationDate: created,
					modificationDate: modified,
				};
			},
			{ title: locate.title?.trim() ?? null, noteId: locate.noteId ?? null },
		)) as RawFullNote;

		if (!raw.found) return null;
		return {
			name: raw.name,
			content: raw.content,
			body: raw.body,
			id: raw.id ?? undefined,
			folderName: raw.folderName ?? undefined,
			creationDate: raw.creationDate != null ? new Date(raw.creationDate) : undefined,
			modificationDate:
				raw.modificationDate != null ? new Date(raw.modificationDate) : undefined,
		};
	} catch (error) {
		rethrowIfPermissionDenied(error, NOTES_DENIED);
	}
}

// ── Create ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Create a note. The body is supplied as Markdown (default), HTML, or plain text and converted to the
 * HTML Apple Notes stores; the `title` is prepended so Notes derives the note's title from it. If
 * `folderName` (default "Claude") does not exist it is created. Returns the values SET (never re-reads
 * the new note — a read-back would block for seconds); a permission denial throws PermissionError, a
 * genuine validation failure returns success:false.
 */
async function createNote(input: {
	title: string;
	body?: string;
	format?: NoteFormat;
	folderName?: string;
}): Promise<CreateNoteResult> {
	if (!input.title || input.title.trim() === "") {
		return { success: false, message: "Note title cannot be empty." };
	}

	const targetFolder =
		input.folderName && input.folderName.trim() !== ""
			? input.folderName.trim()
			: DEFAULT_FOLDER;
	const format: NoteFormat = input.format ?? "markdown";
	const bodyHtml = input.body ? bodyToHtml(input.body, format) : "";
	// Notes derives the note title from the first line of the body — make it a bold first line.
	const fullHtml = `<div><b>${escapeHtml(input.title)}</b></div>${bodyHtml}`;

	try {
		const result = (await run(
			(opts: { folderName: string; body: string }) => {
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

				return { folderName: opts.folderName, createdFolder };
			},
			{ folderName: targetFolder, body: fullHtml },
		)) as { folderName: string; createdFolder: boolean };

		return {
			success: true,
			note: { name: input.title, content: input.body ?? "", body: fullHtml },
			folderName: result.folderName,
			createdFolder: result.createdFolder,
		};
	} catch (error) {
		// A TCC denial is a real, actionable fault — surface it loudly, not as success:false.
		if (isPermissionDenial(error)) throw new PermissionError(NOTES_DENIED);
		return {
			success: false,
			message: `Failed to create note: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

// ── Update (replace body, or append to it) ─────────────────────────────────────────────────────────

/**
 * Update a note located by `noteId` (preferred) or `title`. `mode:"replace"` (default) sets the whole
 * body; `mode:"append"` reads the current HTML body ONCE and appends the new content. The body is
 * supplied as Markdown (default)/HTML/plain and converted to HTML. NOTE: Apple Notes derives a note's
 * title from the FIRST LINE of its body, so in `replace` mode the new body's first line becomes the
 * title — to keep the existing title, lead the new body with it (e.g. a `# Heading`). `append` keeps the
 * title because it preserves the original first line. The write (a single property set) is
 * authoritative — we never re-read the mutated note. Returns success:false when no note matches; a
 * permission denial throws PermissionError.
 */
async function updateNote(input: {
	title?: string;
	noteId?: string;
	body: string;
	format?: NoteFormat;
	mode?: "replace" | "append";
}): Promise<MutationResult> {
	if (!input.noteId && !(input.title && input.title.trim())) {
		return { success: false, message: "An id or title is required to locate the note." };
	}
	const format: NoteFormat = input.format ?? "markdown";
	const newHtml = bodyToHtml(input.body ?? "", format);
	const mode = input.mode ?? "replace";

	try {
		const result = (await run(
			(opts: {
				title: string | null;
				noteId: string | null;
				html: string;
				append: boolean;
			}) => {
				const Notes = Application("Notes");

				let note:
					| { name: () => string; id: () => string; body: { (): string; set?: unknown } }
					| null = null;
				if (opts.noteId) {
					try {
						const candidate = Notes.notes.byId(opts.noteId);
						candidate.name();
						note = candidate;
					} catch (_e) {
						note = null;
					}
				}
				if (!note && opts.title) {
					let matches: { name: () => string }[] = [];
					try {
						matches = Notes.notes.whose({ name: { _contains: opts.title } })();
					} catch (_e) {
						matches = [];
					}
					for (let i = 0; i < matches.length; i++) {
						try {
							if (matches[i].name() === opts.title) {
								note = matches[i] as unknown as typeof note;
								break;
							}
						} catch (_e) {
							// Skip an unreadable match.
						}
					}
					if (!note && matches.length > 0) note = matches[0] as unknown as typeof note;
				}
				if (!note) return { found: false, id: null as string | null, name: "" };

				// Identity is read BEFORE the write (cheap, single note) so the result can report it.
				let id: string | null = null;
				let name = "";
				try {
					id = note.id();
				} catch (_e) {
					// Leave id absent.
				}
				try {
					name = note.name();
				} catch (_e) {
					// Leave name absent.
				}

				const n = note as unknown as { body: string };
				if (opts.append) {
					// Append legitimately needs the current body once; this is a read BEFORE the write,
					// not a forbidden read-BACK of a just-mutated note.
					let existing = "";
					try {
						existing = (note as { body: () => string }).body();
					} catch (_e) {
						existing = "";
					}
					n.body = (typeof existing === "string" ? existing : "") + opts.html;
				} else {
					n.body = opts.html;
				}

				return { found: true, id, name };
			},
			{
				title: input.title?.trim() ?? null,
				noteId: input.noteId ?? null,
				html: newHtml,
				append: mode === "append",
			},
		)) as { found: boolean; id: string | null; name: string };

		if (!result.found) {
			return {
				success: false,
				message: input.noteId
					? `No note with id "${input.noteId}".`
					: `No note titled "${input.title}".`,
			};
		}
		return { success: true, id: result.id ?? undefined, name: result.name || undefined };
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(NOTES_DENIED);
		return {
			success: false,
			message: `Failed to update note: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

// ── Delete ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Delete a note located by `noteId` (preferred) or `title` (exact match preferred). The deleted note's
 * name is read BEFORE deletion for the result. Returns success:false when no note matches; a
 * permission denial throws PermissionError.
 */
async function deleteNote(locate: {
	title?: string;
	noteId?: string;
}): Promise<MutationResult> {
	if (!locate.noteId && !(locate.title && locate.title.trim())) {
		return { success: false, message: "An id or title is required to locate the note." };
	}

	try {
		const result = (await run(
			(opts: { title: string | null; noteId: string | null }) => {
				const Notes = Application("Notes");

				let note: { name: () => string; id: () => string } | null = null;
				if (opts.noteId) {
					try {
						const candidate = Notes.notes.byId(opts.noteId);
						candidate.name();
						note = candidate;
					} catch (_e) {
						note = null;
					}
				}
				if (!note && opts.title) {
					let matches: { name: () => string }[] = [];
					try {
						matches = Notes.notes.whose({ name: { _contains: opts.title } })();
					} catch (_e) {
						matches = [];
					}
					for (let i = 0; i < matches.length; i++) {
						try {
							if (matches[i].name() === opts.title) {
								note = matches[i] as unknown as typeof note;
								break;
							}
						} catch (_e) {
							// Skip an unreadable match.
						}
					}
					if (!note && matches.length > 0) note = matches[0] as unknown as typeof note;
				}
				if (!note) return { found: false, id: null as string | null, name: "" };

				let id: string | null = null;
				let name = "";
				try {
					id = note.id();
				} catch (_e) {
					// Leave id absent.
				}
				try {
					name = note.name();
				} catch (_e) {
					// Leave name absent.
				}
				Notes.delete(note);
				return { found: true, id, name };
			},
			{ title: locate.title?.trim() ?? null, noteId: locate.noteId ?? null },
		)) as { found: boolean; id: string | null; name: string };

		if (!result.found) {
			return {
				success: false,
				message: locate.noteId
					? `No note with id "${locate.noteId}".`
					: `No note titled "${locate.title}".`,
			};
		}
		return { success: true, id: result.id ?? undefined, name: result.name || undefined };
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(NOTES_DENIED);
		return {
			success: false,
			message: `Failed to delete note: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

// ── Folders ─────────────────────────────────────────────────────────────────────────────────────

/** Every folder with its (best-effort) note count. Empty array is a genuine empty result; denial throws. */
async function listFolders(): Promise<FolderInfo[]> {
	try {
		const folders = (await run(() => {
			const Notes = Application("Notes");
			const fs = Notes.folders();
			const out: { name: string; count: number | null }[] = [];
			for (let i = 0; i < fs.length; i++) {
				try {
					const name = fs[i].name();
					let count: number | null = null;
					try {
						count = fs[i].notes().length;
					} catch (_e) {
						// Leave count absent for this folder.
					}
					out.push({ name: typeof name === "string" ? name : "Untitled Folder", count });
				} catch (_e) {
					// Skip an unreadable folder.
				}
			}
			return out;
		})) as FolderInfo[];
		return folders;
	} catch (error) {
		rethrowIfPermissionDenied(error, NOTES_DENIED);
	}
}

/**
 * Create a folder (idempotent: if one with the same name already exists it is reported created:false,
 * not duplicated). Returns the name SET (never re-reads the new folder). A permission denial throws.
 */
async function createFolder(name: string): Promise<CreateFolderResult> {
	if (!name || name.trim() === "") {
		return { success: false, name: "", created: false, message: "Folder name cannot be empty." };
	}
	const folderName = name.trim();

	try {
		const result = (await run(
			(opts: { name: string }) => {
				const Notes = Application("Notes");
				const folders = Notes.folders();
				for (let i = 0; i < folders.length; i++) {
					try {
						if (folders[i].name() === opts.name) {
							return { created: false };
						}
					} catch (_e) {
						// Skip an unreadable folder.
					}
				}
				Notes.make({ new: "folder", withProperties: { name: opts.name } });
				return { created: true };
			},
			{ name: folderName },
		)) as { created: boolean };

		return { success: true, name: folderName, created: result.created };
	} catch (error) {
		if (isPermissionDenial(error)) throw new PermissionError(NOTES_DENIED);
		return {
			success: false,
			name: folderName,
			created: false,
			message: `Failed to create folder: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export default {
	requestNotesAccess,
	searchNotes,
	listNotes,
	getNote,
	createNote,
	updateNote,
	deleteNote,
	listFolders,
	createFolder,
};
