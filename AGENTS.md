# For coding agents working in this repository

Read this before changing anything. Every line below was verified against the
live API, `@brightdata/sdk` 1.2.0 or the Bright Data CLI 0.4.1 on 2026-11-03.
Where the API reference pages disagree with the live API, the live API is what
is written here.

## Auth

- `token()` reads `BRIGHTDATA_API_TOKEN`, then the key `bdata login` stored in
  `brightdata-cli/credentials.json` (the same file the SDKs read). There is no
  `.env` support; Node 20 loads one with `node --env-file=.env`.
  Setting the variable, or running the login once, is the one step a human
  must do; never paste a key into code.
- The raw HTTP Quickstart in the README reads `BRIGHTDATA_API_TOKEN` only. It
  does not see the CLI login.

## How the API behaves

- This package calls `https://api.brightdata.com/datasets/v3` with the
  built-in `fetch` and has no dependencies. Keep it that way. Tests stub the
  network through `transport`. The JavaScript SDK, `@brightdata/sdk` 1.2.0,
  wraps nine of the eleven Facebook scrapers in `client.scrape.facebook`, not
  page details or the Ad Library. The Python SDK's `comments()` sends
  `num_of_comments`, which the API rejects with a 400 validation error.
- Eleven datasets, all collect by URL; three also discover:
  - page posts `gd_lkaxegm826bjpoo9m5`, group posts `gd_lz11l67o2cb3r0lkj3`,
    post by URL `gd_lyclm1571iy3mv57zw`, reels `gd_lyclm3ey2q6rww027t`: limit
    with `num_of_posts`.
  - comments `gd_lkay758p1eanlolqw8`: limit with `limit_records`.
  - pages `gd_mf124a0511bauquyow`, profiles `gd_mf0urb782734ik94dz`.
  - company reviews `gd_m0dtqpiu1mbcyc2g86`: a `/reviews/` URL, limit with
    `num_of_reviews`.
  - Marketplace `gd_lvt9iwuh6fbcwmx1a`: discover by `keyword` (`keyword` and
    `city` required) or by `url` (a category URL).
  - events `gd_m14sd0to1jz48ppm51`: discover by `url` (an events search URL)
    or by `venue` (the venue page's `/events` URL; the bare page URL returns
    "There are no events.").
  - Meta Ad Library `gd_mtveskb62h7q65ftgz`: discover by `keyword`, with
    `country` and `ad_type` required. `ad_type` `"All ads"` is accepted;
    `"all"` is rejected.
  - `bdata pipelines info <dataset_id> <method>` prints the live input schema.
- Every call is an asynchronous job: `/trigger`, poll `/progress/<id>`, then
  `/snapshot/<id>?format=json`. Runs took 12 seconds (reviews, one ad) to 234
  seconds (a Marketplace category). `TIMEOUT_MS` is 900000.
- Always send `include_errors=true`. The API default drops error rows, and a
  failed input then looks like an empty result.
- `limit_per_input` caps a discovery, and the bill. When it is reached, the
  crawls still running come back as rows with the error "Crawl aborted on job
  cancel". `split()` does not count those as failures.
- Many brand pages have reviews turned off: Coca-Cola returned "Reviews not
  found", Starbucks and Shake Shack a dead page. `TheGarden/reviews/` works.
- Events search matching is loose: "tech conference" returned three events,
  none of them a conference.
- A status poll that fails with a network error (`fetch failed`) is retried
  until the deadline. An HTTP error still rejects.
- The schema changes without notice. Never hardcode a field list.
- The full documentation index, one `.md` page per entry:
  https://docs.brightdata.com/llms.txt

## Working here

- `npm test` runs offline and needs no token. `npm run lint` must pass.
- CI follows the README's own commands on an empty machine. A weekly workflow
  executes every fenced block in the README against the real API, and the same
  run also does a smaller live check. A snippet must be complete and paste-able on
  its own, and its shown output must be real.
- Group posts, comments and reviews name private people. README snippets print
  counts, dates and page names, not who wrote what.
- The field tables in the README sit between `<!-- fields:start -->` and
  `<!-- fields:end -->` and are regenerated weekly by
  `.github/scripts/field_tables.mjs` from `scrapers-full.json`. Do not edit
  them by hand.
- The "last verified" badge line at the top of the README is rewritten by the
  weekly run. Do not edit it by hand.
- Keep it small. Beyond the status poll, do not add retries, deduplication,
  scheduling, databases, async examples or concurrency.
