// Turns a real change in data/stations.json into Telegram broadcast copy.
//
// The whole point is that broadcast numbers are never typed by hand. This script
// reads the snapshot as committed in git history and compares the two most
// recent versions, so every "0.08x -> 0.06x" line in a post is backed by a
// commit anyone can open. If nothing changed, it says so and prints no copy --
// inventing a change, or padding a quiet day with filler, is worse than silence.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT = "data/stations.json";
const REPO = process.env.REPO_URL || "https://github.com/chenzongjian-ship-it/ai-api-relay-directory";

function git(...args) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

// Commits that actually touched the snapshot. A commit that only edited the
// workflow or a README must not be treated as a data change.
function snapshotCommits(limit = 40) {
  const out = git("log", `-n${limit}`, "--format=%H\t%cI", "--", SNAPSHOT).trim();
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [sha, date] = line.split("\t");
    return { sha, date };
  });
}

function snapshotAt(sha) {
  try {
    return JSON.parse(git("show", `${sha}:${SNAPSHOT}`));
  } catch {
    return null;
  }
}

function localSnapshot() {
  const file = path.join(rootDir, SNAPSHOT);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function bySlug(snapshot) {
  const map = new Map();
  for (const station of snapshot?.stations || []) map.set(station.slug, station);
  return map;
}

// Multipliers are free text ("0.06x", "0.08", "1x起"), so compare the parsed
// number to decide direction and keep the original string for display.
function rateValue(multiplier) {
  const match = String(multiplier ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : null;
}

function marks(station) {
  const flags = [];
  if (station.publicBenefit) flags.push("有免费额度");
  if (station.supportsCheckin) flags.push("支持签到");
  return flags.length ? `（${flags.join("，")}）` : "";
}

function diffSnapshots(before, after) {
  const prev = bySlug(before);
  const next = bySlug(after);

  const cheaper = [];
  const pricier = [];
  const added = [];
  const removed = [];
  const flagged = [];

  for (const [slug, station] of next) {
    const old = prev.get(slug);
    if (!old) {
      added.push(station);
      continue;
    }

    const oldRate = rateValue(old.multiplier);
    const newRate = rateValue(station.multiplier);
    if (oldRate !== null && newRate !== null && oldRate !== newRate) {
      (newRate < oldRate ? cheaper : pricier).push({ station, from: old.multiplier, to: station.multiplier });
    }

    // A station turning check-in or a free tier on/off matters to readers even
    // when the headline multiplier is unchanged.
    if (Boolean(old.supportsCheckin) !== Boolean(station.supportsCheckin)) {
      flagged.push({ station, label: "签到", on: Boolean(station.supportsCheckin) });
    }
    if (Boolean(old.publicBenefit) !== Boolean(station.publicBenefit)) {
      flagged.push({ station, label: "免费额度", on: Boolean(station.publicBenefit) });
    }
  }

  for (const [slug, station] of prev) {
    if (!next.has(slug)) removed.push(station);
  }

  return { cheaper, pricier, added, removed, flagged };
}

function renderBroadcast(diff, { after, sha, date }) {
  const lines = [`📊 倍率变动 · ${date}`];

  if (diff.cheaper.length) {
    lines.push("", "🔻 降价");
    for (const row of diff.cheaper) lines.push(`· ${row.station.name} ${row.from} → ${row.to}`);
  }
  if (diff.pricier.length) {
    lines.push("", "🔺 涨价");
    for (const row of diff.pricier) lines.push(`· ${row.station.name} ${row.from} → ${row.to}`);
  }
  if (diff.added.length) {
    lines.push("", "🆕 新收录");
    for (const station of diff.added) lines.push(`· ${station.name} ${station.multiplier}${marks(station)}`);
  }
  if (diff.removed.length) {
    lines.push("", "⛔ 已下架");
    for (const station of diff.removed) lines.push(`· ${station.name}`);
  }
  if (diff.flagged.length) {
    lines.push("", "🔧 其他变动");
    for (const row of diff.flagged) {
      lines.push(`· ${row.station.name} ${row.label}${row.on ? "上线" : "下线"}`);
    }
  }

  const counts = after?.counts || {};
  lines.push(
    "",
    "📋 变更明细",
    `${REPO}/commit/${sha}`,
    "",
    `当前 ${counts.published ?? "?"} 站 · ${counts.public_benefit ?? "?"} 公益 · ${counts.checkin ?? "?"} 签到`,
    `完整表 ${REPO}`,
    "",
    "⚠️ 以各站页面为准。部分入口含返利，不影响你的价格。",
  );

  return lines.join("\n");
}

// --pending diffs the freshly generated working-tree snapshot against the last
// committed one. CI needs the verdict *before* it writes a commit message, and
// after committing the working tree and HEAD are identical, so the default
// two-commit comparison cannot answer that question.
const PENDING = process.argv.includes("--pending");

if (PENDING) {
  const commits = snapshotCommits(1);
  const after = localSnapshot();
  if (!after) {
    console.log(JSON.stringify({
      status: "no-snapshot",
      hint: `${SNAPSHOT} is missing from the working tree; run build-readme.mjs first`,
      broadcast: null,
    }, null, 2));
    process.exit(1);
  }
  const baseSha = commits[0]?.sha;
  const before = baseSha ? snapshotAt(baseSha) : null;
  if (!before) {
    console.log(JSON.stringify({
      status: "baseline-only",
      hint: "no committed snapshot to compare against; this run establishes the baseline",
      broadcast: null,
    }, null, 2));
    process.exit(0);
  }
  const pendingDiff = diffSnapshots(before, after);
  const pendingCount = pendingDiff.cheaper.length + pendingDiff.pricier.length
    + pendingDiff.added.length + pendingDiff.removed.length + pendingDiff.flagged.length;
  console.log(JSON.stringify({
    status: pendingCount === 0 ? "no-change" : "change",
    from: baseSha.slice(0, 7),
    to: "working-tree",
    changes: {
      cheaper: pendingDiff.cheaper.length,
      pricier: pendingDiff.pricier.length,
      added: pendingDiff.added.length,
      removed: pendingDiff.removed.length,
      flagged: pendingDiff.flagged.length,
    },
    broadcast: null,
  }, null, 2));
  process.exit(0);
}

const commits = snapshotCommits();

if (commits.length === 0) {
  console.log(JSON.stringify({
    status: "no-snapshot",
    hint: `${SNAPSHOT} has never been committed; run build-readme.mjs and commit it first`,
    broadcast: null,
  }, null, 2));
  process.exit(0);
}

// Compare the newest committed snapshot against the one before it. With a single
// commit there is no prior state, so there is nothing to broadcast yet.
const [newest, previous] = commits;
const after = snapshotAt(newest.sha) || localSnapshot();
const before = previous ? snapshotAt(previous.sha) : null;

if (!after) {
  console.log(JSON.stringify({
    status: "unreadable-snapshot",
    hint: `could not parse ${SNAPSHOT} at ${newest.sha.slice(0, 7)}`,
    broadcast: null,
  }, null, 2));
  process.exit(1);
}

if (!before) {
  console.log(JSON.stringify({
    status: "baseline-only",
    snapshotCommits: commits.length,
    hint: "only one snapshot exists, so there is no prior state to diff; nothing to broadcast yet",
    broadcast: null,
  }, null, 2));
  process.exit(0);
}

const diff = diffSnapshots(before, after);
const changeCount = diff.cheaper.length + diff.pricier.length + diff.added.length
  + diff.removed.length + diff.flagged.length;

if (changeCount === 0) {
  console.log(JSON.stringify({
    status: "no-change",
    from: previous.sha.slice(0, 7),
    to: newest.sha.slice(0, 7),
    hint: "nothing moved between the last two snapshots; do not post today",
    broadcast: null,
  }, null, 2));
  process.exit(0);
}

const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(newest.date));

const broadcast = renderBroadcast(diff, { after, sha: newest.sha, date });

console.log(JSON.stringify({
  status: "change",
  from: previous.sha.slice(0, 7),
  to: newest.sha.slice(0, 7),
  changes: {
    cheaper: diff.cheaper.length,
    pricier: diff.pricier.length,
    added: diff.added.length,
    removed: diff.removed.length,
    flagged: diff.flagged.length,
  },
  broadcast,
}, null, 2));
