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
of a day or more get ±5% random fuzz so reviews don't clump onto the same days.

The queue is served in this order:

1. **Learning** cards (level ≤ 1) once five have accumulated, so the buffer drains.
2. **Due reviews**, most overdue first, lightly shuffled among the top few.
3. **New** words in course order, drawn from the released pool (see below).
4. **Extra reps** — a weighted random draw over cards that are not yet due, with weight

   *w* ∝ (0.02 + *f*²) · (1 + 0.4·lapses) / (level + 1)^1.5,  *f* = elapsed fraction of the interval.

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
Easy. `u` undoes the last grade.

## Moving progress between devices

`localStorage` is per-device, so Setup → **Export JSON** and **Import JSON** move it.
Import merges rather than overwrites: for each card it keeps whichever record has the
higher review count.
