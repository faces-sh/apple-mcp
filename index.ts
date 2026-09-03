#!/usr/bin/env node
import {
	remindersDetail,
	remindersIndex,
} from "./utils/reminders-render";
import { contactsIndex } from "./utils/contacts-render";
import { looksLikeHandle } from "./utils/recipient";
import { namesAsked } from "./utils/conversation";
import { showing } from "./utils/showing";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

/// How much of each note a LIST shows. A list is an index, not the content: returning every body in
/// full was 2.3MB of text into one turn. Search returns whole bodies, which is what it is for.
const NOTE_PREVIEW_CHARS = 200;


import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import tools from "./tools";
import { failureResult, failureResultFrom } from "./utils/failure";

// Per-app filtering. Faced bundles this server and exposes only the Apple apps the user has toggled
// on by passing APPLE_MCP_ENABLED_APPS as a comma-separated list of tool names. Tool names map 1:1
// to apps (contacts, notes, messages, reminders, calendar). Unset => every tool is exposed; an empty
// value => nothing is exposed. This gates BOTH the advertised tool list and the dispatch switch, so
// a disabled app is invisible and uncallable rather than merely hidden.
const ENABLED_APPS: ReadonlySet<string> | null = (() => {
	const raw = process.env.APPLE_MCP_ENABLED_APPS;
	if (raw === undefined) return null; // no filtering
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
})();

function isAppEnabled(toolName: string): boolean {
	return ENABLED_APPS === null || ENABLED_APPS.has(toolName.toLowerCase());
}

// A SHORT ANSWER MUST NEVER BE MISTAKEN FOR THE WHOLE ANSWER. Both of these caps used to bite in
// silence, which made "not found" and "not looked at" the same sentence. Null means the cap did not
// bite and nothing is added.
/** A limit that shortened the answer is SAID, never implied: "10 of 34" and "10" are different facts,
 *  and the second invites a reader to conclude there were ten. */
function calendarTruncationNote(cut: { shown: number; total: number } | null): string {
	return cut
		? `\n\n(Showing ${cut.shown} of ${cut.total} in that window. Ask for a bigger limit or a narrower window.)`
		: "";
}
/** Same job as `calendarTruncationNote` and as `showing`, in a third place, which is worth saying out
 *  loud: these three are one idea written three times, and they had already drifted. This one told the
 *  caller it had been cut and gave NO way out, so a reader who learned the answer was partial had nowhere
 *  to go with that. They are not merged here only because `showing` is a HEADER and these two are
 *  suffixes, so unifying them changes what notes and calendar output look like, which is a bigger change
 *  than a bug fix and belongs on its own. */
/**
 * Render ONE conversation, whoever asked for it and however they named it.
 *
 * SHARED BY BOTH READ PATHS ON PURPOSE. A name and a handle are two ways of naming the same thing, so
 * they must produce the same answer; a second renderer beside this one is how they drift, and how the
 * handle path came to print a one-sided stream while the name path printed a thread.
 */
async function readThread(
	conv: { chatId: number; isGroup: boolean; participants: string[]; title?: string },
	others: unknown[],
	limit: number | undefined,
): Promise<{ content: { type: "text"; text: string }[]; isError: boolean }> {
	const messageModule = await loadModule("message");
	const contactsForNames = await loadModule("contacts");
	const { messages, total } = await messageModule.readConversation(conv.chatId, limit);
	let names = new Map<string, string>();
	try {
		// A name is a nicety; the messages are the answer. Kept OUTSIDE the read so a Contacts denial
		// cannot turn a conversation into a contacts-flavoured error.
		names = await contactsForNames.namesForHandles(conv.participants);
	} catch (nameError) {
		console.error("read: could not name the participants:", nameError);
	}
	const who = (h: string) => names.get(h.trim()) || h;
	const heading = conv.title || conv.participants.map(who).join(", ") || "this conversation";
	const alsoIn = others.length
		? `\n\n(They are also in ${others.length} other conversation${others.length === 1 ? "" : "s"};`
			+ " this is the most recent. Ask for another by naming the people in it.)"
		: "";
	return {
		content: [{
			type: "text",
			text: messages.length
				? `Showing ${messages.length} of ${total} message(s) in your `
					+ `${conv.isGroup ? "group " : ""}conversation with ${heading}`
					+ (total > messages.length ? ", most recent first. Ask for more with limit:\n" : ", most recent first:\n")
					+ messages.map((msg: { date: string; fromMe: boolean; sender: string; text: string }) =>
						`[${new Date(msg.date).toLocaleString()}] `
						+ `${msg.fromMe ? "Me" : who(msg.sender)}: ${msg.text}`,
					).join("\n")
					+ alsoIn
				: `Your conversation with ${heading} has no messages in it.`,
		}],
		isError: false,
	};
}

function notesTruncationNote(
	cut: { shown: number; total: number } | null,
	what: string,
): string {
	return cut
		? `\n\n(Showing ${cut.shown} of ${cut.total} ${what}. Ask for a bigger limit, or search to narrow it.)`
		: "";
}

// Safe mode implementation - lazy loading of modules
let useEagerLoading = true;
let loadingTimeout: ReturnType<typeof setTimeout> | null = null;
let safeModeFallback = false;

console.error("Starting apple-mcp server...");

// Placeholders for modules - will either be loaded eagerly or lazily
let contacts: typeof import("./utils/contacts").default | null = null;
let notes: typeof import("./utils/notes").default | null = null;
let message: typeof import("./utils/message").default | null = null;
let reminders: typeof import("./utils/reminders").default | null = null;

let calendar: typeof import("./utils/calendar").default | null = null;

// Type map for module names to their types
type ModuleMap = {
	contacts: typeof import("./utils/contacts").default;
	notes: typeof import("./utils/notes").default;
	message: typeof import("./utils/message").default;
	reminders: typeof import("./utils/reminders").default;
	calendar: typeof import("./utils/calendar").default;
};

// Helper function for lazy module loading
async function loadModule<
	T extends
		| "contacts"
		| "notes"
		| "message"
		| "reminders"
		| "calendar"
>(moduleName: T): Promise<ModuleMap[T]> {
	if (safeModeFallback) {
		console.error(`Loading ${moduleName} module on demand (safe mode)...`);
	}

	try {
		switch (moduleName) {
			case "contacts":
				if (!contacts) contacts = (await import("./utils/contacts")).default;
				return contacts as ModuleMap[T];
			case "notes":
				if (!notes) notes = (await import("./utils/notes")).default;
				return notes as ModuleMap[T];
			case "message":
				if (!message) message = (await import("./utils/message")).default;
				return message as ModuleMap[T];
			case "reminders":
				if (!reminders) reminders = (await import("./utils/reminders")).default;
				return reminders as ModuleMap[T];
			case "calendar":
				if (!calendar) calendar = (await import("./utils/calendar")).default;
				return calendar as ModuleMap[T];
			default:
				throw new Error(`Unknown module: ${moduleName}`);
		}
	} catch (e) {
		console.error(`Error loading module ${moduleName}:`, e);
		throw e;
	}
}

// Set a timeout to switch to safe mode if initialization takes too long
loadingTimeout = setTimeout(() => {
	console.error(
		"Loading timeout reached. Switching to safe mode (lazy loading...)",
	);
	useEagerLoading = false;
	safeModeFallback = true;

	// Clear the references to any modules that might be in a bad state
	contacts = null;
	notes = null;
	message = null;
	reminders = null;
	calendar = null;

	// Proceed with server setup
	initServer();
}, 5000); // 5 second timeout

// Eager loading attempt
async function attemptEagerLoading() {
	try {
		console.error("Attempting to eagerly load modules...");

		// Try to import all modules
		contacts = (await import("./utils/contacts")).default;
		console.error("- Contacts module loaded successfully");

		notes = (await import("./utils/notes")).default;
		console.error("- Notes module loaded successfully");

		message = (await import("./utils/message")).default;
		console.error("- Message module loaded successfully");


		reminders = (await import("./utils/reminders")).default;
		console.error("- Reminders module loaded successfully");


		calendar = (await import("./utils/calendar")).default;
		console.error("- Calendar module loaded successfully");


		// If we get here, clear the timeout and proceed with eager loading
		if (loadingTimeout) {
			clearTimeout(loadingTimeout);
			loadingTimeout = null;
		}

		console.error("All modules loaded successfully, using eager loading mode");
		initServer();
	} catch (error) {
		console.error("Error during eager loading:", error);
		console.error("Switching to safe mode (lazy loading)...");

		// Clear any timeout if it exists
		if (loadingTimeout) {
			clearTimeout(loadingTimeout);
			loadingTimeout = null;
		}

		// Switch to safe mode
		useEagerLoading = false;
		safeModeFallback = true;

		// Clear the references to any modules that might be in a bad state
		contacts = null;
		notes = null;
		message = null;
		reminders = null;
			calendar = null;

		// Initialize the server in safe mode
		initServer();
	}
}

// Attempt eager loading first
attemptEagerLoading();

// Main server object
let server: Server;

// Initialize the server and set up handlers
function initServer() {
	console.error(
		`Initializing server in ${safeModeFallback ? "safe" : "standard"} mode...`,
	);

	server = new Server(
		{
			name: "Apple MCP tools",
			version: "1.0.0",
		},
		{
			capabilities: {
				tools: {},
			},
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.filter((tool) => isAppEnabled(tool.name)),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		try {
			const { name, arguments: args } = request.params;

			if (!args) {
				return failureResult(
					"bad_request",
					`Could not run the "${name}" tool: no arguments were given.`,
				);
			}

			// Does this tool EXIST, before asking whether it is switched on. The other order reported
			// every unknown name as "app_disabled" whenever APPLE_MCP_ENABLED_APPS was set, which told
			// a caller to go turn on a tool this server has never had.
			if (!tools.some((tool) => tool.name === name)) {
				return failureResult(
					"unknown_tool",
					`There is no tool called "${name}" on this server.`,
				);
			}

			if (!isAppEnabled(name)) {
				return failureResult(
					"app_disabled",
					`The "${name}" app is not enabled on this server.`,
				);
			}

			switch (name) {
				case "contacts": {
					if (!isContactsArgs(args)) {
						return failureResult(
							"bad_request",
							"Could not look up contacts: `name` must be a string when given.",
						);
					}

					try {
						const contactsModule = await loadModule("contacts");

						if (args.name) {
							// WHOLE CONTACTS, emails included, and the card's stable id with them.
							//
							// This used to call `findNumber`, which goes through `getAllNumbers` and so
							// skips every contact with no phone number and returns only the phones. A
							// caller asking Contacts for somebody's EMAIL therefore got nothing back: not
							// a wrong address, no address, from the one source that reliably has it.
							//
							// The id is `CNContact.identifier` (JXA's `person.id()` returns the same
							// "UUID:ABPerson" string), so a caller can act on the card afterwards: it is
							// what lets Maestro remember which address somebody chose, keyed on something
							// a rename cannot break and two people of the same name cannot collide on.
							const found = await contactsModule.findContacts(args.name);
							// A "not found" must never be silently a "not looked at": if the scan hit its
							// cap, say so, because the person searched for may be one of the ones it did
							// not reach. This was invisible for 647 of 1,647 cards on a real Mac.
							const lines = found.map((c) => {
								const parts = [];
								if (c.emails.length > 0) parts.push(c.emails.join(", "));
								if (c.phones.length > 0) parts.push(c.phones.join(", "));
								return `${c.name} [${c.id}]: ${parts.join(" | ")}`;
							});
							return {
								content: [
									{
										type: "text",
										text: lines.length
											? lines.join("\n")
											: `No contact found for "${args.name}". Try a different name or use no name parameter to list all contacts.`,
									},
								],
								isError: false,
							};
						} else {
							// EVERY CARD, with the emails as well as the phones. See utils/contacts-render.ts
							// for what this used to do and why it was wrong.
							const all = await contactsModule.getAllContacts();
							return {
								content: [{ type: "text", text: contactsIndex(all) }],
								isError: false,
							};
						}
					} catch (error) {
						return failureResultFrom(
							error,
							"internal_error",
							"Could not look up contacts.",
						);
					}
				}

				case "notes": {
					if (!isNotesArgs(args)) {
						return failureResult(
							"bad_request",
							"Could not run the notes tool: `operation` must be search, list or create, " +
								"with `searchText` for a search and `title` plus `body` for a create.",
						);
					}

					try {
						const notesModule = await loadModule("notes");
						const { operation } = args;

						switch (operation) {
							case "search": {
								if (!args.searchText) {
									return failureResult(
										"bad_request",
										"Could not search your notes: no search text was given.",
									);
								}

								const foundNotes = await notesModule.findNote(args.searchText);
								// A search now reads the WHOLE store, so a short answer is a short answer
								// and not the first thousand notes. When the RESULT is trimmed, say so.
								const trimmed = notesTruncationNote(notesModule.truncation(), "matching notes");
								return {
									content: [
										{
											type: "text",
											text: foundNotes.length
												? foundNotes
														.map((note) => `${note.name}:\n${note.content}`)
														.join("\n\n") + trimmed
												: `No notes found for "${args.searchText}"`,
										},
									],
									isError: false,
								};
							}

							case "list": {
								const allNotes = await notesModule.getAllNotes();
								const trimmed = notesTruncationNote(notesModule.truncation(), "notes");
								// A LIST IS AN INDEX, NOT THE CONTENT. Returning every note in full was
								// 2.3MB of text into one turn, which is not a thing a small model can be
								// asked to read: the charter's rule is that context is rationed, not
								// accumulated. It only got that big because the list stopped truncating
								// silently (it used to show 1,000 of 3,152), and the fix for hiding things
								// cannot be to hide them again, so it shows all of them BRIEFLY.
								//
								// Search still returns whole bodies, which is what it is for, and the line
								// below says so: without a route from "I can see it in the list" to "I
								// have it", a preview would just be a dead end.
								const preview = (body: string) => {
									const flat = (body ?? "").replace(/\s+/g, " ").trim();
									return flat.length > NOTE_PREVIEW_CHARS
										? flat.slice(0, NOTE_PREVIEW_CHARS) + "..."
										: flat;
								};
								return {
									content: [
										{
											type: "text",
											text: allNotes.length
												? `${allNotes.length} notes, first ${NOTE_PREVIEW_CHARS} characters of each. `
														+ `To read one in full, search for its name.\n\n`
														+ allNotes
																.map((note) => `${note.name}: ${preview(note.content)}`)
																.join("\n") + trimmed
												: "No notes exist.",
										},
									],
									isError: false,
								};
							}

							case "create": {
								if (!args.title || !args.body) {
									return failureResult(
										"bad_request",
										"Could not create the note: a title and a body are both required.",
									);
								}

								// createNote THROWS on every failure now, so reaching this line means the
								// note exists. It used to return a result object whose `success: false`
								// carried the reason as prose, which is how "Failed to create note: ..."
								// travelled to callers as ordinary text.
								const result = await notesModule.createNote(
									args.title,
									args.body,
									args.folderName,
								);

								return {
									content: [
										{
											type: "text",
											text: `Created note "${args.title}" in folder "${result.folderName}"${result.usedDefaultFolder ? " (created new folder)" : ""}.`,
										},
									],
									isError: false,
								};
							}

							default:
								return failureResult(
									"bad_request",
									`Could not run the notes tool: "${operation}" is not one of search, list or create.`,
								);
						}
					} catch (error) {
						return failureResultFrom(
							error,
							"internal_error",
							"Could not run the notes tool.",
						);
					}
				}

				case "messages": {
					if (!isMessagesArgs(args)) {
						return failureResult(
							"bad_request",
							// SAYS WHAT IT ACCEPTS, and stays true when a verb is added: this sentence
							// still described four operations after two more existed, which is the same
							// class of stale help that sent a caller round in circles.
							"Could not run the messages tool: `operation` must be send, read, search, " +
								"recent, schedule or unread. `phoneNumber` is needed for send, read and " +
								"schedule; `message` for a send or a schedule; `scheduledTime` for a " +
								"schedule; and `query` for a search. `recent` and `unread` need nothing.",
						);
					}

					try {
						const messageModule = await loadModule("message");

						switch (args.operation) {
							case "send": {
								if (!args.phoneNumber || !args.message) {
									return failureResult(
										"bad_request",
										"Could not send the message: a phone number and a message are both required.",
									);
								}
								// A NAME IS ACCEPTED HERE TOO, or the toolbox is a trap: every other verb
								// answers in names ("Linda Therrien"), and this was the only one that
								// demanded a number, while nothing on offer returned one. Watched live: the
								// agent read the thread, was shown the name, tried contacts, tried the
								// thread list, and gave up with "I haven't sent your note to Linda."
								//
								// SENDING ASKS WHERE READING DEFAULTS, which is the one asymmetry worth
								// keeping. Opening the wrong thread is a read and costs nothing; posting
								// into the wrong one puts a private note in front of four people. So a
								// single name resolves to the PERSON (never to a group they happen to be
								// in), and several names must land on exactly one shared thread or this
								// comes back with the choice.
								let target = args.phoneNumber;
								let intoChat: string | undefined;
								if (!looksLikeHandle(target)) {
									const names = namesAsked(target);
									if (names.length === 1) {
										const who = await messageModule.whoIsMeant(target);
										if (who.kind === "cannot-ask") {
											return failureResult(
												"permission_denied",
												`Nothing was sent: "${target}" could not be looked up because `
												+ "your contacts could not be read. Enable Maestro under System "
												+ "Settings > Privacy & Security > Contacts, or send to their "
												+ "number.",
											);
										}
										if (who.kind === "unknown") {
											return failureResult(
												"not_found",
												`Nothing was sent: your contacts have nobody called "${target}". `
												+ "Send to their number, or list recent conversations to find them.",
											);
										}
										if (who.kind === "several") {
											return {
												content: [{
													type: "text",
													text: `Nothing was sent yet: more than one person is called `
														+ `"${target}":\n`
														+ who.candidates.map((c) =>
															`  ${c.name}: ${c.handles[0]}`
															+ (c.lastSeen ? `, last in touch ${c.lastSeen}` : ", never in touch"),
														).join("\n")
														+ "\nSend again with the number of the one you mean.",
												}],
												isError: false,
											};
										}
										target = who.handles[0]!;
									} else {
										const found = await messageModule.conversationsNamed(
											target, messageModule.whoIsMeant);
										if (found.kind === "cannot-ask" || found.kind === "unknown"
											|| found.kind === "no-thread" || found.kind === "several-people") {
											return failureResult(
												"not_found",
												`Nothing was sent: no single conversation with ${names.join(" and ")} `
												+ "could be identified. Send to one person's number instead.",
											);
										}
										if (found.others.length) {
											return {
												content: [{
													type: "text",
													text: "Nothing was sent yet: "
														+ `${names.join(" and ")} share ${found.others.length + 1} `
														+ "conversations, and a message must not go to the wrong one. "
														+ "Send to one person's number instead.",
												}],
												isError: false,
											};
										}
										// AND WHO ELSE IS IN IT. Matching is "every person named is here",
										// never "and nobody else", so the only thread two people share can
										// hold three more. On a real Mac that is true of 33 pairs. Sending
										// silently is exactly the thing this branch says it exists to
										// prevent: a private note in front of four people.
										if (found.conversation.participants.length > names.length) {
											let others = found.conversation.participants;
											try {
												const named = await (await loadModule("contacts"))
													.namesForHandles(found.conversation.participants);
												others = found.conversation.participants
													.map((h) => named.get(h.trim()) || h);
											} catch { /* handles will do */ }
											return {
												content: [{
													type: "text",
													text: "Nothing was sent yet: the only conversation with "
														+ `${names.join(" and ")} also has other people in it `
														+ `(${others.join(", ")}). Send to one person's number `
														+ "if this was meant to be private, or say to go ahead "
														+ "in that group.",
												}],
												isError: false,
											};
										}
										intoChat = found.conversation.guid;
									}
								}
								// SAY WHAT WAS ADDRESSED, not what was typed.
								//
								// This printed `args.phoneNumber` back, the raw input, after `target` had
								// been reassigned by the name lookup or replaced by a conversation guid. So
								// "Message sent to Linda" appeared whether it went to her mobile, her
								// landline, a namesake, or a group with three other people in it. The one
								// fact that would catch a wrong recipient by eye was the one fact withheld.
								let addressed = target;
								if (intoChat) {
									await messageModule.sendToConversation(intoChat, args.message);
									const conv = (await messageModule.listConversations(100))
										.find((c: { guid: string }) => c.guid === intoChat);
									if (conv) {
										let named = new Map<string, string>();
										try {
											named = await (await loadModule("contacts"))
												.namesForHandles(conv.participants);
										} catch { /* handles will do */ }
										addressed = conv.participants
											.map((h: string) => named.get(h.trim()) || h).join(", ")
											+ (conv.isGroup ? " (group)" : "");
									}
								} else {
									await messageModule.sendMessage(target, args.message);
								}
								return {
									content: [
										{
											type: "text",
											text: `Message sent to ${addressed}`
												+ (addressed !== args.phoneNumber ? ` (asked for "${args.phoneNumber}")` : ""),
										},
									],
									isError: false,
								};
							}

							case "read": {
								if (!args.phoneNumber) {
									return failureResult(
										"bad_request",
										"Could not read your messages: no phone number, address or name was given.",
									);
								}
								// A NAME IS AN ANSWER TOO. Asked for "the last message from Caroline" this
								// used to refuse outright ("Caroline is not a usable phone number or email
								// address"), so the caller went to Contacts, matched a DIFFERENT Caroline by
								// name, and read an address with no messages on it. Nobody knows the number
								// of the person they are talking about; that is what a name is for.
								let handle = args.phoneNumber;
								if (!looksLikeHandle(handle)) {
									// A NAME MEANS A CONVERSATION, NOT A NUMBER. Resolving to one handle and
									// opening the 1:1 thread was wrong twice over: it missed the GROUP the
									// people are actually talking in, and "the last message from John" is a
									// question about a thread whose sender is John, not about a message
									// that mentions him. Several names are the same question with more of
									// them: "the thread with Shivani and Hamilton" is every name present.
									const contactsForNames = await loadModule("contacts");
									const found = await messageModule.conversationsNamed(
										handle, messageModule.whoIsMeant);
									if (found.kind === "cannot-ask") {
										// NOT "nobody is called that": the book was never opened. The
										// person can act on this one, which is the whole difference.
										//
										// NAMES THE ACT, NOT THE VERB, here and below. This server runs
										// behind Maestro's `messaging` proxy, where the same thing is
										// called `recent_conversations`, so "use the recent operation"
										// sends the caller after a name it cannot call. "List recent
										// conversations" is true at both levels.
										return failureResult(
											"permission_denied",
											`Could not look up "${handle}": your contacts could not be read, `
											+ "so a name cannot be turned into a conversation. Enable Maestro "
											+ "under System Settings > Privacy & Security > Contacts, or list "
											+ "recent conversations to see who has been in touch and read "
											+ "that number directly.",
										);
									}
									if (found.kind === "unknown") {
										// NEVER "THERE ARE NO MESSAGES FROM THEM". Most handles have no card
										// at all, so the person asked about may be sitting in the thread list
										// as a bare number: saying they have not written is a false negative
										// dressed as an answer.
										return failureResult(
											"not_found",
											`Your contacts have nobody called "${found.missing.join('", "')}", `
											+ "so no conversation could be looked up. This does NOT mean they "
											+ "have not written: a number with no contact card still shows up "
											+ "in your conversations. List recent conversations to see who has "
											+ "been in touch, or search for a word from the message.",
										);
									}
									if (found.kind === "several-people") {
										// TWO PEOPLE, NOT TWO THREADS. Choosing between threads is a
										// default; choosing between humans is a question, and answering it
										// wrong opens somebody else's conversation.
										return {
											content: [{
												type: "text",
												text: `More than one person is called "${found.name}":\n`
													+ found.candidates.map((c) =>
														`  ${c.name}: ${c.handles[0]}`
														+ (c.lastSeen ? `, last in touch ${c.lastSeen}` : ", never in touch"),
													).join("\n")
													+ "\nRead again with the number of the one you mean.",
											}],
											isError: false,
										};
									}
									if (found.kind === "no-thread") {
										// A REAL ABSENCE, and the only branch here entitled to state one:
										// these people are in Contacts and no thread holds all of them.
										return failureResult(
											"not_found",
											`No conversation holds ${found.who.join(" and ")} together. `
											+ "They may each have their own thread: read one name at a time.",
										);
									}
									return await readThread(found.conversation, found.others, args.limit);
								}
								// A HANDLE GOES THROUGH THE SAME LAYER. Reading by number used to select every
								// message that handle had ever sent, across every thread, and print it as
								// "your conversation with +1408...": one side of three different threads
								// interleaved, with no reply in sight. Same rule as a name, one level down.
								const byHandle = await messageModule.conversationsForHandle(handle);
								if (byHandle.length) {
									return await readThread(byHandle[0]!, byHandle.slice(1), args.limit);
								}
								const messages = await messageModule.readMessages(
									handle,
									args.limit,
								);
								// How many the conversation HOLDS. This returned the last ten of a long
								// thread and rendered them as the whole conversation, which is the fault
								// `unread` had (10 of 70) and notes and contacts and mail search each had
								// in the same week.
								const totalWith = await messageModule.countMessagesWith(handle);
								return {
									content: [
										{
											type: "text",
											text:
												messages.length > 0
													? showing(messages.length, totalWith, "message(s)",
															  `with ${handle}`,
															  messageModule.maxMessages()) + "\n" + messages
															.map(
																(msg) =>
																	`[${new Date(msg.date).toLocaleString()}] ${msg.is_from_me ? "Me" : msg.sender}: ${msg.content}`,
															)
															.join("\n")
													: showing(0, 0, "message(s)", `with ${handle}`),
										},
									],
									isError: false,
								};
							}

							case "schedule": {
								if (!args.phoneNumber || !args.message || !args.scheduledTime) {
									return failureResult(
										"bad_request",
										"Could not schedule the message: a phone number, a message and a " +
											"scheduled time are all required.",
									);
								}
								const scheduledMsg = await messageModule.scheduleMessage(
									args.phoneNumber,
									args.message,
									new Date(args.scheduledTime),
								);
								return {
									content: [
										{
											type: "text",
											text: `Message scheduled to be sent to ${args.phoneNumber} at ${scheduledMsg.scheduledTime}`,
										},
									],
									isError: false,
								};
							}

							case "unread": {
								const messages = await messageModule.getUnreadMessages(
									args.limit,
								);
								// How many there REALLY are. This said "Found 10 unread message(s)" on a
								// Mac holding 70, with nothing to say it had stopped at ten, so a person
								// asking "have I got anything unread" was told a number that was true
								// about the page and false about their phone.
								const totalUnread = await messageModule.countUnreadMessages();

								// Look up contact names for all messages, in ONE pass over the address book.
								//
								// This used to be a `Promise.all` that asked for a name PER MESSAGE, and
								// nothing here caches, so each of those read all 1,647 cards over Apple
								// Events on its own. `{"operation":"unread","limit":2}` measured 306.0s,
								// of which the sqlite query that finds the messages was 0.05s: the whole
								// call was two address books being read to put two names on two lines.
								const contactsModule = await loadModule("contacts");
								const senders = messages
									.filter((msg) => !msg.is_from_me)
									.map((msg) => msg.sender);
								// A NAME IS A NICETY; THE MESSAGES ARE THE ANSWER.
								//
								// This throw escaped to the outer catch, so a person with Contacts
								// permission off got NO unread messages at all and a contacts-flavoured
								// error, rather than their messages with raw phone numbers on them. Through
								// the messaging proxy that surfaced as "Could not reach iMessage:
								// [permission_denied] Your contacts can only be read inside Maestro", and
								// if iMessage was their only app, as a total failure.
								//
								// The fallback below already handles a handle with no name, which is what
								// makes this safe: an empty map degrades to exactly that path.
								let names = new Map<string, string>();
								try {
									names = await contactsModule.namesForHandles(senders);
								} catch (nameError) {
									console.error("unread: could not put names on senders:", nameError);
								}
								const messagesWithNames = messages.map((msg) => {
									if (msg.is_from_me) return { ...msg, displayName: "Me" };
									const contactName = names.get((msg.sender ?? "").trim());
									// Contact name if there is one, otherwise the phone/email itself.
									return { ...msg, displayName: contactName || msg.sender };
								});

								return {
									content: [
										{
											type: "text",
											text:
												messagesWithNames.length > 0
													? showing(messagesWithNames.length, totalUnread,
															  "unread message(s)", "",
															  messageModule.maxMessages()) + "\n" +
														messagesWithNames
															.map(
																(msg) =>
																	`[${new Date(msg.date).toLocaleString()}] From ${msg.displayName}:\n${msg.content}`,
															)
															.join("\n\n")
													: "No unread messages found",
										},
									],
									isError: false,
								};
							}

							case "recent": {
								// WHO HAS BEEN IN TOUCH, which is how anybody finds a thread they did not
								// memorise a number for. Before this the only listing verb was `unread`,
								// and on a real Mac that answered a request for "the last five messages I
								// received" with five of seventy-one unread marketing texts from ten days
								// earlier, while the message meant had arrived that afternoon and been read.
								// AND IT LISTS THREADS, NOT PEOPLE. This grouped by handle, so a group chat
								// came back as one row per member and the thread itself was invisible: the
								// conversation where a meeting was being arranged could not be named, only
								// its participants separately.
								const conversations = await messageModule.listConversations(args.limit);
								const contactsForList = await loadModule("contacts");
								let listNames = new Map<string, string>();
								try {
									// A name is a nicety; the threads are the answer. A Contacts denial must
									// not turn a thread list into a contacts-flavoured error.
									listNames = await contactsForList.namesForHandles(
										conversations.flatMap((c) => c.participants));
								} catch (nameError) {
									console.error("recent: could not name the participants:", nameError);
								}
								const label = (c: typeof conversations[number]) =>
									c.title || c.participants.map((h) => listNames.get(h.trim()) || h).join(", ")
									|| "(unknown)";
								return {
									content: [{
										type: "text",
										text: conversations.length > 0
											? `${conversations.length} recent conversation(s), most recent first:\n` +
												conversations.map((c) =>
													`[${new Date(c.lastDate ?? "").toLocaleString()}] `
													+ `${label(c)}${c.isGroup ? " (group)" : ""}\n`
													+ `  ${c.lastFromMe ? "You" : "Them"}: ${c.lastMessage ?? ""}`,
												).join("\n\n")
											: "No conversations found",
									}],
									isError: false,
								};
							}

							case "search": {
								// FINDING A MESSAGE BY ITS WORDS, which was simply refused before: the
								// proxy answered "[not_supported] iMessage cannot do that, so nothing was
								// searched", so somebody who could not name the exact handle had no route.
								const { messages: found, coverage } =
									await messageModule.searchMessages(args.query!, args.limit);
								const contactsModule = await loadModule("contacts");
								let names = new Map<string, string>();
								try {
									// A NAME IS A NICETY; THE MESSAGES ARE THE ANSWER. Same rule as `unread`
									// above, and for the same reason: a Contacts denial must not turn a
									// list of messages into a contacts-flavoured error.
									names = await contactsModule.namesForHandles(
										found.filter((m) => !m.is_from_me).map((m) => m.sender));
								} catch (nameError) {
									console.error("search: could not put names on senders:", nameError);
								}
								// NAME THE THREAD EACH HIT CAME OUT OF, so the caller can read it. Built
								// from the conversations the hits actually landed in, not a second scan.
								const threadOf = new Map<number, string>();
								try {
									const chats = await messageModule.listConversations(100);
									const wanted = new Set(found.map((m) => m.chatId).filter((id) => id != null));
									const mine = chats.filter((c) => wanted.has(c.chatId));
									// A NAME IS A NICETY; THE THREAD IS THE ANSWER. This once sat inside the
									// same try as the Contacts call, so a Contacts denial deleted the thread
									// label entirely and a hit went back to being a dead end over a nicety.
									// Caught by running it on a machine where Contacts was denied.
									let chatNames = new Map<string, string>();
									try {
										chatNames = await contactsModule.namesForHandles(
											mine.flatMap((c) => c.participants));
									} catch (nameError) {
										console.error("search: could not name the participants:", nameError);
									}
									for (const c of mine) {
										const label = c.title
											|| c.participants.map((h) => chatNames.get(h.trim()) || h).join(", ");
										if (label) threadOf.set(c.chatId, `your ${c.isGroup ? "group " : ""}conversation with ${label}`);
									}
								} catch (threadError) {
									console.error("search: could not name the threads:", threadError);
								}
								// SAY WHAT WAS SEARCHED WHEN IT WAS NOT EVERYTHING. Silence here reads as
								// "you have no such messages", and a person cannot tell the difference
								// between an empty history and a scan that stopped short of it.
								const reach = coverage.bounded
									? ` The most recent ${coverage.scanned.toLocaleString()} messages were`
										+ ` searched${coverage.oldest ? `, back to ${coverage.oldest.split(" ")[0]}` : ""}`
										+ ", so anything older was not."
									: "";
								return {
									content: [{
										type: "text",
										text: found.length > 0
											? `${found.length} message(s) matching "${args.query}", most recent first:\n` +
												found.map((m) =>
													`[${new Date(m.date).toLocaleString()}] `
													+ `${m.is_from_me ? "You" : (names.get((m.sender ?? "").trim()) || m.sender)}`
													// THE THREAD, so a hit is somewhere to go. Without it a
													// search could find exactly the right message and leave
													// the caller no way to open the conversation around it.
													+ `${threadOf.get(m.chatId ?? -1) ? ` in ${threadOf.get(m.chatId ?? -1)}` : ""}:\n`
													+ m.content,
												).join("\n\n") + (reach ? `\n\n(${reach.trim()})` : "")
											: `No messages found matching "${args.query}".${reach}`,
									}],
									isError: false,
								};
							}

							default:
								return failureResult(
									"bad_request",
									`Could not run the messages tool: "${args.operation}" is not one of send, read, search, recent, schedule or unread.`,
								);
						}
					} catch (error) {
						return failureResultFrom(
							error,
							"internal_error",
							"Could not run the messages tool.",
						);
					}
				}

				case "reminders": {
					if (!isRemindersArgs(args)) {
						return failureResult(
							"bad_request",
							"Could not run the reminders tool: `operation` must be list, search, open, " +
								"create or listById, with `searchText` for a search or an open, `name` for a " +
								"create, and `listId` for a listById.",
						);
					}

					try {
						const remindersModule = await loadModule("reminders");

						const { operation } = args;

						if (operation === "list") {
							// An INDEX: every list, every reminder, one line each. Not the count it used to
							// be, and not the whole store either.
							//
							// It used to return `Found 50 lists and 1217 reminders.` and put the actual
							// reminders in a top-level `reminders` field. Nothing reads that field: an MCP
							// client sees `content` and nothing else, so the model was handed a count of
							// things it could not see, and no route to them. That was invisible for as long
							// as this operation never returned at all (#499); fixing the speed is what made
							// it visible.
							//
							// A reminder's NAME is the reminder, so an index of names is the whole useful
							// picture. Notes are the other way round and get a 200-character preview (#504);
							// the shape is the same, the content differs because the content differs.
							const lists = await remindersModule.getAllLists();
							const allReminders = await remindersModule.getAllReminders();
							return {
								content: [
									{
										type: "text",
										text: remindersIndex(lists, allReminders),
									},
								],
								isError: false,
							};
						} else if (operation === "search") {
							// Search for reminders
							const { searchText } = args;
							const results = await remindersModule.searchReminders(
								searchText!,
							);
							return {
								content: [
									{
										type: "text",
										text:
											results.length > 0
												? `Found ${results.length} reminders matching "${searchText}":\n\n` +
													results.map(remindersDetail).join("\n\n")
												: `No reminders found matching "${searchText}".`,
									},
								],
								isError: false,
							};
						} else if (operation === "open") {
							// Open a reminder. openReminder THROWS when nothing matches, so reaching this
							// line means a reminder was found and Reminders was brought forward.
							const { searchText } = args;
							const result = await remindersModule.openReminder(searchText!);
							return {
								content: [
									{
										type: "text",
										text: `Opened Reminders app. Found reminder: ${result.reminder.name}`,
									},
								],
								...result,
								isError: false,
							};
						} else if (operation === "create") {
							// Create a reminder
							const { name, listName, notes, dueDate } = args;
							const result = await remindersModule.createReminder(
								name!,
								listName,
								notes,
								dueDate,
							);
							return {
								content: [
									{
										type: "text",
										text: `Created reminder "${result.name}" in list "${result.listName}".`,
									},
								],
								success: true,
								isError: false,
							};
						} else if (operation === "listById") {
							// Get reminders from a specific list by ID
							const { listId, props } = args;
							const results = await remindersModule.getRemindersFromListById(
								listId!,
								props,
							);
							return {
								content: [
									{
										type: "text",
										text:
											results.length > 0
												? `Found ${results.length} reminders in that list:\n\n` +
													results.map(remindersDetail).join("\n\n")
												: "That list has no reminders in it.",
									},
								],
								isError: false,
							};
						}

						return failureResult(
							"bad_request",
							`Could not run the reminders tool: "${operation}" is not one of list, search, open, create or listById.`,
						);
					} catch (error) {
						return failureResultFrom(
							error,
							"internal_error",
							"Could not run the reminders tool.",
						);
					}
				}


				case "calendar": {
					if (!isCalendarArgs(args)) {
						return failureResult(
							"bad_request",
							"Could not run the calendar tool: `operation` must be search, open, list or " +
								"create, with `searchText` for a search, `eventId` for an open, and `title` " +
								"plus `startDate` plus `endDate` for a create.",
						);
					}

					try {
						const calendarModule = await loadModule("calendar");
						const { operation } = args;

						switch (operation) {
							case "search": {
								const { searchText, limit, fromDate, toDate } = args;
								const events = await calendarModule.searchEvents(
									searchText!,
									limit,
									fromDate,
									toDate,
								);

								const trimmed = calendarTruncationNote(calendarModule.truncation());
								return {
									content: [
										{
											type: "text",
											text:
												events.length > 0
													? `Found ${events.length} events matching "${searchText}":\n\n${events
															.map(
																(event) =>
																	`${event.title} (${new Date(event.startDate!).toLocaleString()} - ${new Date(event.endDate!).toLocaleString()})\n` +
																	`Location: ${event.location || "Not specified"}\n` +
																	`Calendar: ${event.calendarName}\n` +
																	`ID: ${event.id}\n` +
																	`${event.notes ? `Notes: ${event.notes}\n` : ""}`,
															)
															.join("\n\n")}${trimmed}`
													: `No events found matching "${searchText}".${trimmed}`,
										},
									],
									isError: false,
								};
							}

							case "open": {
								// openEvent THROWS when the id matches nothing, so reaching this line means
								// the event exists and Calendar was brought forward on it.
								const { eventId } = args;
								const result = await calendarModule.openEvent(eventId!);

								return {
									content: [{ type: "text", text: result.message }],
									isError: false,
								};
							}

							case "list": {
								const { limit, fromDate, toDate } = args;
								const events = await calendarModule.getEvents(
									limit,
									fromDate,
									toDate,
								);

								const startDateText = fromDate
									? new Date(fromDate).toLocaleDateString()
									: "today";
								const endDateText = toDate
									? new Date(toDate).toLocaleDateString()
									: "next 7 days";
								const trimmed = calendarTruncationNote(calendarModule.truncation());

								return {
									content: [
										{
											type: "text",
											text:
												events.length > 0
													? `Found ${events.length} events from ${startDateText} to ${endDateText}:\n\n${events
															.map(
																(event) =>
																	`${event.title} (${new Date(event.startDate!).toLocaleString()} - ${new Date(event.endDate!).toLocaleString()})\n` +
																	`Location: ${event.location || "Not specified"}\n` +
																	`Calendar: ${event.calendarName}\n` +
																	`ID: ${event.id}`,
															)
															.join("\n\n")}${trimmed}`
													: `No events found from ${startDateText} to ${endDateText}.${trimmed}`,
										},
									],
									isError: false,
								};
							}

							case "create": {
								const {
									title,
									startDate,
									endDate,
									location,
									notes,
									isAllDay,
									calendarName,
								} = args;
								// createEvent THROWS on every failure now, so reaching this line means the
								// event exists.
								const result = await calendarModule.createEvent(
									title!,
									startDate!,
									endDate!,
									location,
									notes,
									isAllDay,
									calendarName,
								);
								return {
									content: [
										{
											type: "text",
											text: `${result.message} Event scheduled from ${new Date(startDate!).toLocaleString()} to ${new Date(endDate!).toLocaleString()}\nEvent ID: ${result.eventId}`,
										},
									],
									isError: false,
								};
							}

							default:
								return failureResult(
									"bad_request",
									`Could not run the calendar tool: "${operation}" is not one of search, open, list or create.`,
								);
						}
					} catch (error) {
						return failureResultFrom(
							error,
							"internal_error",
							"Could not run the calendar tool.",
						);
					}
				}

				default:
					return failureResult(
						"unknown_tool",
						`There is no tool called "${name}" on this server.`,
					);
			}
		} catch (error) {
			// The backstop. Everything below this now raises a typed failure, so anything arriving here
			// is unclassified: it keeps a plain sentence and carries the thrown value verbatim, because
			// the one thing we must not do is decide what an error we did not anticipate means.
			return failureResultFrom(
				error,
				"internal_error",
				`Could not run the "${request.params.name}" tool.`,
			);
		}
	});

	// Start the server transport
	console.error("Setting up MCP server transport...");

	(async () => {
		try {
			console.error("Initializing transport...");
			const transport = new StdioServerTransport();

			// Ensure stdout is only used for JSON messages
			console.error("Setting up stdout filter...");
			const originalStdoutWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
				// Only allow JSON messages to pass through
				if (typeof chunk === "string" && !chunk.startsWith("{")) {
					console.error("Filtering non-JSON stdout message");
					return true; // Silently skip non-JSON messages
				}
				return originalStdoutWrite(chunk, encoding, callback);
			};

			console.error("Connecting transport to server...");
			await server.connect(transport);
			console.error("Server connected successfully!");
		} catch (error) {
			console.error("Failed to initialize MCP server:", error);
			process.exit(1);
		}
	})();
}

// Helper functions for argument type checking
function isContactsArgs(args: unknown): args is { name?: string } {
	return (
		typeof args === "object" &&
		args !== null &&
		(!("name" in args) || typeof (args as { name: string }).name === "string")
	);
}

function isNotesArgs(args: unknown): args is {
	operation: "search" | "list" | "create";
	searchText?: string;
	title?: string;
	body?: string;
	folderName?: string;
} {
	if (typeof args !== "object" || args === null) {
		return false;
	}

	const { operation } = args as { operation?: unknown };
	if (typeof operation !== "string") {
		return false;
	}

	if (!["search", "list", "create"].includes(operation)) {
		return false;
	}

	// Validate fields based on operation
	if (operation === "search") {
		const { searchText } = args as { searchText?: unknown };
		if (typeof searchText !== "string" || searchText === "") {
			return false;
		}
	}

	if (operation === "create") {
		const { title, body } = args as { title?: unknown; body?: unknown };
		if (typeof title !== "string" || title === "" || typeof body !== "string") {
			return false;
		}

		// Check folderName if provided
		const { folderName } = args as { folderName?: unknown };
		if (
			folderName !== undefined &&
			(typeof folderName !== "string" || folderName === "")
		) {
			return false;
		}
	}

	return true;
}

function isMessagesArgs(args: unknown): args is {
	operation: "send" | "read" | "search" | "recent" | "schedule" | "unread";
	phoneNumber?: string;
	message?: string;
	query?: string;
	limit?: number;
	scheduledTime?: string;
} {
	if (typeof args !== "object" || args === null) return false;

	const { operation, phoneNumber, message, query, limit, scheduledTime } = args as any;

	if (
		!operation ||
		!["send", "read", "search", "recent", "schedule", "unread"].includes(operation)
	) {
		return false;
	}

	// Validate required fields based on operation
	switch (operation) {
		case "send":
		case "schedule":
			if (!phoneNumber || !message) return false;
			if (operation === "schedule" && !scheduledTime) return false;
			break;
		case "read":
			if (!phoneNumber) return false;
			break;
		case "search":
			// The words to look for ARE the request; without them this is `recent` with extra steps.
			if (!query || typeof query !== "string" || !query.trim()) return false;
			break;
		case "recent":
		case "unread":
			// No additional required fields
			break;
	}

	// Validate field types if present
	if (phoneNumber && typeof phoneNumber !== "string") return false;
	if (message && typeof message !== "string") return false;
	if (limit && typeof limit !== "number") return false;
	if (scheduledTime && typeof scheduledTime !== "string") return false;
	if (query && typeof query !== "string") return false;

	return true;
}

function isRemindersArgs(args: unknown): args is {
	operation: "list" | "search" | "open" | "create" | "listById";
	searchText?: string;
	name?: string;
	listName?: string;
	listId?: string;
	props?: string[];
	notes?: string;
	dueDate?: string;
} {
	if (typeof args !== "object" || args === null) {
		return false;
	}

	const { operation } = args as any;
	if (typeof operation !== "string") {
		return false;
	}

	if (!["list", "search", "open", "create", "listById"].includes(operation)) {
		return false;
	}

	// For search and open operations, searchText is required
	if (
		(operation === "search" || operation === "open") &&
		(typeof (args as any).searchText !== "string" ||
			(args as any).searchText === "")
	) {
		return false;
	}

	// For create operation, name is required
	if (
		operation === "create" &&
		(typeof (args as any).name !== "string" || (args as any).name === "")
	) {
		return false;
	}

	// For listById operation, listId is required
	if (
		operation === "listById" &&
		(typeof (args as any).listId !== "string" || (args as any).listId === "")
	) {
		return false;
	}

	return true;
}


function isCalendarArgs(args: unknown): args is {
	operation: "search" | "open" | "list" | "create";
	searchText?: string;
	eventId?: string;
	limit?: number;
	fromDate?: string;
	toDate?: string;
	title?: string;
	startDate?: string;
	endDate?: string;
	location?: string;
	notes?: string;
	isAllDay?: boolean;
	calendarName?: string;
} {
	if (typeof args !== "object" || args === null) {
		return false;
	}

	const { operation } = args as { operation?: unknown };
	if (typeof operation !== "string") {
		return false;
	}

	if (!["search", "open", "list", "create"].includes(operation)) {
		return false;
	}

	// Check that required parameters are present for each operation
	if (operation === "search") {
		const { searchText } = args as { searchText?: unknown };
		if (typeof searchText !== "string") {
			return false;
		}
	}

	if (operation === "open") {
		const { eventId } = args as { eventId?: unknown };
		if (typeof eventId !== "string") {
			return false;
		}
	}

	if (operation === "create") {
		const { title, startDate, endDate } = args as {
			title?: unknown;
			startDate?: unknown;
			endDate?: unknown;
		};

		if (
			typeof title !== "string" ||
			typeof startDate !== "string" ||
			typeof endDate !== "string"
		) {
			return false;
		}
	}

	return true;
}

