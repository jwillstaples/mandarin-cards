# mandarin-cards

A flashcard trainer for the vocabulary of the Duolingo Mandarin course, built to do the
one thing Duolingo's own review does badly: let you drill *your* vocabulary in *your*
chosen direction, with memory that persists and a queue that keeps weak words in front
of you without ever retiring the strong ones.

Static site — plain HTML, CSS and one JavaScript file. No build step, no dependencies,
no server, no account, no cost. Progress lives in the browser's `localStorage`.

## Contents

| File | Purpose |
|---|---|
| `index.html` | App shell: Study / Stats / Setup views |
| `app.js` | Scheduling, storage, rendering |
| `style.css` | Theme and layout (dark + light, phone-first) |
| `data/vocab.json` | 1,595 words, tagged by course section and unit |
| `manifest.webmanifest`, `icon.svg` | Home-screen install metadata |

## Running it

Because the app fetches `data/vocab.json`, browsers refuse to load it from a bare
`file://` path. Serve the directory:

```bash
python3 -m http.server 8731 --directory ~/Documents/mandarin-cards
```

then open <http://localhost:8731>. For phone access, publish the directory to GitHub
Pages and open the Pages URL; "Add to Home Screen" makes it behave like a native app.

## Vocabulary data

Source: [4044ever/duolingo-chinese-dictionary](https://github.com/4044ever/duolingo-chinese-dictionary),
retrieved 2026-08-10, licensed by its author for reuse. Entries are
`hanzi, pinyin, english, lesson` where lesson is `section-unit` under Duolingo's current
course structure.

Processing applied when building `data/vocab.json`:

- dropped 17 rows with empty or unparseable lesson tags,
- merged duplicate `(hanzi, pinyin)` pairs, unioning their English glosses,
- split multi-gloss English on `/` and `;` into a list, so `看` carries
  `["to read", "watch", "look at"]`,
- sorted by section then unit, and reassigned stable integer ids.

Coverage is Section 1 Unit 1 through Section 4 Unit 19. Section unit counts: S1 = 10,
S2 = 30, S3 = 30, S4 = 19.

### Refreshing the data

The upstream repo grows as its maintainer advances through the course. To pull a newer
snapshot, re-run the conversion in `tools/build_vocab.py`. Word ids are assigned by
sort order, so **ids can shift if upstream inserts a word into an earlier unit**, which
would misalign saved progress. The script prints a warning when that happens.

## How scheduling works

A **card** is a (word, direction) pair. The four directions are 汉字→English,
汉字→Pīnyīn, Pīnyīn→English and English→Pīnyīn, and each carries its own independent
memory — recognising 好 tells you nothing about producing hǎo from "good", so they are
not conflated.

The direction is switched from the Study page itself: a prompt row (汉字 / Pīnyīn /
English / Mix) and an answer row. Pīnyīn and English prompts admit only one answer side,
so those buttons are disabled rather than hidden — the row keeps its height and the
constraint stays visible. **Mix** puts all four directions in one rotation. The Setup
checkboxes remain the general control and the two stay in sync; any selection of more
than one direction reads as Mix.

Each card sits at a **level** 0–8 with a fixed interval:

| Level | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| Interval | 1 min | 10 min | 1 d | 3 d | 7 d | 14 d | 30 d | 60 d | 120 d |

Grading moves the level: *Again* → 0, *Hard* → −1, *Good* → +1, *Easy* → +2. Intervals
of a day or more get ±10% random fuzz so reviews don't clump onto the same days, and so
a batch graded together doesn't come back in lockstep.

The queue is served in this order:

1. **Learning** cards (level ≤ 1) once five have accumulated, so the buffer drains.
2. **Due reviews**, sampled with a bias toward the most overdue — see *Temperature*.
3. **New** words in course order, drawn from the released pool (see below).
4. **Extra reps** — a weighted random draw over cards that are not yet due, with weight

   *w* ∝ (0.02 + *f*²) · (1 + 0.4·lapses) / (level + 1)^1.5,  *f* = elapsed fraction of the interval.

### Temperature

A **Temperature** slider in Setup governs how much lateness biases the draw. Cards score
`1 + 2 x (intervals past due)`, scores are normalised by the largest in the pool, and the
weight is

    w = (score / max score) ^ e,    e = T_max/T - 1,    T_max = 2

so `T = 0` always serves the most overdue card (special-cased, since the exponent
diverges), `T = 1` draws in proportion to lateness, and `T = 2` gives every due card equal
probability. The sweep is continuous and exact at both ends. Measured over 20,000 draws
from a pool of ten cards spanning zero to nine intervals overdue, entropy relative to
uniform runs 0.00 at `T = 0`, 0.72 at 0.5, 0.92 at 1.0, 0.98 at 1.5 and 1.00 at 2.0 — every
notch on the slider changes the distribution.

Two runs from an identical saved state under the old strict-order policy had Spearman
rank correlation 0.947 — effectively the same running order every time, which is what
made the sequence learnable. Sampling drops that to roughly 0.2 at the default `T = 1`.

`T = 0` also switches new-word introduction to strict course order, so the whole queue is
deterministic at zero.

Across all four steps the queue spaces out the **word**, not just the card. One word owns
up to four cards, so serving them together would turn recall into reading the answer off
the previous prompt — you would answer 和 → hé from the 和 → and you saw a second ago. The
last ten words served are held back from selection; when the released pool is too small
to honour that, selection degrades to whichever words were seen longest ago rather than
permitting an immediate repeat. With only three words released and all four directions
active, the queue rotates them at a gap of three, the widest spacing that exists.

New words are introduced earliest-first but through a **random** one of their directions.
Sorting by id alone is stable, so it would otherwise introduce every word through the
same direction, and a mixed session would open with a long run of one kind.

Step 4 is what satisfies "show unfamiliar cards more often but never drop known cards".
The weight rises steeply as a card approaches its due date and falls with level, so
weak cards dominate the extras — but it is strictly positive at every level, so a
level-8 card still surfaces occasionally instead of vanishing for four months.

Grading an extra rep **does not** advance the schedule. Answering correctly on a card
that wasn't due yet is not evidence you'd still know it at the full interval, so
*Hard* / *Good* / *Easy* leave the level and due date untouched. *Again* still demotes:
forgetting early is real information.

## Notes and editing

Rating a card **Again** holds the queue and opens a note panel for that word, showing any
note you have already written and letting you write or amend one on the spot. A miss is
the moment a mnemonic is both most useful and most likely to occur to you, so the note is
not flashed past on the way to the next card. Notes also appear as a marker on the card
and beneath the answer on reveal.

Any card can be edited — the `edit` button on the card, `e` on the keyboard, *Edit card*
in the note panel, or clicking a row in the Stats weakest-cards list. Hanzi, pinyin, the
English glosses and the note are all editable.

Edits never touch `data/vocab.json`, which is replaced wholesale whenever the vocabulary
is refreshed. They live in `state.edits` as **field-level diffs against the shipped word**
and are layered on at load, which has three consequences worth knowing:

- *Revert to original* is always available, because the shipped data is still there.
- Typing a field back to its original value drops the override by itself, so a card stops
  being pinned to your correction the moment it no longer differs.
- A vocabulary refresh still improves fields you never edited.

Notes are keyed by word, not by card, so one mnemonic serves all four directions. On
import, notes are **concatenated rather than replaced** when both devices have one for
the same word — a note written on your phone is never silently dropped by a laptop
import.

## Hiding words

`hide` on the card, `h` on the keyboard, or *Don't show this word again* in the editor
retires a word from the queue. Hidden words are excluded from the deck itself, so they
never surface as new, due, learning or extra reps, and release never hands one back.

Hiding is **not** deletion: the card records, notes and edits all survive untouched, so
restoring a word returns the memory you had built rather than starting it over as new.
Hidden words are listed in Setup with a *Restore* button each and a *Restore all*, and
the panel disappears when nothing is hidden.

## Releasing vocabulary

New words do not trickle in on a schedule. A word enters the queue only once it has been
**released**, and releasing is a manual act: `+10` / `+25` / `+50` / `+100`, *Release all
in range*, or *release everything through Section S Unit U* in Setup, and a compact
`+10 +25 +50 all` bar under the card on the Study page, which appears whenever anything
is still held back and reports where the next batch starts.

Words are stored in course order and their ids are positions in that order, so the
release pointer is a single integer — `settings.released` — and a release always hands
you the words you met earliest. That is the point: vocabulary from months ago should not
be rationed at twenty a day.

Two escape hatches. **Auto-release per day** (default 0, meaning off) tops the pointer up
on the first session of each day if you would rather have a drip. **Hold back unstudied
words** rewinds the pointer to the furthest card you have actually reviewed, undoing an
over-enthusiastic release without touching any memory you have built.

Progress saved before this existed has no pointer; on first load it is seeded past the
furthest card on record, so a returning deck is never locked out of its own history.

A 60-day simulation against this scheduler (409 words × 2 directions, a learner who
misses ~15% of items) introduces every card by day 24, settles at roughly 100 reviews a
day, clears the due queue daily, and leaves **no** level-6-or-higher card untouched for
45 days.

## Keyboard

`space` reveals, then `space` again grades *Good*. `1`–`4` grade Again / Hard / Good /
Easy. `e` edits the current card, `h` hides it, `u` undoes the last grade. Shortcuts stay
out of the way while a text field has focus, and `Esc` closes whichever panel is open.

## Moving progress between devices

`localStorage` is scoped to an **origin**, not to a machine. `http://localhost:8731` and
`https://<user>.github.io` are different origins, so progress built against the local
server is invisible to the published site and vice versa — this is the browser's
same-origin rule, not something the app can reach around. The same applies between two
devices.

Setup → **Export JSON** and **Import JSON** move it. Import merges rather than
overwrites:

- **Cards** — whichever record has the higher review count wins.
- **Notes** — concatenated when both sides have one, so neither is silently dropped.
- **Edits and hidden words** — unioned; existing local entries are not replaced.
- **History** — the larger daily count wins.
- **Settings** — if the receiving device has no cards at all, this is a migration rather
  than a merge, so the file's settings are adopted wholesale. Otherwise only the fields
  that represent progress are carried over, by taking whichever is further along: the
  release pointer and the vocabulary range. Display preferences stay local, and nothing
  ever moves backwards.

Importing without the settings step leaves the cards in place but the release pointer at
zero, which looks like a working import until no new word will enter the queue.
