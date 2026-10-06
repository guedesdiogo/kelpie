# Spike: how well memory answers as the vault grows

- **Date:** 2026-10-06
- **Issue:** [#108](https://github.com/guedesdiogo/kelpie/issues/108); retrieval measured for [#110](https://github.com/guedesdiogo/kelpie/issues/110).
- **Status:** baseline and first retrieval recorded.
  - Plain full-text search answers 70% of the questions within five results at 100k memories.
  - Most of the drop with size comes from people named by a first name that other notes share.
  - Retrieval without vectors or a rerank raises that to 77%, about as much on the half of the questions its variants weren't compared on ([Retrieval (#110)](#retrieval-110)).
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
  - At 100k, several hundred distractors share each gold first name. None shares a gold person's full name or starts with a gold place's name, which a test checks.
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
- **Frozen first.** The labels were committed in [`20e3f27`](https://github.com/guedesdiogo/kelpie/commit/20e3f27), before the generator, the runner or any retrieval run existed. That commit's message says 47 memories; there are 46.
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
- **Tokens:** of the packed context, at four characters per token, the heuristic [ai-memory's harness](https://github.com/akitaonrails/ai-memory/blob/fc4da03/evals/README.md) uses.
- **Search latency:** one search, measured inside the Durable Object.
  - workerd's clock ticks in whole milliseconds, so the mean over the 150 questions says more than p50 or p95.
  - The runs were on an Apple M4 with 16 GB, in local workerd `1.20261001.1`, not on Cloudflare.
- **Slices:** by category, and by whether the question names someone by a first name only ("Onde a Fernanda mora?"), since distractors reuse those first names.

## Results

Database sizes are in MiB; timings vary by about 10% between runs, and everything else doesn't.

| Size | Versions | Index build | Database | hit@1 | hit@3 | hit@5 | hit@10 | MRR | Stale first | Tokens, mean / p95 | Search ms, mean / p95 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | 1,103 | 0.1 s | 1.6 | 0.600 | 0.733 | 0.773 | 0.807 | 0.674 | 1 of 11 | 203 / 262 | 0.26 / 1 |
| 10,000 | 11,030 | 1.3 s | 14.6 | 0.593 | 0.680 | 0.707 | 0.740 | 0.645 | 0 of 11 | 206 / 266 | 2.4 / 5 |
| 100,000 | 109,964 | 21.4 s | 146.2 | 0.580 | 0.687 | 0.700 | 0.713 | 0.634 | 0 of 11 | 207 / 260 | 22.9 / 48 |

By slice, hit@5 and MRR:

| Slice | n | hit@5 1k | hit@5 10k | hit@5 100k | MRR 1k | MRR 10k | MRR 100k |
|---|---|---|---|---|---|---|---|
| overall | 150 | 0.773 | 0.707 | 0.700 | 0.674 | 0.645 | 0.634 |
| entity | 35 | 0.829 | 0.714 | 0.657 | 0.698 | 0.627 | 0.579 |
| preference | 25 | 0.800 | 0.760 | 0.760 | 0.700 | 0.740 | 0.740 |
| commitment | 19 | 0.789 | 0.737 | 0.737 | 0.763 | 0.716 | 0.711 |
| update | 25 | 0.800 | 0.800 | 0.800 | 0.800 | 0.800 | 0.800 |
| as-of | 15 | 0.733 | 0.600 | 0.600 | 0.615 | 0.550 | 0.567 |
| multi-hop | 20 | 0.500 | 0.400 | 0.450 | 0.221 | 0.197 | 0.193 |
| procedure | 11 | 1.000 | 1.000 | 1.000 | 1.000 | 0.955 | 0.955 |
| names a shared first name | 34 | 0.735 | 0.529 | 0.500 | 0.594 | 0.474 | 0.441 |
| names nobody by first name | 116 | 0.784 | 0.759 | 0.759 | 0.697 | 0.695 | 0.691 |

Per-question ranks for every size are in [`memory-eval-baseline.json`](memory-eval-baseline.json).

## Reading the numbers

- **The packed context stays near 205 tokens at every size,** by construction: the stand-in packing takes five results of at most 400 characters. It shows the budget holds as memory grows, not that retrieval got cheaper.
  - Search time grows with the vault: about 0.26 ms at 1k, 2.4 ms at 10k and 23 ms at 100k. At 100k it is still small next to a model call.
  - The index takes about 1.4 KB per version on disk: 146 MiB at 100k, well inside a Durable Object's 10 GB.
- **The drop with size is about names.**
  - Questions that name someone by a first name fall from 0.735 to 0.500 hit@5 between 1k and 100k. With several hundred Anas in the vault, "O que a Ana faz da vida?" finds the wrong one: every distractor Ana's note states the same kind of fact.
  - The other 116 questions hold: 0.784 at 1k, 0.759 at 10k and 100k.
  - "Ana" alone doesn't say which Ana. Knowing who the owner's people are does, which is #110's entity stream and #112's model of the owner.
- **Changed facts are handled by supersession.** "Update" questions hold at 0.800 at every size, and outdated memories rarely come first: 1 of 11 at 1k, none above. Search returns current versions only, so a superseded version can't mislead; the remaining traps are other notes that repeat an old fact.
- **Five kinds of miss**, seen in the results of the questions answered at no size:
  1. **Common words win.** "Como eu gosto do meu café?" returns cafés named *Bom Gosto*, and "O que a Ana faz da vida?" returns *Laboratório Vida*. ai-memory gained 5.1 points of hit@5 by dropping stopwords from such queries ([benchmarks](https://github.com/akitaonrails/ai-memory/blob/fc4da03/docs/benchmarks/README.md)).
  2. **Topics the owner shares with others.** "Quando é o casamento?" returns other people's weddings: nothing ties "o casamento" to the owner. An entity and owner signal is needed.
  3. **Portuguese inflection.** "Onde eu morava?" and "Em que bairro eu moro?" miss "Rafael mora…", and "eu comia carne" misses "não come carne": `unicode61` doesn't stem. "Como eu me desloco?" misses "metrô e aplicativo" altogether. Vectors cover both.
  4. **Dates left in the query.** In "Onde eu morava em março?", "março" is resolved into `asOf` but still searched as a word, and it matches unrelated notes.
  5. **Multi-hop needs a second step.** "A especialidade da mãe do meu afilhado" finds Theo, Rafael's godson, whose note names his mother, but not Patrícia's own note. Following the names and links a note holds is the entity and link-graph streams.
- **What #110 is measured against:** hit@5 0.700 and MRR 0.634 at 100k, 0.500 for questions that name someone by a first name, multi-hop hit@5 0.450, and a packed context near 205 tokens. A change that lowers a slice materially is a regression to fix, not a note to publish.

### Known gaps in the labels

A review after the run found memories that answer a question without being labelled for it. The labels stay frozen, because changing them after seeing results is what freezing prevents. These count as misses, so the scores are slightly low: +1 question at hit@5 at 1k, none at 10k or 100k.
- **q078:** `sessao-planejamento-ferias` states the same holiday dates as the labelled `ferias`.
- **q108 and q109:** `sessao-sindico` names the old apartment and its síndico.
- **q119:** arguably `sessao-ana-aniversario`.
- **q106, q114 and q120:** sessions state the same fact, with no change in rank measured.
- **q073:** it leaves out `casamento`, which q075 labels.
- **Multi-hop by judgment:** `mae-remedio` alone answers q135, and `passaporte` alone answers q125.

A revision of the labels would fix these with a new hash and a new baseline. It would also give the first-name questions a word that singles the person out ("minha namorada Júlia").

## Retrieval (#110)

Retrieval ([`retrieve.ts`](../../packages/memory/src/retrieve.ts), described in [memory-format.md](../memory-format.md#retrieval)) runs on the same vaults, questions and options as the baseline. It returns 10 results, and packs them within 1,000 tokens.

### How it was tuned, and what the odd half means

- **The starting point** was ai-memory's hybrid search with its constants: RRF with k = 60, its authority weights, a stopword list, and a graph from the best hits.
- **What was seen before any split:**
  - The first run, with ai-memory's constants, reported every slice for all 150 questions.
  - A diagnostic listed the entity questions it lost at 1k, from both halves; the Bruno example below comes from it.
  - A later full run showed the drops in update and entity questions that led to ranking seeds first.
  - Those runs set the direction of the changes.
- **Then each variant was compared on the even-numbered questions only.**
  - The odd half never chose between variants, but it isn't a clean hold-out: it had shaped which variants were tried. Both halves are reported apart.
  - The labels, the gold and the questions didn't change.
- **Four choices** came out of the comparisons:
  - **Authority:** ai-memory's boosts for decisions and procedures cost answers here, so only its session penalty stays. On the even half at 10k, without the graph and with function words removed, MRR went from 0.557 to 0.610.
  - **Function words:** removing them made the full-text stream slightly worse (MRR 0.632 → 0.610), since bm25 already weighs them down. They stay.
  - **The graph:** it follows only a note's links and the pages of the entities it names, from three seeds per stream. It ranks the seeds above their neighbours, with the same weight as the other streams.
    - Neighbours that also matched the text weakly used to pass their seed: "Pra que time o Bruno torce?" put Patrícia and Theo above Bruno.
    - Notes that merely name a note (backlinks and mentions) made it noisier, because everyone in a family names everyone.
  - **Entity pages first:** an entity's own page, the note titled with its name, comes before the notes that mention it. This rule was set before any run, to break a tie in a unit test.

### Results

The retrieval column is after the arrow. Everything is deterministic, and is in [`memory-eval-retrieval.json`](memory-eval-retrieval.json), per question.

| Slice | n | hit@5 1k | hit@5 10k | hit@5 100k | MRR 1k | MRR 10k | MRR 100k |
|---|---|---|---|---|---|---|---|
| overall | 150 | 0.773 → 0.827 | 0.707 → 0.773 | 0.700 → 0.767 | 0.674 → 0.694 | 0.645 → 0.666 | 0.634 → 0.660 |
| entity | 35 | 0.829 → 0.886 | 0.714 → 0.800 | 0.657 → 0.771 | 0.698 → 0.701 | 0.627 → 0.646 | 0.579 → 0.605 |
| preference | 25 | 0.800 → 0.880 | 0.760 → 0.840 | 0.760 → 0.840 | 0.700 → 0.786 | 0.740 → 0.793 | 0.740 → 0.813 |
| commitment | 19 | 0.789 → 0.737 | 0.737 → 0.737 | 0.737 → 0.737 | 0.763 → 0.746 | 0.716 → 0.737 | 0.711 → 0.737 |
| update | 25 | 0.800 → 0.800 | 0.800 → 0.800 | 0.800 → 0.800 | 0.800 → 0.786 | 0.800 → 0.780 | 0.800 → 0.780 |
| as-of | 15 | 0.733 → 0.800 | 0.600 → 0.600 | 0.600 → 0.600 | 0.615 → 0.636 | 0.550 → 0.567 | 0.567 → 0.567 |
| multi-hop | 20 | 0.500 → 0.700 | 0.400 → 0.650 | 0.450 → 0.650 | 0.221 → 0.278 | 0.197 → 0.249 | 0.193 → 0.251 |
| procedure | 11 | 1.000 → 1.000 | 1.000 → 1.000 | 1.000 → 1.000 | 1.000 → 1.000 | 0.955 → 0.955 | 0.955 → 0.955 |
| names a shared first name | 34 | 0.735 → 0.794 | 0.529 → 0.647 | 0.500 → 0.588 | 0.594 → 0.623 | 0.474 → 0.509 | 0.441 → 0.478 |
| names nobody by first name | 116 | 0.784 → 0.836 | 0.759 → 0.810 | 0.759 → 0.819 | 0.697 → 0.715 | 0.695 → 0.713 | 0.691 → 0.714 |
| even half | 75 | 0.760 → 0.867 | 0.667 → 0.733 | 0.667 → 0.733 | 0.669 → 0.702 | 0.617 → 0.633 | 0.605 → 0.629 |
| odd half | 75 | 0.787 → 0.787 | 0.747 → 0.813 | 0.733 → 0.800 | 0.679 → 0.685 | 0.673 → 0.699 | 0.663 → 0.691 |

| Size | hit@1 | hit@3 | hit@10 | Packed tokens, mean / p95 | Stale first |
|---|---|---|---|---|---|
| 1,000 | 0.600 → 0.600 | 0.733 → 0.767 | 0.807 → 0.860 | 540 / 651 | 1 → 0 of 11 |
| 10,000 | 0.593 → 0.600 | 0.680 → 0.707 | 0.740 → 0.787 | 534 / 666 | 0 → 0 of 11 |
| 100,000 | 0.580 → 0.593 | 0.687 → 0.713 | 0.713 → 0.773 | 542 / 668 | 0 → 0 of 11 |

### Reading the numbers

- **The odd half gains as much as the even half.** At 100k its hit@5 goes from 0.733 to 0.800 and its MRR from 0.663 to 0.691. It is only partly unseen, so this is weaker evidence than a clean hold-out: a new label set would test it properly.
- **Multi-hop gains most:** hit@5 goes from 0.45 to 0.65 at 100k. The second memory comes in through the graph, from the first one's entities.
- **First names gain, but stay the weakest slice:** 0.500 → 0.588 at 100k. Telling the owner's Ana from the others still needs an owner signal (#112).
- **Names on many notes are left out of the entity stream.** A city that hundreds of distractors name only listed them in path order. Names on more than 50 versions are now left out. Together with the other fixes from review, entity MRR at 100k went from 0.591 to 0.605. These were fixes, not choices made on the tuning half.
- **What got worse:**
  - **At 100k:** 14 questions rank better, 135 the same, and 1 worse. That one, q101 (update), drops from 1st to 2nd, so update hit@1 goes from 0.800 to 0.760 and its MRR from 0.800 to 0.780. No other slice falls at 100k.
  - **At 1k and 10k:** five and four questions drop. The worst is q074 (commitment): from 1st to 6th at 1k, and from 9th to out of the top 10 at 10k.
- **The budget holds** for every question at every size, and the evaluation asserts it. The largest packed slice takes 781 of the 1,000 tokens allowed, and the mean is about 540, since a note no longer repeats its title as a heading. The baseline's five excerpts took about 205.
- **Cost:** retrieval takes about the same time as the plain search, 23 ms on average at 100k, because the full-text stream dominates. Timings come from the run, in `eval/last-run.json`, which isn't committed. The folded-title column adds about 6% to the database: 154 MiB at 100k.
- **The comparison runs were scratch experiments**, on the even half only. Their numbers are quoted above, and their code isn't kept.
- **A name on many notes in a real vault** is likely the owner's family, the reverse of the evaluation, where only distractors are common. Leaving such names out of the entity stream then costs their pages that stream, though full-text search still finds them. A later fix could keep a common name's own page, through its title.
- **Not measured yet:** vectors and the rerank. Both need a model, and the eval has none yet. "hit@k before and after the rerank" waits for that.

### With models

`bun run --filter @kelpie/memory eval:models` answers the same questions with real models, at 1k and 10k memories ([`models.eval.ts`](../../packages/memory/eval/models.eval.ts)). The results are in [`memory-eval-models.json`](memory-eval-models.json). Model answers can vary from run to run, so that file is a record of one run, not a regression check.

- **Vectors:** every current note is embedded, as are the questions.
  - `bge-m3` on Workers AI took 61 s for the 10k vault.
  - OpenAI's `text-embedding-3-small` took 91 s.
  - Vectors are one more stream of equal weight in the fusion, skipped for "as of" questions.
- **The rerank** follows ai-memory's contract:
  - retrieval fetches the 30 best hits;
  - Clef judges them in one call, from each note's title, abstract and body start, 600 characters at most;
  - the 10 best are kept, so notes can rise from below the limit;
  - the notes are marked as data, not instructions.
  - Clef masks long numbers before judging, dates included, so it can't see when a note was written.
- **No constant was tuned on these runs.** Both embedders run with the same constants, and the rerank takes ai-memory's.

At 10k memories, against retrieval without vectors:

| Configuration | hit@1 | hit@5 | MRR | Names a shared first name, hit@5 | Multi-hop, hit@5 | As of, hit@5 | Odd half, MRR | Stale first |
|---|---|---|---|---|---|---|---|---|
| Retrieval | 0.600 | 0.773 | 0.666 | 0.647 | 0.650 | 0.600 | 0.699 | 0 of 11 |
| + bge-m3 | 0.627 | 0.793 | 0.700 | 0.500 | 0.600 | 0.600 | 0.736 | 0 of 11 |
| + bge-m3 + rerank | 0.720 | 0.893 | 0.798 | 0.912 | 0.850 | 0.733 | 0.811 | 2 of 11 |
| + OpenAI | 0.613 | 0.807 | 0.694 | 0.559 | 0.650 | 0.600 | 0.724 | 0 of 11 |
| + OpenAI + rerank | 0.740 | 0.880 | 0.803 | 0.794 | 0.800 | 0.733 | 0.807 | 2 of 11 |
| Retrieval + rerank | 0.680 | 0.813 | 0.743 | 0.765 | 0.750 | 0.733 | 0.749 | 2 of 11 |

At 1k, `bge-m3` with the rerank reaches hit@5 0.940 and MRR 0.849, against 0.827 and 0.694.

- **The rerank gains most,** because it can bring notes up from below the first 10. With `bge-m3`, hit@5 goes from 0.793 to 0.893, and first names from 0.500 to 0.912.
- **The two embedders are about even.** `bge-m3` is ahead after the rerank on hit@5 and on first names; OpenAI is slightly ahead on hit@1 and MRR. `bge-m3` needs no key and embeds faster.
- **Vectors alone hurt first names,** 0.647 → 0.500: they bring in the other Anas by meaning. The rerank more than makes up for it.
- **The rerank brings outdated memories first** in 2 of the 11 questions that label outdated memories, against none without it. Clef judges relevance, not which note is current, and it can't see dates. The update slice's MRR still rises, from 0.780 to 0.823 with `bge-m3`.
- **The rerank's cost:** with 30 notes, a call took 1.4 s at p50 and 2.2 to 2.5 s at p95 at 10k.
  - 3 to 6 of 150 calls per configuration failed or left notes unscored, and kept the fused order.
  - A 2 s cap would also cut the slowest 5 to 10%.
- **The gate:** Clef was asked whether each message needs the owner's notes, at a threshold of 0.5.
  - It stopped all 20 bare acknowledgements, but also 16 of the 150 questions (11%), which would then get no memory.
  - The regex in `needsMemory` alone stopped all 20 acknowledgements and none of the 150 questions.
  - A Clef call took 0.50 s at p50 and 1.13 s at p95.
  - The owner chose the regex alone, to save the qualifier's cost ([#110](https://github.com/guedesdiogo/kelpie/issues/110#issuecomment-6017364370)).
- **Not run:** 100k memories, which would take tens of minutes to embed per model.

## Expiry in recall (#111)

A turn's recall leaves out notes whose `invalid_at` has passed. The evaluation runs retrieval again with that filter, at a fixed now of 2026-10-06 noon UTC: inside the vault's year, after some deadlines and before others. The numbers are in `memory-eval-retrieval.json`, under each run's `expiry`.

| Vault | hit@1 | hit@5 | hit@10 | MRR | stale first (n = 11) |
|---|---|---|---|---|---|
| 1k | 0.600 → 0.613 | 0.827 → 0.827 | 0.860 → 0.867 | 0.694 → 0.705 | 0 → 0 |
| 10k | 0.600 → 0.600 | 0.773 → 0.780 | 0.787 → 0.787 | 0.666 → 0.669 | 0 → 0 |
| 100k | 0.593 → 0.593 | 0.767 → 0.767 | 0.773 → 0.773 | 0.660 → 0.661 | 0 → 0 |

What the numbers show:
- **No question loses its answer.** Questions with a date bypass the filter, and so do questions about the past; the rest only move up, as expired distractors (past deadlines) drop out. At 1k, six questions move up, and one answered outside the top 10 comes in at 7.
- **Stale first is already 0,** since outdated versions are superseded, not current. The filter acts on expired facts, which the labels don't mark as stale.
- **Retrieval without the filter is unchanged** from #110's numbers.

## Contradiction band (#111)

The lifecycle report (#111) flags notes about one entity whose vectors are close but not the same. The band was measured with `eval:models` on the 1k vault (2026-10-06):
- **Pairs that disagree:** 16. Each question's answer against the memories labelled as outdated for it, and each gold fact's consecutive versions.
- **Pairs that don't:** 54. Every other pair of gold notes sharing an entity.

| Model | Disagreeing pairs | Other pairs (p10 / p50 / p90) | [0.70, 0.95) catches | and flags |
|---|---|---|---|---|
| `@cf/baai/bge-m3` | 0.39 to 0.95 | 0.39 / 0.51 / 0.69 | 56% | 6% |
| `text-embedding-3-small` | 0.41 to 0.97 | 0.38 / 0.51 / 0.70 | 63% | 13% |

What the numbers show:
- **Updates sit high,** unlike ai-memory's [0.4, 0.75) band: a fact's new version reads close to its old one.
- **Wider bands cost a lot:** [0.55, 0.95) catches 81% with bge-m3 but flags 43% of the other pairs.
- **Small sample:** the pairs are few and synthetic, so the band is a starting value. The findings only go into the report, for Dream to look at.

## How to re-run

```bash
bun run --filter @kelpie/memory eval
```

```bash
bun run --filter @kelpie/memory eval:baseline
git diff docs/spikes/memory-eval-baseline.json
```

- **What runs:** the evaluation takes about half a minute on the machine above, most of it on the 100k vault. Its metrics, timings included, go to `packages/memory/eval/last-run.json`.
- **The baseline:** `eval:baseline` rewrites [`memory-eval-baseline.json`](memory-eval-baseline.json) and [`memory-eval-retrieval.json`](memory-eval-retrieval.json) from that run, with everything but the timings, so `git diff` shows exactly what a change moved. The baseline file also records:
  - the labels' hash and the seed;
  - the result limit and the packed count;
  - the times "as of" and "valid at" stand for.
- **Changing the gold or the questions** means a new hash, a new baseline in this file, and saying why.
