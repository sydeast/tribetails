# Walking Claude through the UI in Chrome

Two prompts. The first is for our own app when something looks wrong on screen
and describing it in chat keeps missing. The second is for looking at another
vendor's product and coming back with something buildable.

Both run in Claude in Chrome, in a normal signed-in browser, with the operator
driving the mouse. Claude reads the page, not a screenshot of it, so it sees the
DOM, the console and the network calls without being told about them.

## Why this exists

The issue recorder (`packages/issue-recorder`) covers the case where the
operator wants to walk twenty minutes of the app alone and hand over one file.
It is the right tool when the walk is long or when nobody is available to watch.

It is the wrong tool when the operator wants to point at something and argue
about it. There is no back and forth: the mark is captured, the walk ends, the
drafts appear, and if the note said the wrong thing the whole loop repeats.
These prompts cover that other case. Claude is in the page while the operator is
looking at it, so a wrong reading gets corrected in the same minute it happens.

Output of prompt 1 lands in the same shape `scripts/walk-to-issues` produces, so
the drafts from either route read the same and go into the same folder.

## Prompt 1: live UI walk on our own app

Paste this, then start clicking.

```
We are walking the admin app together. I drive; you observe and write it up.

Rules for the whole session:
- Do not navigate, click, type, or submit anything. I control the browser.
  If you want to see a different screen, ask me to go there.
- Do not fix anything, do not open the editor, do not propose patches yet.
  This session produces a list of findings and nothing else.
- After each of my findings, reply with the draft for that one finding only,
  then wait. No summary, no recap of earlier findings.

When I say "issue" (or point at something and complain), capture:
  Route: the path, not the full URL, unless the query string matters
  What I said: my words, verbatim, quoted. Never paraphrase this.
  Element: tag, visible text, and a CSS selector that would find it again
  Console: only lines emitted since my previous finding
  Network: requests since my previous finding, with non-2xx flagged, and the
    callable name where the URL is a Firebase callable
  Screenshot: take one, scoped to the element and its surroundings, not the
    full page unless layout is the complaint

Then write a draft issue with these headings, in this order, skipping any
heading that has nothing under it:
  ## What the operator said
  ## Element under the cursor
  ## Console
  ## Network
  ## What should happen instead

The last heading is the one I have to answer. If I did not say what correct
looks like, ask me one short question and stop. Do not guess it and do not
write "should work as expected".

Title format: `admin <route>: <the thing that is wrong>`. Take the subject
from my words first, the element second, the failing callable third. No
generic titles.

When I say "done", write every draft to
.walks/chrome-<today>/<n>-<slug>.md in the repo, one file per finding, and
print the list of titles. Do not file GitHub issues. Do not start fixing.
```

Two things that matter about the shape of that prompt. The operator's words are
quoted rather than summarized, because those words are the only part of the
issue nobody else could have written. And the "what should happen instead"
heading is a question, not a field to fill in: an issue that says the screen is
broken without saying what correct looks like will be guessed at later, and the
guess will be wrong.

## Prompt 2: studying how another vendor does something

For the case where a competitor has already solved a problem well and the goal
is to build our version of it rather than to admire theirs.

```
We are looking at how <vendor> handles <feature>. I drive; you watch and take
notes I can build from.

Rules:
- I control the browser. Do not click, type, submit forms, or sign anything up.
- Nothing here is a design source on its own. You are describing behaviour so
  we can decide what ours should be, not copying a screen.
- Ignore their branding entirely: colours, fonts, logo, illustration, voice.
  Do not tell me what shade of blue they used.

For each screen I stop on, write:
  What the screen is for, in one sentence, in terms of the job the user came
    to do
  The order things happen in: what the user sees first, what is asked for and
    when, what is deferred until later
  Decisions the design makes for the user, and the default it picks
  What happens on the unhappy path if I can see it: empty state, error, the
    half-filled form
  Anything expensive hiding behind it: does this need data we do not have,
    a background job, a third party, a permission model change

Then, per feature, one section headed "What ours would need", listing the
concrete pieces: the screens, the callables, the Firestore shape, the places
in our existing flow it would have to attach to. Say which of those we
already have. Name real files where you can. If you do not know, say you do
not know rather than inventing a path.

Flag anything that looks like it depends on scale we do not have (a review
corpus, a marketplace of providers, years of history), because a feature that
only works at their size is not a feature we can copy.

When I say "done", write it to docs/vendor-notes/<vendor>-<feature>.md and
print the section headings.
```

The last two paragraphs are the point of the prompt. Notes on a competitor's
feature are cheap to produce and mostly useless; the sentence that earns its
place is the one saying which parts we already have and which part is the
month of work.

## Practical notes

The walk export lands in `~/Downloads`, which this app cannot read: macOS
returns `EPERM` on open even though it can list the folder. Either drag the file
into the repo, or grant Downloads access under System Settings, Privacy and
Security, Files and Folders. Neither prompt above has this problem, since
nothing leaves the browser.

Screenshots taken in Chrome go through the conversation, not to disk, so a long
session gets expensive. Ask for element-scoped shots and full-page ones only
when the complaint is about layout.
