/**
 * Facebook pages, posts, comments, Marketplace, events and ads on the Bright Data Scraper API, with fetch.
 *
 *     page URL -> trigger -> poll progress -> fetch snapshot -> records
 *
 * No dependencies. The JavaScript SDK, `@brightdata/sdk` 1.2.0, wraps nine of
 * these eleven scrapers, not page details or the Ad Library, so this module
 * talks to the API over HTTP and covers all eleven. Every call
 * is an asynchronous job: trigger it, poll until the snapshot is ready,
 * download it. On 2026-11-03 a run took 12 seconds (reviews, one ad) to 234
 * seconds (a Marketplace category).
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const API = "https://api.brightdata.com/datasets/v3";

// Every Facebook scraper, by what it returns. All take a `url` input unless noted.
/** Posts from a page URL. */
export const PAGE_POSTS = "gd_lkaxegm826bjpoo9m5";
/** Posts from a public group URL. */
export const GROUP_POSTS = "gd_lz11l67o2cb3r0lkj3";
/** One post per post URL. */
export const POSTS = "gd_lyclm1571iy3mv57zw";
/** Comments on a post URL. */
export const COMMENTS = "gd_lkay758p1eanlolqw8";
/** Reels from a page URL. */
export const REELS = "gd_lyclm3ey2q6rww027t";
/** Page details: followers, category, contact info. */
export const PAGES = "gd_mf124a0511bauquyow";
/** Public profile details of a person. */
export const PROFILES = "gd_mf0urb782734ik94dz";
/** Reviews from a page's /reviews/ URL. */
export const REVIEWS = "gd_m0dtqpiu1mbcyc2g86";
/** Event URL, or discover by search URL or venue. */
export const EVENTS = "gd_m14sd0to1jz48ppm51";
/** Listing URL, or discover by keyword or category URL. */
export const MARKETPLACE = "gd_lvt9iwuh6fbcwmx1a";
/** Meta Ad Library ad URL, or discover by keyword. */
export const AD_LIBRARY = "gd_mtveskb62h7q65ftgz";

/** The slowest run on 2026-11-03 was 234 seconds; the wait outlasts that comfortably. */
export const TIMEOUT_MS = 900_000;

export const NO_TOKEN = [
  "API token required but not found.",
  "  export BRIGHTDATA_API_TOKEN=YOUR_API_KEY   token: https://brightdata.com/cp/setting/users",
  "  or run once: npx -p @brightdata/cli bdata login",
].join("\n");

/** The API refused a request, or a job ended without a snapshot. */
export class ApiError extends Error {
  name = "ApiError";
}

/** No token in the environment and no Bright Data CLI login. */
export class TokenMissing extends ApiError {
  name = "TokenMissing";
  constructor() {
    super(NO_TOKEN);
  }
}

/**
 * The network and the clock, behind one indirection.
 *
 * ES module exports are read-only bindings, so a test cannot replace an
 * imported function. Going through this object lets the offline tests stand
 * in for the API and skip the waits.
 */
export const transport = {
  fetch: (...args) => globalThis.fetch(...args),
  pollMs: 10_000,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  credentialsPath: () => {
    if (process.platform === "win32") {
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "brightdata-cli", "credentials.json");
    }
    const base = process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".config");
    return join(base, "brightdata-cli", "credentials.json");
  },
};

/** BRIGHTDATA_API_TOKEN, else the Bright Data CLI login. Never a key in code. */
export function token() {
  const found = (process.env.BRIGHTDATA_API_TOKEN ?? "").trim();
  if (found) return found;
  try {
    const key = JSON.parse(readFileSync(transport.credentialsPath(), "utf8")).api_key;
    if (key) return key;
  } catch {
    // no login file, or not JSON: same as no login
  }
  throw new TokenMissing();
}

async function call(path, body) {
  const response = await transport.fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new ApiError(`HTTP ${response.status}: ${text.trim().slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Start a job and return its snapshot id. Error rows are always asked for. */
export async function trigger(datasetId, inputs, { discoverBy, limitPerInput } = {}) {
  const query = new URLSearchParams({ dataset_id: datasetId, include_errors: "true" });
  if (discoverBy) {
    query.set("type", "discover_new");
    query.set("discover_by", discoverBy);
  }
  if (limitPerInput !== undefined) query.set("limit_per_input", String(limitPerInput));
  return (await call(`/trigger?${query}`, inputs)).snapshot_id;
}

/** running, ready or failed. */
export async function status(snapshotId) {
  return (await call(`/progress/${snapshotId}`)).status;
}

/** The rows of a ready snapshot. Snapshots stay downloadable for 30 days. */
export async function fetchSnapshot(snapshotId) {
  const data = await call(`/snapshot/${snapshotId}?format=json`);
  return (Array.isArray(data) ? data : [data]).filter((row) => row && typeof row === "object");
}

/**
 * status(), except that a dropped connection is not the end of a paid job.
 *
 * A poll is safe to repeat, and one "fetch failed" five minutes into a job
 * lost it on 2026-10-24. An HTTP error still rejects.
 */
async function poll(snapshotId) {
  try {
    return await status(snapshotId);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return "running";
  }
}

/** Trigger, wait, fetch. Rows the API could not collect carry an `error` key. */
export async function run(datasetId, inputs, { discoverBy, limitPerInput, timeoutMs = TIMEOUT_MS } = {}) {
  const snapshotId = await trigger(datasetId, inputs, { discoverBy, limitPerInput });
  const deadline = Date.now() + timeoutMs;
  let state;
  while (!["ready", "failed"].includes((state = await poll(snapshotId)))) {
    if (Date.now() > deadline) {
      throw new ApiError(`timeout: snapshot ${snapshotId} not ready after ${Math.round(timeoutMs / 1000)}s`);
    }
    await transport.sleep(transport.pollMs);
  }
  if (state === "failed") throw new ApiError(`snapshot ${snapshotId} failed`);
  return fetchSnapshot(snapshotId);
}

const many = (value) => (Array.isArray(value) ? value : [value]);

/** Only the fields that were actually set. */
function given(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
}

/** One input per URL, with every field that was actually set. */
function items(urls, fields = {}) {
  const extra = given(fields);
  return many(urls).map((url) => ({ url, ...extra }));
}

/**
 * Recent posts from Facebook page URLs, `limit` per page.
 *
 * Other options go into each input as the API names them, for example
 * `start_date`, `end_date` or `posts_to_not_include`.
 */
export function pagePosts(urls, { limit = 5, ...options } = {}) {
  return run(PAGE_POSTS, items(urls, { num_of_posts: limit, ...options }));
}

/** Recent posts from public Facebook group URLs, `limit` per group. */
export function groupPosts(urls, { limit = 5, ...options } = {}) {
  return run(GROUP_POSTS, items(urls, { num_of_posts: limit, ...options }));
}

/** Full records for Facebook post URLs, one job for the whole list. */
export function posts(urls) {
  return run(POSTS, items(urls));
}

/**
 * Comments on Facebook post URLs. Billed per comment, so set `limit`.
 *
 * The limit is the `limit_records` input. `num_of_comments`, which the Python
 * SDK sends, is rejected by the API as a validation error.
 */
export function comments(urls, { limit = 10, ...options } = {}) {
  return run(COMMENTS, items(urls, { limit_records: limit, ...options }));
}

/** Recent reels from Facebook page URLs, `limit` per page. */
export function reels(urls, { limit = 5, ...options } = {}) {
  return run(REELS, items(urls, { num_of_posts: limit, ...options }));
}

/** Page details for Facebook page URLs: followers, category, contact info. */
export function pages(urls) {
  return run(PAGES, items(urls));
}

/** Public profile details for Facebook profile URLs of people. */
export function profiles(urls) {
  return run(PROFILES, items(urls));
}

/**
 * Reviews from a page's reviews URL, such as https://www.facebook.com/TheGarden/reviews/.
 *
 * Many brand pages have reviews turned off and return an error row, "Reviews
 * not found" or a dead page, instead of zero rows.
 */
export function reviews(urls, { limit = 10, ...options } = {}) {
  return run(REVIEWS, items(urls, { num_of_reviews: limit, ...options }));
}

/** Full records for Facebook event URLs. */
export function events(urls) {
  return run(EVENTS, items(urls));
}

/** Events from an events search URL, such as .../events/search/?q=marathon. */
export function eventsSearch(searchUrls, { limit = 5 } = {}) {
  return run(EVENTS, items(searchUrls), { discoverBy: "url", limitPerInput: limit });
}

/** Events at a venue. Pass the page's /events URL; the bare page URL finds none. */
export function eventsByVenue(venueUrls, { limit = 5, upcomingOnly = true } = {}) {
  const inputs = items(venueUrls, { upcoming_events_only: upcomingOnly });
  return run(EVENTS, inputs, { discoverBy: "venue", limitPerInput: limit });
}

/** Full records for Facebook Marketplace item URLs. */
export function marketplace(urls) {
  return run(MARKETPLACE, items(urls));
}

/** Marketplace listings for a keyword in a city. `radius` and `date_listed` go in the options. */
export function marketplaceSearch(keyword, city, { limit = 5, ...options } = {}) {
  const item = { keyword, city, ...given(options) };
  return run(MARKETPLACE, [item], { discoverBy: "keyword", limitPerInput: limit });
}

/** Listings from a Marketplace category URL, such as .../marketplace/category/vehicles. */
export function marketplaceCategory(urls, { limit = 5 } = {}) {
  return run(MARKETPLACE, items(urls), { discoverBy: "url", limitPerInput: limit });
}

/** Full records for Meta Ad Library ad URLs, .../ads/library/?id=... */
export function ads(urls) {
  return run(AD_LIBRARY, items(urls));
}

/**
 * Ads in the Meta Ad Library matching a keyword in one country.
 *
 * `ad_type` is validated against a fixed list: "All ads" is accepted, "all" is not.
 */
export function adsSearch(keyword, { country = "US", limit = 5, ad_type = "All ads" } = {}) {
  const item = { keyword, country: country.toUpperCase(), ad_type };
  return run(AD_LIBRARY, [item], { discoverBy: "keyword", limitPerInput: limit });
}

/**
 * When a discovery reaches `limitPerInput`, the crawls still running are
 * cancelled and each comes back as a row with this error. That is the limit
 * working, not a failure.
 */
export const CANCELLED = "Crawl aborted on job cancel";

/** Records, and the error messages of the rows that are not records. */
export function split(rows) {
  return {
    records: rows.filter((row) => !row.error),
    errors: rows.filter((row) => row.error && row.error !== CANCELLED).map((row) => String(row.error)),
  };
}

/**
 * value parsed as a URL, when its host is domain or a subdomain of it.
 * A substring test would let https://evil.com/facebook.com/x through; the host is
 * what decides which site a URL names.
 */
function urlOn(value, domain) {
  let url;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`) ? url : null;
}

/** value without leading and trailing ch, without a backtracking regex. */
function trimChar(value, ch, { start = true, end = true } = {}) {
  let from = 0;
  let to = value.length;
  while (start && from < to && value[from] === ch) from += 1;
  while (end && to > from && value[to - 1] === ch) to -= 1;
  return value.slice(from, to);
}

/** new URL() percent-encodes the path; keep a page name as it was typed. */
function safeDecode(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Accept Meta, @Meta, facebook.com/Meta or a full URL. Reject anything else. */
export function pageUrl(page) {
  const cleaned = String(page ?? "").trim();
  if (trimChar(cleaned, "/").includes("/")) {
    const url = urlOn(cleaned, "facebook.com");
    const path = url ? trimChar(safeDecode(url.pathname), "/") : "";
    if (!path) throw new Error(`${JSON.stringify(page)} is not a Facebook page`);
    return `https://www.facebook.com/${path}${url.search}`;
  }
  const name = trimChar(trimChar(cleaned, "@", { end: false }), "/");
  if (!/^[\p{L}\p{N}._-]+$/u.test(name)) throw new Error(`${JSON.stringify(page)} is not a Facebook page name`);
  return `https://www.facebook.com/${name}`;
}

/** What happened to one page. */
export class Outcome {
  constructor({ page, posts = [], error = null, note = "" }) {
    this.page = page;
    this.posts = posts;
    this.error = error;
    this.note = note;
  }

  get ok() {
    return this.error === null;
  }

  /** One line a reader can understand without having read the source. */
  line() {
    if (!this.ok) return `failed  ${this.page}: ${this.error}`;
    const tail = this.note ? `, ${this.note}` : "";
    return `got     ${this.page}: ${this.posts.length} posts${tail}`;
  }
}

/**
 * Fetch one page's recent posts. Never rejects for a bad page: a failure
 * becomes an Outcome. A missing token is the exception, because it fails
 * every page the same way.
 */
export async function scrapePage(page, { limit = 5 } = {}) {
  let url;
  try {
    url = pageUrl(page);
  } catch (error) {
    return new Outcome({ page: String(page), error: error.message });
  }
  const outcome = new Outcome({ page: url.slice(url.lastIndexOf("facebook.com/") + "facebook.com/".length) });
  let rows;
  try {
    rows = await pagePosts(url, { limit });
  } catch (error) {
    if (error instanceof TokenMissing) throw error;
    // one bad page must not end the run
    outcome.error = error instanceof ApiError ? error.message : `${error?.name ?? "Error"}: ${error?.message ?? error}`;
    return outcome;
  }
  const { records, errors } = split(rows);
  if (records.length) {
    // Keep what was paid for. A partial run reports the rest as a note.
    outcome.posts = records;
    if (errors.length) outcome.note = `${errors.length} error rows: ${errors[0]}`;
  } else if (errors.length) {
    outcome.error = [...new Set(errors)].join("; ");
  }
  return outcome;
}

/** Run every page and return one Outcome each, in order. */
export async function scrape(pageNames, { limit = 5 } = {}) {
  const outcomes = [];
  for (const page of pageNames) outcomes.push(await scrapePage(page, { limit }));
  return outcomes;
}

/** Write one JSON file: when it ran, and the posts found per page. */
export async function write(outcomes, path) {
  const document = {
    generated_at: new Date().toISOString(),
    pages: outcomes.map((o) => ({ page: o.page, posts: o.posts })),
  };
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return target;
}
