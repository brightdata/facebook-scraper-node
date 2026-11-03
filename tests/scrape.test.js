/** These run without a token. The API is a stub. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import {
  AD_LIBRARY,
  ApiError,
  CANCELLED,
  COMMENTS,
  EVENTS,
  GROUP_POSTS,
  MARKETPLACE,
  PAGE_POSTS,
  PAGES,
  POSTS,
  PROFILES,
  REELS,
  REVIEWS,
  TokenMissing,
  ads,
  adsSearch,
  comments,
  events,
  eventsByVenue,
  eventsSearch,
  groupPosts,
  marketplace,
  marketplaceCategory,
  marketplaceSearch,
  pagePosts,
  pageUrl,
  pages,
  posts,
  profiles,
  reels,
  reviews,
  run,
  scrape,
  scrapePage,
  split,
  token,
  transport,
  write,
} from "../src/scrape.js";
import { main } from "../src/cli.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const exec = promisify(execFile);
const real = { ...transport };
const savedToken = process.env.BRIGHTDATA_API_TOKEN;

let temp;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "fbscraper-"));
});
after(async () => {
  await rm(temp, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.BRIGHTDATA_API_TOKEN = "test";
  transport.sleep = async () => {};
});
afterEach(() => {
  Object.assign(transport, real);
  if (savedToken === undefined) delete process.env.BRIGHTDATA_API_TOKEN;
  else process.env.BRIGHTDATA_API_TOKEN = savedToken;
});

/** Answers trigger, progress and snapshot the way the live API does. */
function fakeApi({ rows = [], states = ["ready"], refuse } = {}) {
  const calls = [];
  const queue = [...states];
  transport.fetch = async (url, init) => {
    const path = url.slice("https://api.brightdata.com/datasets/v3".length);
    calls.push({ path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const reply = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
    if (refuse) return reply(refuse.status, refuse.body);
    if (path.startsWith("/trigger")) return reply(200, { snapshot_id: "sd_test" });
    if (path.startsWith("/progress/")) return reply(200, { status: queue.length > 1 ? queue.shift() : queue[0] });
    if (path.startsWith("/snapshot/")) return reply(200, rows);
    throw new Error(path);
  };
  return {
    calls,
    trigger() {
      const { path, body } = calls[0];
      return { query: Object.fromEntries(new URLSearchParams(path.split("?")[1])), body };
    },
  };
}

describe("what is sent", () => {
  test("page posts send the limit as num_of_posts and only the options given", async () => {
    const api = fakeApi();
    await pagePosts("https://www.facebook.com/Meta", { limit: 3, start_date: "10-01-2026", end_date: undefined });

    const { query, body } = api.trigger();
    assert.deepEqual(query, { dataset_id: PAGE_POSTS, include_errors: "true" });
    assert.deepEqual(body, [{ url: "https://www.facebook.com/Meta", num_of_posts: 3, start_date: "10-01-2026" }]);
  });

  test("comments are capped with limit_records, not num_of_comments", async () => {
    // the API rejects num_of_comments, the name the Python SDK sends, with a 400
    const api = fakeApi();
    await comments(["https://www.facebook.com/Meta/posts/1"], { limit: 3 });

    const { query, body } = api.trigger();
    assert.equal(query.dataset_id, COMMENTS);
    assert.deepEqual(body, [{ url: "https://www.facebook.com/Meta/posts/1", limit_records: 3 }]);
  });

  test("each collect-by-URL scraper uses its own dataset", async () => {
    for (const [call, dataset] of [
      [posts, POSTS],
      [pages, PAGES],
      [profiles, PROFILES],
      [events, EVENTS],
      [marketplace, MARKETPLACE],
      [ads, AD_LIBRARY],
    ]) {
      const api = fakeApi();
      await call(["https://www.facebook.com/x", "https://www.facebook.com/y"]);
      const { query, body } = api.trigger();
      assert.deepEqual(query, { dataset_id: dataset, include_errors: "true" });
      assert.deepEqual(body, [{ url: "https://www.facebook.com/x" }, { url: "https://www.facebook.com/y" }]);
    }
  });

  test("limits use the input name each scraper validates", async () => {
    for (const [call, dataset, field] of [
      [groupPosts, GROUP_POSTS, "num_of_posts"],
      [reels, REELS, "num_of_posts"],
      [reviews, REVIEWS, "num_of_reviews"],
    ]) {
      const api = fakeApi();
      await call("https://www.facebook.com/x", { limit: 4 });
      const { query, body } = api.trigger();
      assert.equal(query.dataset_id, dataset);
      assert.equal(query.discover_by, undefined);
      assert.deepEqual(body, [{ url: "https://www.facebook.com/x", [field]: 4 }]);
    }
  });

  test("each discovery is capped and names its method", async () => {
    for (const [call, args, dataset, discoverBy, item] of [
      [eventsSearch, ["https://www.facebook.com/events/search/?q=marathon", { limit: 3 }], EVENTS, "url",
        { url: "https://www.facebook.com/events/search/?q=marathon" }],
      [eventsByVenue, ["https://www.facebook.com/TheGarden/events", { limit: 3 }], EVENTS, "venue",
        { url: "https://www.facebook.com/TheGarden/events", upcoming_events_only: true }],
      [marketplaceSearch, ["bicycle", "New York", { limit: 3 }], MARKETPLACE, "keyword",
        { keyword: "bicycle", city: "New York" }],
      [marketplaceCategory, ["https://www.facebook.com/marketplace/category/vehicles", { limit: 3 }], MARKETPLACE, "url",
        { url: "https://www.facebook.com/marketplace/category/vehicles" }],
      [adsSearch, ["coffee", { country: "us", limit: 3 }], AD_LIBRARY, "keyword",
        { keyword: "coffee", country: "US", ad_type: "All ads" }],
    ]) {
      const api = fakeApi();
      await call(...args);
      const { query, body } = api.trigger();
      assert.deepEqual(query, {
        dataset_id: dataset,
        include_errors: "true",
        type: "discover_new",
        discover_by: discoverBy,
        limit_per_input: "3",
      });
      assert.deepEqual(body, [item]);
    }
  });

  test("a page can be a name, a handle or a URL", () => {
    for (const given of ["Meta", "@Meta", "facebook.com/Meta", "https://www.facebook.com/Meta/"]) {
      assert.equal(pageUrl(given), "https://www.facebook.com/Meta");
    }
    for (const bad of ["", "two words", "https://www.facebook.com/"]) {
      assert.throws(() => pageUrl(bad));
    }
  });
});

describe("the job", () => {
  test("run polls until the snapshot is ready", async () => {
    const api = fakeApi({ rows: [{ page_name: "Meta" }], states: ["running", "running", "ready"] });
    assert.deepEqual(await run(PAGES, [{ url: "x" }]), [{ page_name: "Meta" }]);
    assert.equal(api.calls.filter((c) => c.path === "/progress/sd_test").length, 3);
  });

  test("a dropped poll does not lose the job", async () => {
    fakeApi({ rows: [{ page_name: "Meta" }] });
    const answer = transport.fetch;
    let dropped = 0;
    transport.fetch = async (url, init) => {
      if (url.includes("/progress/") && !dropped++) throw new TypeError("fetch failed");
      return answer(url, init);
    };
    assert.deepEqual(await run(PAGES, [{ url: "x" }]), [{ page_name: "Meta" }]);
    assert.equal(dropped, 2);
  });

  test("a failed snapshot is an error", async () => {
    fakeApi({ states: ["failed"] });
    await assert.rejects(run(PAGES, [{ url: "x" }]), /sd_test failed/);
  });

  test("a job that never finishes times out", async () => {
    fakeApi({ states: ["running"] });
    await assert.rejects(run(PAGES, [{ url: "x" }], { timeoutMs: -1 }), /timeout/);
  });

  test("an HTTP error names the status and the reason", async () => {
    fakeApi({ refuse: { status: 400, body: { error: "validation_error" } } });
    await assert.rejects(run(PAGES, [{ url: "x" }]), (error) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /HTTP 400.*validation_error/);
      return true;
    });
  });
});

describe("the token", () => {
  test("comes from the environment, then the CLI login", async () => {
    delete process.env.BRIGHTDATA_API_TOKEN;
    transport.credentialsPath = () => join(temp, "missing.json");
    assert.throws(() => token(), TokenMissing);
    assert.throws(() => token(), /export BRIGHTDATA_API_TOKEN/);

    const credentials = join(temp, "credentials.json");
    await writeFile(credentials, JSON.stringify({ api_key: "from-login" }));
    transport.credentialsPath = () => credentials;
    assert.equal(token(), "from-login");

    process.env.BRIGHTDATA_API_TOKEN = "from-env";
    assert.equal(token(), "from-env");
  });
});

describe("what the API answers", () => {
  test("error rows alone fail the page", async () => {
    fakeApi({ rows: [{ error: "The navigation resulted in a dead page (404 status code)", error_code: "dead_page" }] });
    const outcome = await scrapePage("zzqqxx-no-such-page");
    assert.ok(!outcome.ok);
    assert.equal(outcome.line(), "failed  zzqqxx-no-such-page: The navigation resulted in a dead page (404 status code)");
  });

  test("posts already paid for are kept when some rows fail", async () => {
    fakeApi({ rows: [{ url: "p1" }, { error: "Crawler error", error_code: "crawl_failed" }] });
    const outcome = await scrapePage("Meta");
    assert.ok(outcome.ok);
    assert.deepEqual(outcome.posts, [{ url: "p1" }]);
    assert.equal(outcome.line(), "got     Meta: 1 posts, 1 error rows: Crawler error");
  });

  test("rows cancelled by the limit are not errors", () => {
    const { records, errors } = split([{ url: "ad1" }, { error: CANCELLED }, { error: CANCELLED }]);
    assert.deepEqual(records, [{ url: "ad1" }]);
    assert.deepEqual(errors, []);
  });

  test("a bad page name fails without a request", async () => {
    const api = fakeApi();
    const outcome = await scrapePage("two words");
    assert.ok(!outcome.ok);
    assert.equal(api.calls.length, 0);
  });

  test("one bad page does not end the run", async () => {
    let n = 0;
    transport.fetch = async () => {
      n += 1;
      if (n === 1) throw new RangeError("boom");
      const body = n === 2 ? { snapshot_id: "s" } : n === 3 ? { status: "ready" } : [{ url: "https://www.facebook.com/Meta" }];
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const [first, second] = await scrape(["boom", "Meta"]);
    assert.equal(first.error, "RangeError: boom");
    assert.ok(second.ok);
    assert.deepEqual(second.posts, [{ url: "https://www.facebook.com/Meta" }]);
  });

  test("a run writes what it found", async () => {
    fakeApi({ rows: [{ url: "p1", likes: 722 }] });
    const outcomes = await scrape(["Meta"], { limit: 1 });
    const document = JSON.parse(await readFile(await write(outcomes, join(temp, "out.json")), "utf8"));
    assert.deepEqual(document.pages, [{ page: "Meta", posts: [{ url: "p1", likes: 722 }] }]);
    assert.ok(document.generated_at);
  });
});

describe("the command", () => {
  test("the exit code says whether every page worked", async () => {
    fakeApi({ rows: [{ url: "x" }] });
    assert.equal(await main(["Meta", "--out", join(temp, "ok.json")]), 0);
    fakeApi({ rows: [{ error: "boom" }] });
    assert.equal(await main(["Meta", "--out", join(temp, "bad.json")]), 1);
  });

  test("each result prints before the next page starts", async () => {
    fakeApi({ rows: [{ url: "x" }] });
    const lines = [];
    const original = process.stdout.write;
    const isTTY = process.stdout.isTTY;
    process.stdout.isTTY = false;
    process.stdout.write = (chunk) => {
      lines.push(...String(chunk).split("\n"));
      return true;
    };
    try {
      await main(["Meta", "Microsoft", "--out", join(temp, "o.json")]);
    } finally {
      process.stdout.write = original;
      process.stdout.isTTY = isTTY;
    }
    assert.deepEqual(
      lines.filter((l) => l.startsWith("asking") || l.startsWith("got")),
      ["asking  Meta...", "got     Meta: 1 posts", "asking  Microsoft...", "got     Microsoft: 1 posts"],
    );
  });

  test("a bad limit is refused before any request", async () => {
    const api = fakeApi();
    for (const bad of [["x", "--limit", "0"], ["x", "--limit", "-3"], []]) {
      assert.equal(await main(bad), 2);
    }
    assert.equal(api.calls.length, 0);
  });

  test("a missing token is a message, not a stack trace, and the header comes first", async () => {
    const env = { ...process.env, HOME: temp, APPDATA: temp };
    delete env.BRIGHTDATA_API_TOKEN;
    const done = await exec(process.execPath, [join(ROOT, "src", "cli.js"), "Meta"], { env }).catch((e) => e);
    assert.equal(done.code, 2);
    assert.match(done.stderr, /export BRIGHTDATA_API_TOKEN/);
    assert.match(done.stderr, /bdata login/);
    assert.doesNotMatch(done.stderr, /at .*\.js:\d+/);
    assert.match(done.stdout, /^Fetching up to 5 recent posts per page, for: Meta\n/);
  });
});

describe("the README", () => {
  test("the excerpt is the start of the example file", async () => {
    const sample = await readFile(join(ROOT, "examples", "sample_output.json"), "utf8");
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    assert.ok(readme.includes(sample.split("\n").slice(0, 20).join("\n")), "README excerpt drifted from the file");
    assert.ok(readme.includes("](examples/sample_output.json)"));
  });

  test("every in-page link has its heading", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    const anchors = new Set(
      [...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9 -]/g, "").replaceAll(" ", "-")),
    );
    for (const [, anchor] of readme.matchAll(/\]\(#([^)]+)\)/g)) {
      assert.ok(anchors.has(anchor), `#${anchor} points at no heading`);
    }
  });
});
