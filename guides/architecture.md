# LaunchSignal architecture and trust boundary

## Product

LaunchSignal gives indie founders a narrow, explainable check of a public launch page: can a visitor identify the offer, audience, next action, and match between page and founder-provided offer sentence? The MVP is a free founder tool. A later commercial direction could add saved workspaces and exportable review history, but no payment or subscription logic belongs in this prototype.

## Responsibility boundary

- **Browser app:** input validation, network selection, wallet connection, fee estimate, transaction status, read-only lookups, and sharing a review link. It never holds a private key.
- **Intelligent Contract:** validates URL syntax and input length, fetches a bounded public page excerpt, independently evaluates a fixed rubric in the leader and validators, derives a status from agreed flags, and stores a public review record.
- **External page:** supplies the evidence. It is untrusted, can change, can contain instructions aimed at a model, and is not guaranteed to be safe or complete.
- **Human founder:** decides whether to edit or publish copy. The result does not predict demand or certify legal, investment, safety, or product claims.

## State transition

Founder submits a public URL and public offer sentence → contract checks bounds and a conservative HTTPS host syntax policy → leader and validators separately fetch up to 7,000 characters and apply the same JSON rubric → consensus requires matching sufficiency plus all four boolean flags → GenLayer derives `READY`, `NEEDS_WORK`, or `UNCLEAR` → on-chain record stores the URL, offer sentence, flags, leader note, and consensus rule.

The contract intentionally does not store fetched HTML. A page can change after the review, so the record is a historical consensus result for the evidence available during the transaction and is not a permanent snapshot proof.

## Consensus choice

The site and model output are nondeterministic. `strict_eq` would be too brittle. `run_nondet_unsafe` runs the same fetch-and-review process independently for validators. Agreement compares `evidence_sufficient`, `offer_visible`, `audience_clear`, `cta_clear`, and `offer_matches`; free-form rationale is outside the decision boundary. Different underlying evidence can still yield the same rubric, so the page and timestamp context should be checked before relying on a result.

## Main risks

- Page text may be prompt-injected, manipulated, or rendered differently across fetches.
- Domain syntax checks cannot establish DNS resolution, redirect safety, or page ownership.
- The model can miss or misread content; consensus means rubric agreement, not truth.
- Contract storage is public and durable. Do not submit confidential copy or personal data.
- This prototype has no appeal or versioned snapshot mechanism; rebuild the contract for rubric changes.
