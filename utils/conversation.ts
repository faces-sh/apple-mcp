/**
 * A CONVERSATION is the unit, not a handle.
 *
 * Everything here used to key on `handle.id`, which is a phone number, and that is not what a person
 * means. Asked "what was the last message from John", the message does not say "hi, this is John"; it
 * says whatever John said, in a thread whose SENDER is John. And the thread may have three people in it.
 *
 * The failure that made this obvious, on a real Mac: a run was asked about a meeting being discussed
 * with Shivani and Hamilton. Searching bodies for "Shivani Hamilton" found nothing, because those words
 * appear in no message. Reading by name would have resolved one of them to a number and opened the 1:1
 * thread, which is not where the discussion is. The discussion is in chat 417, a GROUP with both of them
 * in it, and nothing in the toolbox could name it. `recent` could not show it either: it grouped by
 * `handle_id`, so a group of two came back as two separate people and the thread itself was invisible.
 *
 * So: chats, their participants, and the ability to find one by WHO IS IN IT.
 *
 * ALL OF THE PEOPLE, ANY OF THEIR HANDLES. Someone may be reachable at a phone and an email, and the
 * chat holds only one of them, so a person matches if ANY of their handles is in the chat; the chat
 * matches if EVERY person asked for is in it. That is "the thread with Shivani and Hamilton" as anybody
 * would read it, and it is the same `&&` the query rule uses for words.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeAttributedBody } from "./message";
import { handleCandidates } from "./phone";

const execFileAsync = promisify(execFile);
const CHAT_DB = `${process.env.HOME}/Library/Messages/chat.db`;

export interface Conversation {
	/** chat.ROWID: stable on this Mac, and what `read` takes to open the thread again. */
	chatId: number;
	/** chat.guid, which is what AppleScript addresses. A GROUP has no handle to send to, so this is
	 *  the only way to reply into one. */
	guid: string;
	isGroup: boolean;
	/** Every handle in the thread, excluding the user themselves (chat.db does not list them). */
	participants: string[];
	/** The name Messages shows for a named group, when there is one. */
	title?: string;
	lastMessage?: string;
	lastDate?: string;
	lastFromMe?: boolean;
}

const LATEST_PER_CHAT = `
	JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
	JOIN message m ON m.ROWID = cmj.message_id
	JOIN (
		SELECT cmj2.chat_id AS cid, MAX(m2.date) AS latest
		FROM chat_message_join cmj2 JOIN message m2 ON m2.ROWID = cmj2.message_id
		WHERE m2.item_type = 0
		GROUP BY cmj2.chat_id
	) last ON last.cid = c.ROWID AND last.latest = m.date`;

const CHAT_COLUMNS = `
	c.ROWID AS chat_id,
	c.guid AS guid,
	c.style AS style,
	c.display_name AS title,
	(SELECT GROUP_CONCAT(h.id, '|') FROM chat_handle_join chj
	 JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = c.ROWID) AS participants,
	m.is_from_me AS from_me,
	CASE
		WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
		WHEN m.attributedBody IS NOT NULL THEN hex(m.attributedBody)
		ELSE ''
	END AS body,
	CASE WHEN m.text IS NOT NULL AND m.text != '' THEN 0 ELSE 1 END AS is_hex,
	datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS date`;

export interface ChatRow {
	chat_id: number; guid: string; style: number; title: string | null; participants: string | null;
	from_me: number; body: string; is_hex: number; date: string;
}

function toConversation(r: ChatRow): Conversation {
	const body = r.is_hex ? (decodeAttributedBody(r.body).text ?? "") : (r.body ?? "");
	return {
		chatId: r.chat_id,
		guid: r.guid,
		// 43 is a group thread, 45 is one-to-one. Participant COUNT is not the test: a group can lose
		// members down to one and is still a group.
		isGroup: r.style === 43,
		participants: (r.participants ?? "").split("|").map((h) => h.trim()).filter(Boolean),
		title: (r.title ?? "").trim() || undefined,
		lastMessage: body || undefined,
		lastDate: r.date,
		lastFromMe: r.from_me === 1,
	};
}

/**
 * Run one chat query.
 *
 * HANDED IN, so a test can supply rows without replacing `node:child_process` for the whole run. That
 * shortcut has already cost this suite once: a `mock.module` on the contacts module reddened five
 * unrelated tests, and here it does not even work, because the binding is taken before the mock lands.
 */
export type ChatRows = (sql: string) => Promise<ChatRow[]>;

const sqlite: ChatRows = async (sql) => {
	const { stdout } = await execFileAsync("sqlite3", ["-json", CHAT_DB, sql],
		{ maxBuffer: 64 * 1024 * 1024 });
	return JSON.parse(stdout || "[]") as ChatRow[];
};

/** The thread list: every conversation, most recently active first, groups included. */
export async function listConversations(limit = 10, rows: ChatRows = sqlite): Promise<Conversation[]> {
	const capped = Math.max(1, Math.min(Math.floor(limit) || 10, 100));
	return (await rows(`
		SELECT ${CHAT_COLUMNS}
		FROM chat c ${LATEST_PER_CHAT}
		WHERE m.item_type = 0
		ORDER BY m.date DESC
		LIMIT ${capped}`)).map(toConversation);
}

/**
 * Every conversation that holds ALL of these people, each of whom may answer to several handles.
 *
 * Filtered in code rather than in SQL because "all of the people, any of their handles" is a set
 * question and this is a few hundred rows: the alternative is generated SQL nobody can read, for a
 * table that fits in memory twice over.
 */
export async function conversationsWith(
	handleSets: string[][],
	rows: ChatRows = sqlite,
): Promise<Conversation[]> {
	const wanted = handleSets
		.map((set) => new Set(set.map((h) => h.trim().toLowerCase()).filter(Boolean)))
		.filter((set) => set.size > 0);
	if (!wanted.length) return [];
	const all = (await rows(`
		SELECT ${CHAT_COLUMNS}
		FROM chat c ${LATEST_PER_CHAT}
		WHERE m.item_type = 0
		ORDER BY m.date DESC`)).map(toConversation);
	return all.filter((conv) => {
		const here = new Set(conv.participants.map((h) => h.toLowerCase()));
		return wanted.every((person) => [...person].some((h) => here.has(h)));
	});
}

/** Every message in one conversation, most recent first, with who said each one. */
export async function readConversation(
	chatId: number,
	limit = 10,
): Promise<{ sender: string; fromMe: boolean; text: string; date: string }[]> {
	const capped = Math.max(1, Math.min(Math.floor(limit) || 10, 100));
	const { stdout } = await execFileAsync("sqlite3", ["-json", CHAT_DB, `
		SELECT
			COALESCE(h.id, '') AS sender,
			m.is_from_me AS from_me,
			CASE
				WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
				WHEN m.attributedBody IS NOT NULL THEN hex(m.attributedBody)
				ELSE ''
			END AS body,
			CASE WHEN m.text IS NOT NULL AND m.text != '' THEN 0 ELSE 1 END AS is_hex,
			datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS date
		FROM message m
		JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
		LEFT JOIN handle h ON h.ROWID = m.handle_id
		WHERE cmj.chat_id = ${Math.floor(chatId)} AND m.item_type = 0
		ORDER BY m.date DESC
		LIMIT ${capped}`], { maxBuffer: 64 * 1024 * 1024 });
	const raw = JSON.parse(stdout || "[]") as
		{ sender: string; from_me: number; body: string; is_hex: number; date: string }[];
	return raw.map((r) => ({
		sender: r.sender,
		fromMe: r.from_me === 1,
		text: (r.is_hex ? decodeAttributedBody(r.body).text : r.body) ?? "",
		date: r.date,
	}));
}

/**
 * The names in "Shivani and Hamilton", or "shivani, hamilton", or just "John".
 *
 * Pure. Splits on the words and punctuation people join names with, and NOTHING ELSE: a two-word name
 * stays one name, because "Mary Jane" is a person far more often than it is two.
 */
export function namesAsked(raw: string): string[] {
	return raw
		.split(/\s*(?:,|&|\+|\band\b|\bet\b)\s*/i)
		.map((n) => n.trim())
		.filter(Boolean);
}

/**
 * The threads one handle appears in, most recently active first.
 *
 * A HANDLE IS NOT A THREAD EITHER, which is the same mistake one level down. Reading by number pulled
 * every message that person had ever sent out of every thread at once and called it "your conversation
 * with +1408...": their side only, no replies, three group chats interleaved. Somebody reading it would
 * have thought that was the conversation.
 */
export async function conversationsForHandle(
	handle: string,
	rows: ChatRows = sqlite,
): Promise<Conversation[]> {
	const forms = handleCandidates(handle);
	return forms.length ? conversationsWith([forms], rows) : [];
}

/** What a name, or several names, turned out to mean. */
export type ConversationSearch =
	/**
	 * The thread to read, plus any others they are also in.
	 *
	 * THE MOST RECENTLY ACTIVE ONE IS A DEFAULT, NOT A GUESS, and this is the one place the rule differs
	 * from picking a PERSON. Choosing the wrong Caroline sends a message to the wrong human and cannot be
	 * taken back, so that stays a question. Choosing between threads that all contain the people asked
	 * for is reversible: it is a read, the answer names which thread it opened, and the others are listed
	 * underneath. Asking instead would cost a round trip to tell somebody that "the last message from
	 * John" means John's most recent thread, which they already knew.
	 */
	| { kind: "one"; conversation: Conversation; others: Conversation[] }
	/** Contacts knows them, but no thread holds all of them together. */
	| { kind: "no-thread"; who: string[] }
	/** Contacts was read and has nobody by these names. NOT "they never wrote to you". */
	| { kind: "unknown"; missing: string[] }
	/**
	 * One of the names fits more than one PERSON, so nothing is opened until somebody picks.
	 *
	 * This is not the same as several conversations, which is a default. Several PEOPLE is a question,
	 * because the branches lead to different humans.
	 */
	| { kind: "several-people"; name: string; candidates: { name: string; handles: string[]; lastSeen?: string }[] }
	/** Contacts could not be read at all, so nothing is known either way. */
	| { kind: "cannot-ask" };

/**
 * The conversation somebody means when they name the people in it.
 *
 * "the thread with Shivani and Hamilton" and "the last message from John" are the same question with a
 * different number of names, which is why there is no separate verb for groups. Every name must be in
 * the thread; each name may be any of that person's handles.
 *
 * THE FOUR OUTCOMES ARE KEPT APART because their sentences differ and only some are actionable, the
 * same rule `resolveRecipient` follows one level down: a thread that does not exist, a person Contacts
 * has never heard of, and a Contacts it could not open are three different facts, and collapsing them
 * produces the lie that costs the most here ("you have no messages from her").
 */
export async function conversationsNamed(
	raw: string,
	/**
	 * Which ONE person a name means. `whoIsMeant`, which ranks by who has been in touch and returns
	 * `several` rather than choosing between two humans.
	 *
	 * THIS USED TO UNION THE HANDLES OF EVERY MATCHING CARD, and that was a real leak, found by driving
	 * the app: Contacts matches loosely, so looking up "Troy Conrad Therrien" also returned the card for
	 * "Linda Therrien", both people's numbers were poured into one set, and reading the owner's own
	 * conversation opened his mother's. On a send it would have delivered to her. Resolving a name to a
	 * PERSON is solved next door and asks when it cannot tell; there was never a reason for a second,
	 * worse copy of it here.
	 */
	resolveOne: (name: string) => Promise<
		| { kind: "one"; name: string; handles: string[] }
		| { kind: "several"; candidates: { name: string; handles: string[]; lastSeen?: string }[] }
		| { kind: "unknown" }
		| { kind: "cannot-ask" }>,
	rows: ChatRows = sqlite,
): Promise<ConversationSearch> {
	const names = namesAsked(raw);
	if (!names.length) return { kind: "unknown", missing: [] };
	const handleSets: string[][] = [];
	const missing: string[] = [];
	for (const name of names) {
		const who = await resolveOne(name);
		if (who.kind === "cannot-ask") return { kind: "cannot-ask" };
		if (who.kind === "several") return { kind: "several-people", name, candidates: who.candidates };
		if (who.kind === "unknown") { missing.push(name); continue; }
		const handles = who.handles.map((h) => h.trim()).filter(Boolean);
		if (!handles.length) missing.push(name);
		else handleSets.push(handles);
	}
	if (missing.length) return { kind: "unknown", missing };
	const found = await conversationsWith(handleSets, rows);
	if (!found.length) return { kind: "no-thread", who: names };
	// `conversationsWith` returns most recently active first, so the head is the default.
	return { kind: "one", conversation: found[0]!, others: found.slice(1) };
}
