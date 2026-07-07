import { type Tool } from "@modelcontextprotocol/sdk/types.js";

const CONTACTS_TOOL: Tool = {
  name: "contacts",
  description:
    "Read and manage Apple Contacts (the macOS address book). Operations: 'list' (all contacts with phone numbers), 'search' (contacts whose name matches — returns names, phones, emails), 'create' (a new person from first/last name, organization, phones, emails), 'update' (find a person by name, then rename and/or add/remove phones & emails), 'delete' (find a person by name and remove them). Writes are persisted to the address book (and synced via iCloud if enabled). When omitted, 'operation' defaults to 'search' if a name is given, otherwise 'list'.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "What to do. Defaults to 'search' when a name is given, else 'list'.",
        enum: ["list", "search", "create", "update", "delete"],
      },
      name: {
        type: "string",
        description:
          "For 'search': the (partial) name to match. For 'update'/'delete': the name that identifies WHICH existing contact to change (first match wins). Not used by 'create' (use firstName/lastName there).",
      },
      firstName: {
        type: "string",
        description:
          "First name. On 'create' it names the new person; on 'update' it RENAMES the matched contact's first name.",
      },
      lastName: {
        type: "string",
        description:
          "Last name. On 'create' it names the new person; on 'update' it RENAMES the matched contact's last name.",
      },
      organization: {
        type: "string",
        description:
          "Company/organization. Settable on 'create' and 'update'. For a company-only contact, provide this with no first/last name.",
      },
      phones: {
        type: "array",
        items: { type: "string" },
        description:
          "Phone numbers to attach when creating a contact (create only). For changing an existing contact's numbers use addPhones / removePhones.",
      },
      emails: {
        type: "array",
        items: { type: "string" },
        description:
          "Email addresses to attach when creating a contact (create only). For changing an existing contact's emails use addEmails / removeEmails.",
      },
      addPhones: {
        type: "array",
        items: { type: "string" },
        description: "Phone numbers to ADD to the matched contact (update only).",
      },
      addEmails: {
        type: "array",
        items: { type: "string" },
        description: "Email addresses to ADD to the matched contact (update only).",
      },
      removePhones: {
        type: "array",
        items: { type: "string" },
        description:
          "Phone numbers to REMOVE from the matched contact (update only). Matched loosely by digits, so country-code/formatting differences are tolerated.",
      },
      removeEmails: {
        type: "array",
        items: { type: "string" },
        description:
          "Email addresses to REMOVE from the matched contact (update only). Matched case-insensitively. To CHANGE a value, remove the old one and add the new one in the same call.",
      },
      phoneLabel: {
        type: "string",
        description:
          "Label for phones added by create/update (e.g. 'mobile', 'home', 'work'). Defaults to 'mobile'.",
      },
      emailLabel: {
        type: "string",
        description:
          "Label for emails added by create/update (e.g. 'home', 'work'). Defaults to 'home'.",
      },
    },
  },
};

const NOTES_TOOL: Tool = {
  name: "notes",
  description:
    "Full CRUD for Apple Notes. Operations: 'search' (FAST — finds notes by TITLE only, server-side; " +
    "use this to locate a note, then 'get' it by id), 'list' (heavier full scan of all notes or one " +
    "folder, newest first, with optional date range), 'get' (one note's full plaintext + HTML body by " +
    "noteId or title), 'create', 'update' (replace the whole body OR append to it), 'delete', " +
    "'listFolders', and 'createFolder'. " +
    "RICH FORMATTING: a note's body is HTML. Pass the body as Markdown (the default) and it is " +
    "converted to HTML for you — use '#'/'##' headings, **bold**, *italic*, `code`, '- ' / '1. ' " +
    "lists, '> ' quotes, '---' rules, and [links](https://…) to produce nicely formatted notes. Set " +
    "format:'html' to supply raw HTML, or format:'plain' for literal text. " +
    "Prefer 'search' over 'list' when you know the title; prefer the noteId returned by search/get/list " +
    "over title for 'get'/'update'/'delete' (it targets one exact note).",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "What to do: 'search' (fast title lookup), 'list' (all notes / a folder), 'get' (one note's " +
          "full content), 'create', 'update' (replace or append body), 'delete', 'listFolders', " +
          "'createFolder'.",
        enum: [
          "search",
          "list",
          "get",
          "create",
          "update",
          "delete",
          "listFolders",
          "createFolder",
        ],
      },
      searchText: {
        type: "string",
        description: "search: case-insensitive text to match against note TITLES (required for search).",
      },
      title: {
        type: "string",
        description:
          "create: the new note's title (required). get/update/delete: locate the note by title " +
          "(exact match preferred) when you don't have its noteId.",
      },
      noteId: {
        type: "string",
        description:
          "get/update/delete: the exact note id (as returned by search/list/get). Preferred over title " +
          "— it targets one specific note unambiguously.",
      },
      body: {
        type: "string",
        description:
          "create/update: the note body. Interpreted per 'format' (Markdown by default → converted to " +
          "HTML). Required for update.",
      },
      format: {
        type: "string",
        description:
          "How to interpret 'body': 'markdown' (default — converts headings/bold/italic/lists/links/" +
          "quotes/rules to HTML), 'html' (raw HTML passed through), or 'plain' (literal text).",
        enum: ["markdown", "html", "plain"],
      },
      mode: {
        type: "string",
        description:
          "update only: 'replace' (default — overwrite the whole body) or 'append' (add the new content " +
          "to the end of the existing note).",
        enum: ["replace", "append"],
      },
      folderName: {
        type: "string",
        description:
          "create: the destination folder (created if missing; defaults to 'Claude'). list: scope the " +
          "listing to this folder. createFolder: the name of the folder to create (required).",
      },
      fromDate: {
        type: "string",
        description: "list: only notes modified on/after this ISO 8601 date/time (optional).",
      },
      toDate: {
        type: "string",
        description: "list: only notes modified on/before this ISO 8601 date/time (optional).",
      },
      limit: {
        type: "number",
        description: "list: max number of notes to return, newest-modified first (optional).",
      },
    },
    required: ["operation"],
  },
};

const MESSAGES_TOOL: Tool = {
  name: "messages",
  description:
    "Apple Messages (iMessage). READ: 'fetch' returns recent messages newest-first in ONE query, each tagged read/unread and who it's from — to read someone's conversation, fetch with their contactName (it covers all their numbers/emails at once) and a small limit; do NOT list everything and filter. 'conversations' lists your most recently active distinct threads (one preview line each) — use it to answer 'who messaged me recently' without reading any single thread. WRITE: 'send' sends now; 'schedule' sends later. iMessage has NO programmatic edit, unsend, delete, or mark-as-read — those are not exposed by any scripting API, so this tool does not offer them.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "'fetch' = read recent messages (optionally scoped to one person via contactName/phoneNumber). 'conversations' = list recently active threads, newest first. 'send' = send now. 'schedule' = send at a future time.",
        enum: ["fetch", "conversations", "send", "schedule"],
      },
      contactName: {
        type: "string",
        description:
          "fetch: the person whose conversation to read (e.g. 'Marco Ferrari'). Resolves ALL their numbers/emails, so one fetch covers the whole thread — prefer this over phoneNumber when you have a name.",
      },
      phoneNumber: {
        type: "string",
        description:
          "A specific handle — phone number (E.164 like +391234567) or iMessage email. Required for send/schedule. For fetch, an alternative to contactName when you have an exact handle.",
      },
      limit: {
        type: "number",
        description:
          "fetch: max messages to return, newest first (default 10, max 50). conversations: max threads to return (default 10, max 50). For 'their latest message' use a small value like 1–3.",
      },
      status: {
        type: "string",
        description:
          "fetch filter (optional): 'unread' = only unread incoming; 'read' = only read incoming. Omit for all.",
        enum: ["read", "unread"],
      },
      from: {
        type: "string",
        description:
          "fetch filter (optional): 'them' = only messages they sent you; 'me' = only messages you sent. Omit for both.",
        enum: ["them", "me"],
      },
      message: {
        type: "string",
        description: "Message body (required for send and schedule).",
      },
      scheduledTime: {
        type: "string",
        description:
          "ISO timestamp of when to send (required for schedule). Must be in the future.",
      },
    },
    required: ["operation"],
  },
};

const REMINDERS_TOOL: Tool = {
  name: "reminders",
  description: "List, search, get, open, create, update, complete/uncomplete, and delete reminders in Apple Reminders.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "'create' a NEW reminder. 'update' to CHANGE AN EXISTING reminder in place — its time, name, notes, or completion (find it via searchText); use 'update' whenever the user asks to change / move / reschedule / rename an existing reminder, and do NOT 'create' a duplicate. 'complete' marks the matched reminder done; 'uncomplete' marks it not-done. 'delete' permanently removes the first reminder matching searchText. 'get' returns the single best name/body match. Also 'list' (all lists + reminders), 'search' (by name/body), 'open' (reveal in the Reminders app), and 'listById' (reminders in one list by id).",
        enum: ["list", "search", "get", "open", "create", "update", "complete", "uncomplete", "delete", "listById"]
      },
      searchText: {
        type: "string",
        description: "Text to match a reminder's name (and, for search/get, its body). Required for search, get, open, update, complete, uncomplete, and delete (to find which reminder to act on)."
      },
      name: {
        type: "string",
        description: "create: the new reminder's name (required). update: a new name for the reminder (optional)."
      },
      listName: {
        type: "string",
        description: "Name of the list to create the reminder in (optional for create; the list is created if it does not exist)."
      },
      listId: {
        type: "string",
        description: "ID of the list to get reminders from (required for listById)."
      },
      props: {
        type: "array",
        items: { type: "string" },
        description: "Properties to include in the reminders (optional for listById)."
      },
      notes: {
        type: "string",
        description: "Reminder notes/body (optional for create and update)."
      },
      dueDate: {
        type: "string",
        description: "Due date/time in ISO format (optional for create and update — set this to reschedule)."
      },
      completed: {
        type: "boolean",
        description: "update only: set true to mark the reminder done, false to un-complete it. (For a one-shot toggle prefer the dedicated 'complete'/'uncomplete' operations.)"
      },
      recurrence: {
        type: "object",
        description: "Repeat rule (optional for create and update): set when the user says 'every day/week/month/year'. Requires a dueDate (a repeat needs an anchor). E.g. {\"frequency\":\"daily\"} or {\"frequency\":\"weekly\",\"interval\":2} for every 2 weeks.",
        properties: {
          frequency: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
          interval: { type: "number", description: "Repeat every N periods (default 1)." }
        },
        required: ["frequency"]
      }
    },
    required: ["operation"]
  }
};

const CALENDAR_TOOL: Tool = {
  name: "calendar",
  description:
    "Read and manage events in the macOS Calendar app. Operations: 'list' (events in a date window), " +
    "'search' (events whose title/location/notes contain text), 'open' (reveal an event in the app by id), " +
    "'create' (add an event), 'update' (rename/move/relocate/re-note an existing event), and 'delete' " +
    "(remove an event). Locate an event for update/delete by its stable eventId, or by title within a " +
    "date window — a title that matches more than one event returns the candidates so you can re-issue " +
    "with a specific eventId.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: "Operation to perform.",
        enum: ["search", "open", "list", "create", "update", "delete"],
      },
      searchText: {
        type: "string",
        description: "Text to match in event title/location/notes (required for 'search').",
      },
      eventId: {
        type: "string",
        description:
          "Stable event id (uid). Required for 'open'. For 'update'/'delete' it is the precise locator " +
          "and takes precedence over 'title' when both are given.",
      },
      limit: {
        type: "number",
        description: "Max events to return for 'search'/'list' (optional, default 10).",
      },
      fromDate: {
        type: "string",
        description:
          "ISO-8601 start of the date window (optional, default = now). Used by 'search'/'list' and by " +
          "'update'/'delete' when locating by title.",
      },
      toDate: {
        type: "string",
        description:
          "ISO-8601 end of the date window (optional; default = +7d for 'list', +30d for 'search' and " +
          "for title-based 'update'/'delete').",
      },
      title: {
        type: "string",
        description:
          "For 'create': the new event's title (required). For 'update'/'delete': a title to locate the " +
          "event by within the date window (used when no eventId is given).",
      },
      startDate: {
        type: "string",
        description: "ISO-8601 start date/time of the event (required for 'create').",
      },
      endDate: {
        type: "string",
        description: "ISO-8601 end date/time of the event (required for 'create').",
      },
      location: {
        type: "string",
        description: "Event location (optional, for 'create').",
      },
      notes: {
        type: "string",
        description: "Event notes/description (optional, for 'create').",
      },
      isAllDay: {
        type: "boolean",
        description: "Whether the event is all-day (optional, for 'create', default false).",
      },
      calendarName: {
        type: "string",
        description:
          "Name of the calendar to create the event in (optional, for 'create'; defaults to the first " +
          "available calendar).",
      },
      newTitle: {
        type: "string",
        description: "New title to set on the located event (optional, for 'update'; cannot be empty).",
      },
      newStartDate: {
        type: "string",
        description: "New ISO-8601 start date/time to set on the located event (optional, for 'update').",
      },
      newEndDate: {
        type: "string",
        description: "New ISO-8601 end date/time to set on the located event (optional, for 'update').",
      },
      newLocation: {
        type: "string",
        description:
          "New location to set on the located event (optional, for 'update'; pass an empty string to clear it).",
      },
      newNotes: {
        type: "string",
        description:
          "New notes/description to set on the located event (optional, for 'update'; pass an empty string to clear it).",
      },
      recurrence: {
        type: "object",
        description:
          "Repeat rule (optional for 'create' and 'update'): set when the user says 'every day/week/" +
          "month/year'. E.g. {\"frequency\":\"weekly\"} or {\"frequency\":\"monthly\",\"interval\":3}.",
        properties: {
          frequency: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
          interval: { type: "number", description: "Repeat every N periods (default 1)." },
        },
        required: ["frequency"],
      },
    },
    required: ["operation"],
  },
};

const tools = [CONTACTS_TOOL, NOTES_TOOL, MESSAGES_TOOL, REMINDERS_TOOL, CALENDAR_TOOL];

export default tools;
