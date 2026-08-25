#!/usr/bin/env node
import {
	remindersDetail,
	remindersIndex,
} from "./utils/reminders-render";
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
function contactsTruncationNote(cut: { shown: number; total: number } | null): string {
	return cut
		? `\n\n(Only the first ${cut.shown} of ${cut.total} contacts were looked at, so this may be incomplete.)`
		: "";
}
function calendarTruncationNote(cut: { examined: number } | null): string {
	return cut
		? `\n\n(Stopped after the first ${cut.examined} events in this window, so this may be incomplete.)`
		: "";
}
function notesTruncationNote(
	cut: { shown: number; total: number } | null,
	what: string,
): string {
	return cut ? `\n\n(Showing ${cut.shown} of ${cut.total} ${what}.)` : "";
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
							const partial = contactsTruncationNote(contactsModule.truncation());
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
											? lines.join("\n") + partial
											: `No contact found for "${args.name}". Try a different name or use no name parameter to list all contacts.${partial}`,
									},
								],
								isError: false,
							};
						} else {
							const allNumbers = await contactsModule.getAllNumbers();
							// The cap bites HERE too, and this branch used to say nothing about it: a list
							// of "all" contacts that was really the first n of them, with no way to tell.
							const partial = contactsTruncationNote(contactsModule.truncation());
							const contactCount = Object.keys(allNumbers).length;

							if (contactCount === 0) {
								// Nothing FAILED to get here: a denial, an unreachable app and a broken read
								// all throw out of getAllNumbers first. (The old text hedged with "make sure
								// you have granted access to Contacts", which invited a reader to treat an
								// empty result as a permission problem it is not.)
								//
								// But empty is not always the whole story, and this is the one place it can
								// SOUND like it. `partial` is the difference between an address book with
								// nobody in it and a cap that stopped before it reached anybody with a phone
								// number, and saying "No contacts found in the address book" for the second
								// is the exact failure this note exists to prevent. Caught by forcing the cap
								// down to 5 and reading what the server actually returned.
								return {
									content: [
										{
											type: "text",
											text: `No contacts found in the address book.${partial}`,
										},
									],
									isError: false,
								};
							}

							const formattedContacts = Object.entries(allNumbers)
								.filter(([_, phones]) => phones.length > 0)
								.map(([name, phones]) => `${name}: ${phones.join(", ")}`);

							return {
								content: [
									{
										type: "text",
										text:
											formattedContacts.length > 0
												? `Found ${contactCount} contacts:\n\n${formattedContacts.join("\n")}${partial}`
												: `Found contacts but none have phone numbers. Try searching by name to see more details.${partial}`,
									},
								],
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
							"Could not run the messages tool: `operation` must be send, read, schedule or " +
								"unread, with `phoneNumber` for all but unread, `message` for a send or a " +
								"schedule, and `scheduledTime` for a schedule.",
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
								await messageModule.sendMessage(args.phoneNumber, args.message);
								return {
									content: [
										{
											type: "text",
											text: `Message sent to ${args.phoneNumber}`,
										},
									],
									isError: false,
								};
							}

							case "read": {
								if (!args.phoneNumber) {
									return failureResult(
										"bad_request",
										"Could not read your messages: no phone number was given.",
									);
								}
								const messages = await messageModule.readMessages(
									args.phoneNumber,
									args.limit,
								);
								return {
									content: [
										{
											type: "text",
											text:
												messages.length > 0
													? messages
															.map(
																(msg) =>
																	`[${new Date(msg.date).toLocaleString()}] ${msg.is_from_me ? "Me" : msg.sender}: ${msg.content}`,
															)
															.join("\n")
													: "No messages found",
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
								const names = await contactsModule.namesForHandles(senders);
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
													? `Found ${messagesWithNames.length} unread message(s):\n` +
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

							default:
								return failureResult(
									"bad_request",
									`Could not run the messages tool: "${args.operation}" is not one of send, read, schedule or unread.`,
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
	operation: "send" | "read" | "schedule" | "unread";
	phoneNumber?: string;
	message?: string;
	limit?: number;
	scheduledTime?: string;
} {
	if (typeof args !== "object" || args === null) return false;

	const { operation, phoneNumber, message, limit, scheduledTime } = args as any;

	if (
		!operation ||
		!["send", "read", "schedule", "unread"].includes(operation)
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
		case "unread":
			// No additional required fields
			break;
	}

	// Validate field types if present
	if (phoneNumber && typeof phoneNumber !== "string") return false;
	if (message && typeof message !== "string") return false;
	if (limit && typeof limit !== "number") return false;
	if (scheduledTime && typeof scheduledTime !== "string") return false;

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

