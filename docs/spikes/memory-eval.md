# Spike: how well memory answers as the vault grows

- **Date:** 2026-10-06
- **Issue:** [#108](https://github.com/guedesdiogo/kelpie/issues/108)
- **Status:** baseline recorded. Plain full-text search answers 70% of the questions within five results at 100k memories, and the cost per turn stays flat; the misses show what retrieval (#110) has to add.
- **Source:** [`packages/memory/eval/`](../../packages/memory/eval), run with `bun run --filter @kelpie/memory eval`. Unlike the earlier spikes, it is merged, because later stories re-run it as a regression check.

## Question

The owner asked how well memory works as it grows ([ADR-0020](../adr/0020-shared-memory-engine.md)). Before retrieval is tuned (#110), "good enough" needs a yardstick that is:
- in PT-BR, about a person's life, not about code;
- labelled before anything is measured;
- run at sizes that a vault reaches over the years.

This spike builds that yardstick and records where the index from #107 stands on it.

## Method

### The vault

- **No real data.** A fictional owner, Rafael, and his year: family, partner in a consultancy, friends, places, preferences, commitments, decisions, procedures and conversations.
- **The gold:** 46 memories written by hand ([`gold-vault.ts`](../../packages/memory/eval/gold-vault.ts)):
  - 9 change during the year, so the index holds their superseded versions. Examples: the sister moves from Lisbon to Porto, Rafael stops eating red meat, the December holidays move to Porto.
  - 6 are conversation sessions that hold facts true at the time and outdated now. They are the traps for questions about changed facts.
  - Dated commitments carry world-time validity windows.
- **Distractors:** a seeded generator ([`generate.ts`](../../packages/memory/eval/generate.ts)) fills the vault to 1,000, 10,000 and 100,000 memories.
  - They reuse the gold's first names (another Ana, another Bruno), cities, topics and kinds: other people's weddings, other cafés, other commitments.
  - One distractor in ten gets a later version.
  - Every file is written by `writeMemory` and committed in date order, so the vault is what Kelpie would write.
- **Same seed, same vault.** Two runs gave identical accuracy, tokens, version counts and database sizes at every size.

### The labels

- **150 questions** ([`questions.ts`](../../packages/memory/eval/questions.ts)), phrased as the owner would type them, in seven categories:

  | Category | n | What it tests |
  |---|---|---|
  | entity | 35 | Who someone is, where something is |
  | preference | 25 | The owner's preferences and other people's |
  | commitment | 19 | Dates and deadlines; 4 ask what is valid at a date |
  | update | 25 | Facts that changed; 11 label the outdated memories that would mislead |
  | as-of | 15 | What memory held at an earlier date |
  | multi-hop | 20 | Answers that need two memories, such as "where does my partner's wife's sister live" |
  | procedure | 11 | Procedures and decisions |

- **Each question names the memory versions that answer it**, for example `ana` (current) or `ana@1` (the first version).
- **Frozen first.** The labels were committed in [`57d6f0e`](https://github.com/guedesdiogo/kelpie/commit/57d6f0e), before the generator, the runner or any search existed.
  - Their SHA-256 is `12b9571a…640527`.
  - A test fails if they change without a new hash.
  - The test also checks that every "as of" date falls inside the labelled version's window, and every "valid at" date inside the commitment's.

### The retrieval measured

- **The index's own search:** `MemoryIndex.search`, with FTS5 over title, abstract, body and the path's words, `unicode61 remove_diacritics 2`, an OR of the question's words ranked by bm25, and 10 results.
- **No tuning:** no stopwords, no entities, no links, no vectors and no rerank. Those are #110's.
- **Time in the questions** is resolved by arithmetic, as ADR-0020 asks. "As of" questions pass the end of that day as `asOf`; "valid at" questions pass noon of that day as `validAt`. The words of the question, dates included, still go to the search.
- **The packed context** is a stand-in for #110's packing: the top five results, each as its title plus its abstract or the first 400 characters of its body.

### The metrics

- **hit@k:** the share of questions answered within the first k results. A multi-hop question counts as answered only when all its memories are in the top k.
- **MRR:** the mean of 1 ÷ the rank at which the question is answered, with 0 when it isn't.
- **Stale first:** among the 11 questions with outdated memories labelled, the share whose first result is one of them.
- **Tokens:** of the packed context, at four characters per token, the heuristic ai-memory's harness uses.
- **Search latency:** one search, measured inside the Durable Object.
  - workerd's clock ticks in whole milliseconds, so the mean over the 150 questions says more than p50 or p95.
  - The runs were on an Apple M4 with 16 GB, in local workerd `1.20261001.1`, not on Cloudflare.

## Results

| Size | Versions | Index build | Database | hit@1 | hit@3 | hit@5 | hit@10 | MRR | Stale first | Tokens, mean / p95 | Search ms, mean / p95 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | 1,102 | 0.1 s | 1.6 MB | 0.600 | 0.727 | 0.760 | 0.820 | 0.674 | 1 of 11 | 205 / 262 | 0.25 / 1 |
| 10,000 | 11,023 | 1.4 s | 14.6 MB | 0.587 | 0.687 | 0.707 | 0.740 | 0.642 | 0 of 11 | 205 / 263 | 2.3 / 5 |
| 100,000 | 110,023 | 18.2 s | 146.6 MB | 0.567 | 0.680 | 0.700 | 0.707 | 0.624 | 0 of 11 | 207 / 260 | 24.4 / 53 |

By category, hit@5 and MRR:

| Category | n | hit@5 1k | hit@5 10k | hit@5 100k | MRR 1k | MRR 10k | MRR 100k |
|---|---|---|---|---|---|---|---|
| overall | 150 | 0.760 | 0.707 | 0.700 | 0.674 | 0.642 | 0.624 |
| entity | 35 | 0.829 | 0.714 | 0.657 | 0.702 | 0.615 | 0.551 |
| preference | 25 | 0.760 | 0.760 | 0.760 | 0.692 | 0.740 | 0.740 |
| commitment | 19 | 0.789 | 0.737 | 0.737 | 0.763 | 0.717 | 0.711 |
| update | 25 | 0.800 | 0.800 | 0.800 | 0.806 | 0.800 | 0.780 |
| as-of | 15 | 0.733 | 0.600 | 0.600 | 0.610 | 0.547 | 0.567 |
| multi-hop | 20 | 0.450 | 0.400 | 0.450 | 0.220 | 0.199 | 0.193 |
| procedure | 11 | 1.000 | 1.000 | 1.000 | 1.000 | 0.955 | 0.955 |

Per-question ranks for every size are in [`memory-eval-baseline.json`](memory-eval-baseline.json).

## Reading the numbers

- **The cost per turn stays flat.** The packed context is about 205 tokens at every size, because packing takes a fixed number of results.
  - Search time grows with the vault: about 0.25 ms at 1k, 2.3 ms at 10k and 24 ms at 100k. At 100k it is still small next to a model call.
  - The index takes about 1.4 KB per version on disk: 147 MB at 100k, well inside a Durable Object's 10 GB.
- **Accuracy falls slowly with size, and where names are shared.**
  - hit@5 goes from 0.760 to 0.700 between 1k and 100k.
  - Entity questions fall the most, from 0.829 to 0.657: with a hundred Anas in the vault, "o que a Ana faz" finds the wrong one.
- **Changed facts are handled by supersession.** "Update" questions hold at 0.800 at every size, and outdated memories rarely come first: 1 of 11 at 1k, none above. Search returns current versions only, so a superseded version can't mislead; the remaining traps are other notes that repeat an old fact.
- **Five kinds of miss**, seen in the results of the questions answered at no size:
  1. **Common words win.** "Como eu gosto do meu café?" returns cafés named *Bom Gosto*, and "O que a Ana faz da vida?" returns *Laboratório Vida*. ai-memory gained 5.1 points of hit@5 by dropping stopwords from such queries.
  2. **Topics the owner shares with others.** "Quando é o casamento?" returns other people's weddings: nothing ties "o casamento" to the owner. An entity and owner signal is needed.
  3. **Portuguese inflection.** "Onde eu morava?" and "Em que bairro eu moro?" miss "Rafael mora…", and "eu comia carne" misses "não come carne": `unicode61` doesn't stem. "Como eu me desloco?" misses "metrô e aplicativo" altogether. Vectors cover both.
  4. **Dates left in the query.** In "Onde eu morava em março?", "março" is resolved into `asOf` but still searched as a word, and it matches unrelated notes.
  5. **Multi-hop needs a second step.** "A especialidade da mãe do meu afilhado" finds Theo, Rafael's godson, whose note names his mother, but not Patrícia's own note. Following the names and links a note holds is the entity and link-graph streams.
- **What #110 is measured against:** hit@5 0.700 and MRR 0.624 at 100k, multi-hop hit@5 0.450, and a packed context near 205 tokens. A change that lowers a category materially is a regression to fix, not a note to publish.

## How to re-run

```bash
bun run --filter @kelpie/memory eval
```

The metrics go to `packages/memory/eval/last-run.json`. The whole run takes about 30 seconds on the machine above; the 100k vault takes most of it. Changing the gold or the questions means a new hash, a new baseline in this file, and saying why.
