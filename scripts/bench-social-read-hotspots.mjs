// Deterministic local-only CPU/DOM and CDP read-path benchmark. Never connects
// to a browser or social account. Run: node scripts/bench-social-read-hotspots.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, 'x-easy', 'src', 'index.js'), 'utf8');
const PORT_DELAY_MS = 30;
const snapshot = () => ({ cpu: process.cpuUsage(), rss: process.memoryUsage().rss });
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return +(sorted[Math.ceil(sorted.length * p) - 1] || 0).toFixed(3);
};
function measure(samples, operation) {
  const samplesMs = [];
  const before = snapshot();
  for (let i = 0; i < samples + 5; i++) {
    const start = performance.now();
    const result = operation();
    if (i >= 5) samplesMs.push(performance.now() - start);
    if (result == null) throw Error('Benchmark fixture returned null');
  }
  const cpu = process.cpuUsage(before.cpu);
  return { p50_ms: percentile(samplesMs, .5), p95_ms: percentile(samplesMs, .95),
    cpu_ms: +((cpu.user + cpu.system) / 1000).toFixed(2), rss_change_kib: +((process.memoryUsage().rss - before.rss) / 1024).toFixed(1) };
}
const template = (name) => {
  const match = new RegExp(`const ${name} = (\x60[\\s\\S]*?\x60);`).exec(source);
  if (!match) throw Error(`Missing ${name}`);
  return vm.runInNewContext(match[1]);
};

function makePost(i) {
  const article = {};
  const url = `/author${i}/status/${100000 + i}`;
  const link = { getAttribute: () => url, closest: () => article };
  const clock = { getAttribute: () => '2026-10-29T12:00:00Z', closest: () => link };
  const spans = Array.from({ length: 50 }, (_, n) => ({ textContent: n === 0 ? `@author${i}` : `Name ${n}` }));
  const media = Array.from({ length: 50 }, (_, n) => ({
    getAttribute: (attr) => attr === 'src' ? `https://pbs.twimg.com/media/${i}-${n}` : 'photo',
  }));
  const statusLinks = Array.from({ length: 50 }, (_, n) => ({
    getAttribute: () => n === 0 ? url : `/author${i}/status/${200000 + i * 50 + n}`,
    closest: () => article,
  }));
  const control = { closest: () => article, click: () => { throw Error('Read-only benchmark must not click'); } };
  article.querySelector = (sel) => {
    if (sel === 'time') return clock;
    if (sel === '[data-testid="User-Name"]') return { querySelectorAll: () => spans };
    if (sel === '[data-testid="tweetText"]') return { innerText: `Mock post ${i}: deterministic read content` };
    if (sel === '[data-testid="reply"]' || sel.includes('[data-testid="retweet"]') || sel.includes('[data-testid="like"]'))
      return { getAttribute: () => '1.5K', innerText: '1.5K' };
    if (sel.includes('a[href*="/status/"]')) return link;
    return null;
  };
  article.querySelectorAll = (sel) => {
    if (sel === 'a[href*="/status/"]') return statusLinks;
    if (sel === '[data-testid="like"]') return [control];
    if (sel.includes('tweetPhoto')) return media;
    return [];
  };
  return article;
}

const posts20 = Array.from({ length: 20 }, (_, i) => makePost(i));
const posts50 = Array.from({ length: 50 }, (_, i) => makePost(i));
const postsContext = vm.createContext({ document: { querySelectorAll: () => posts20 } });
const controlsContext = vm.createContext({ document: { querySelectorAll: () => posts50 } });
const extractPosts = vm.runInContext(`(${template('EXTRACT_POSTS_SCRIPT')})`, postsContext);
const controlScript = vm.runInContext(`(${template('CONTROL_SCRIPT')})`, controlsContext);
const notifications50 = Array.from({ length: 50 }, (_, i) => {
  const article = {};
  const elements = (make) => Array.from({ length: 50 }, (_, n) => ({ ...make(n), closest: () => article }));
  const body = elements((n) => ({ innerText: `Mock notification ${i}, post ${n}` }));
  const avatars = elements((n) => ({ getAttribute: () => `UserAvatar-Container-author${i}_${n}` }));
  const times = elements(() => ({ dateTime: '2026-10-29T12:00:00Z' }));
  return { innerText: `Author ${i} followed you. Mock notification ${i}, post 0`, closest: () => article,
    querySelectorAll: (selector) => selector === '[data-testid="tweetText"]' ? body
      : selector === '[data-testid^="UserAvatar-Container-"]' ? avatars : times };
});
const notificationsContext = vm.createContext({ document: { querySelectorAll: () => notifications50 } });
const notificationScript = vm.runInContext(`(${template('NOTIFICATION_SCRIPT')})`, notificationsContext);

const redditSource = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
const redditPart = (begin, end) => {
  const start = redditSource.indexOf(begin);
  const stop = redditSource.indexOf(end, start);
  if (start < 0 || stop < start) throw Error(`Missing Reddit runtime code ${begin}`);
  return redditSource.slice(start, stop);
};
const redditFns = [
  redditPart('function createdIso(value) {', '\nfunction normalizeThing(child) {'),
  redditPart('function normalizeThing(child) {', '\nfunction readResult(label, payload) {'),
].join('\n');
const parseRedditHttpsUrl = (href) => {
  const url = new URL(href);
  if (url.protocol !== 'https:' || (url.hostname !== 'reddit.com' && !url.hostname.endsWith('.reddit.com')))
    throw Error('Unsafe Reddit URL');
  return url;
};
const redditListing = new Function('parseRedditHttpsUrl', `${redditFns}\nreturn listingPayload;`)(parseRedditHttpsUrl);
const redditPosts20 = { data: { children: Array.from({ length: 20 }, (_, i) => ({ kind: 't3', data: {
  name: `t3_test${i}`, author: `author${i}`, title: `Reddit mock post ${i}`, subreddit: 'test',
  score: i * 10, num_comments: i * 3, created_utc: 1793275200,
  selftext: 'Deterministic mock body '.repeat(30), permalink: `/r/test/comments/test${i}/post/`,
} })) } };

const cpuResults = {
  x_extract_20_posts_50_spans_50_images_each: measure(300, () => {
    const result = extractPosts(20);
    if (result.length !== 20 || result[0].media.length !== 50) throw Error('Invalid 20-post extraction');
    return result;
  }),
  x_control_read_only_50_articles_50_links_each: measure(300, () => {
    const result = controlScript('100020', '[data-testid="like"]', false);
    if (result !== 'ok') throw Error(`Unexpected control selection: ${result}`);
    return result;
  }),
  x_extract_50_notifications_50_elements_per_selector: measure(300, () => {
    const result = notificationScript();
    if (result.length !== 50 || result[0].handles.length !== 50) throw Error('Invalid notifications');
    return result;
  }),
  reddit_normalize_20_json_posts: measure(300, () => {
    const result = redditListing(redditPosts20, 'r/test');
    if (result.count !== 20 || result.items[0].kind !== 'post') throw Error('Invalid Reddit listing');
    return result;
  }),
};

function slice(begin, end) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  if (start < 0 || stop < start) throw Error(`Unable to extract actual runtime function ${begin}`);
  return source.slice(start, stop);
}

const mockedPosts = Array.from({ length: 20 }, (_, i) => ({
  href: `/author${i}/status/${100000 + i}`, handle: `@author${i}`,
  text: `Mock post ${i}: deterministic read content`, name: `Author ${i}`, media: [],
}));

const requestCalls = [];
let currentHref = 'https://x.com/home';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cdp = {
  networkFailure: null,
  async send(method, args) {
    requestCalls.push(method);
    await delay(PORT_DELAY_MS);
    if (method === 'Page.navigate') currentHref = args.url;
    return {};
  },
  close() {},
};
const evaluate = async (_, expression) => {
  requestCalls.push('Runtime.evaluate');
  await delay(PORT_DELAY_MS);
  if (expression === 'location.href') return currentHref;
  if (expression === 'document.readyState') return 'complete';
  if (expression === template('X_SESSION_SCRIPT')) return { loggedIn: true, handle: 'mock_user' };
  if (expression.includes('article[data-testid="tweet"]')) return mockedPosts;
  throw Error(`Unexpected read expression: ${expression.slice(0, 70)}`);
};
const parseXHttpsUrl = (href) => {
  const url = new URL(href);
  if (url.protocol !== 'https:' || !['x.com', 'twitter.com'].includes(url.hostname)) throw Error('Unsafe navigation');
  return url;
};
const dependencyNames = ['evaluate', 'paceRead', 'appDir', 'sleep', 'parseXHttpsUrl', 'withLease',
  'getPageClient', 'X_SESSION_SCRIPT', 'clampLimit', 'MAX_SCROLLS', 'EXTRACT_POSTS_SCRIPT', 'SCROLL_PAUSE_MS'];
const dependencyValues = [evaluate, async () => {}, '/inert-profile', delay, parseXHttpsUrl,
  async (_dir, _type, _key, fn) => await fn(), async () => cdp,
  template('X_SESSION_SCRIPT'), (n) => Number(n) || 20, 12, template('EXTRACT_POSTS_SCRIPT'), 1200];
const actualFunctions = [
  slice('async function navigate(cdp, url) {', '\nasync function withXPage(fn) {'),
  slice('async function withXPage(fn) {', '\nasync function openXUrl(url) {'),
  slice('async function getSession(cdp, discoverHandle = false) {', '\nfunction normalizeHandle(value) {'),
  slice('function normalizeRawPost(raw) {', '\nasync function assertReadable(cdp) {'),
  slice('async function assertReadable(cdp) {', '\nasync function collectPosts(cdp, url, limit) {'),
  slice('async function collectPosts(cdp, url, limit) {', '\nasync function collectNotifications(cdp, limit) {'),
].join('\n');
const { withXPage, collectPosts } = new Function(...dependencyNames, `${actualFunctions}\nreturn {withXPage,collectPosts};`)(...dependencyValues);

const timed = [];
let count = 0;
for (let i = 0; i < 13; i++) {
  currentHref = 'https://x.com/home';
  requestCalls.length = 0;
  const start = performance.now();
  const posts = await withXPage(async (session) => await collectPosts(session, 'https://x.com/home', 20));
  if (posts.length !== 20) throw Error('Mocked 20-post read failed');
  if (i > 0) timed.push(performance.now() - start);
  if (i === 1) count = requestCalls.length;
}
console.log(JSON.stringify({
  fixture: 'local mocks only; real X read functions, fixed 30ms simulated CDP RTT; no profile pacing wait',
  dom: cpuResults,
  x_20_post_full_read: { n: timed.length, p50_ms: percentile(timed, .5), p95_ms: percentile(timed, .95),
    cdp_round_trips: count, mandatory_post_navigation_settle_ms: 900,
    simulated_cdp_rtt_ms: PORT_DELAY_MS,
    intentional_read_pacing_ms: 3000,
    theoretical_savings_if_one_CDP_RTT_removed_ms: PORT_DELAY_MS },
}, null, 2));
