#!/usr/bin/env node
/**
 * 上游同步器：把 ACL4SSR 的分流清单与 MetaCubeX 的 geo 数据库收成本仓库的产出。
 *
 * 两种模式：
 *   node tools/sync.mjs          全量同步（默认）
 *   node tools/sync.mjs --check  轻量探测，只问两个上游「变了吗」，不下载任何内容
 *
 * 退出码：
 *   0  全量同步完成（有或无变化都算成功）
 *   2  --check 判定「上游无变化」（供 CI 决定是否跳过）
 *   1  出错
 *
 * **幂等是硬要求**：没有实质变化时，本脚本不写任何文件 —— 15 分钟一次的 cron
 * 才不会把仓库刷成一堆空提交。（VERSION / PROVENANCE.md / latest.json 全是
 * 派生文件，只在内容真的变了之后才更新。）
 *
 * 变化判定分两层：
 *   1. --check 先比上游坐标（ACL4SSR commit SHA、meta-rules-dat release published_at）
 *   2. 全量时逐文件比对字节；规范化消除「上游只动注释/换行/顺序」的抖动
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULE_SETS, GEO_ASSETS, UPSTREAM, TEXT_HEADERS, DIST_DIR, MAX_OUTPUT_BYTES } from './manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

const PROXY = process.env.POLARIS_SYNC_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '';
const UA = 'polaris-rules-sync/1.0 (+https://github.com/ipevel/polaris)';
const MAX_ATTEMPTS = 4;

/* ------------------------------------------------------------------ */
/* HTTP：走可选代理，指数退避重试                                       */
/* ------------------------------------------------------------------ */

let proxyDispatcher = null;
async function initProxy() {
  if (!PROXY) return;
  try {
    const { ProxyAgent } = await import('undici');
    proxyDispatcher = new ProxyAgent(PROXY);
    log(`使用代理 ${PROXY}`);
  } catch {
    log(`(未装 undici，忽略代理设置 ${PROXY}；直连可用则无需代理)`);
  }
}

function log(msg) { process.stdout.write(`${msg}\n`); }
function warn(msg) { process.stderr.write(`WARN  ${msg}\n`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, { json = false, binary = false, allow404 = false } = {}) {
  const init = { headers: { 'user-agent': UA, accept: json ? 'application/vnd.github+json' : '*/*' } };
  if (proxyDispatcher) init.dispatcher = proxyDispatcher;

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (allow404 && res.status === 404) return null;
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText} for ${url}`), { fatal: true });
      }
      return json ? await res.json() : binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (err) {
      lastErr = err;
      if (err.fatal) throw err;
      if (attempt === MAX_ATTEMPTS) break;
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
      warn(`第 ${attempt} 次失败（${err.message}），${backoff}ms 后重试`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/* 规范化：上游 list -> 产出 list                                       */
/* ------------------------------------------------------------------ */

const RULE_RE = /^[A-Z][A-Z0-9-]*\s*,/;

/**
 * 内核（mihomo）不认的规则类型 —— 在**源头**丢掉，别让它们进产出文件。
 *
 * 上游 ACL4SSR 的清单里有少量 `URL-REGEX`：mihomo 从早期就不支持这个类型，
 * 加载时会逐条打 `parse classical rule [...] error: unsupported rule type: URL-REGEX`
 * 然后丢掉 —— 也就是说这些行**本来就没生效过**。
 *
 * 留在文件里的唯一后果，是每台设备每次启动内核都刷一片 WARN（安卓 9 次 / Windows 27 次），
 * 用户看日志会以为哪里坏了（这事在 DEVNOTES 的 A-54 里查过一次，当时是拿脚本从旧的
 * 随包资源里剔的；现在上游改成统一从本仓库同步，就在这一层做，两端一起受益）。
 *
 * 也**不要**把它们改写成 DOMAIN-REGEX：URL-REGEX 匹配的是完整 URL（含路径），
 * 换成 DOMAIN-REGEX 会把「某站点下某个路径」放大成「整个站点」，那是行为变更，不是清理。
 */
const UNSUPPORTED_RULE_TYPES = new Set(['URL-REGEX']);

/** 规则行里的类型字段（`URL-REGEX,...` → `URL-REGEX`） */
function ruleType(line) {
  const i = line.indexOf(',');
  return (i < 0 ? line : line.slice(0, i)).trim().toUpperCase();
}

/** 命中的「内核不认」的行 —— 用于如实记账，不静默丢 */
function unsupportedLines(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!RULE_RE.test(line)) continue;
    if (UNSUPPORTED_RULE_TYPES.has(ruleType(line))) out.push(line);
  }
  return out;
}

/**
 * 只保留规则行（以「类型,」开头），丢掉注释与空行。
 *
 * 理由：上游注释会随内容抖动（如「# 数量：12条」），留着会让每次上游改动都产生
 * 一次无意义提交；而 mihomo 的 rule-provider format:text 本来就会跳过 # 注释。
 * 产出文件的表头注释由我们自己在合并后统一生成，且内容稳定。
 */
function normalizeList(text) {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!RULE_RE.test(line)) continue;
    rules.push(line);
  }
  return rules;
}

/** 上游里被跳过的「认不出的行」——用于暴露上游格式变化，不静默丢规则 */
function anomalousLines(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!RULE_RE.test(line)) out.push(line);
  }
  return out;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  return out;
}

function mergeLists(setDef, fetched) {
  const provenance = [];
  const all = [];
  let raw = 0;
  let dropped = 0;

  for (const { name, text } of fetched) {
    const rules0 = normalizeList(text);
    const rules = rules0.filter((l) => !UNSUPPORTED_RULE_TYPES.has(ruleType(l)));
    const bad = anomalousLines(text);
    if (bad.length) warn(`${setDef.out}: ${name}.list 有 ${bad.length} 行不是规则行，已跳过（首行：${bad[0].slice(0, 80)}）`);
    const dead = unsupportedLines(text);
    if (dead.length) log(`${setDef.out}: ${name}.list 丢弃 ${dead.length} 条内核不认的规则（类型 ${[...new Set(dead.map(ruleType))].join('/')}）`);
    dropped += dead.length;
    raw += rules.length;
    all.push(...rules);
    provenance.push({ source: name, count: rules.length });
  }

  // 注入项：manifest 里声明、上游不提供（或会被上游下次同步覆盖掉）的补丁规则。
  // 放在去重之前，保证注入项与上游重复时不会出现重复行。
  let injected = 0;
  for (const r of setDef.extra || []) {
    const line = String(r).trim();
    if (!line) continue;
    if (UNSUPPORTED_RULE_TYPES.has(ruleType(line))) {
      throw new Error(`${setDef.out}: manifest.extra 里有内核不支持的规则类型：${line}`);
    }
    all.push(line);
    injected += 1;
  }

  const merged = dedupe(all);
  if (merged.length * 40 > MAX_OUTPUT_BYTES) {
    throw new Error(`${setDef.out} 产出过大（${merged.length} 条）—— 合并逻辑可能写错了`);
  }
  return { merged, count: merged.length, raw, provenance, dropped, injected };
}

/**
 * 由「已合并的规则行」生成两个形态：
 *   rules/<out>.txt        人看的：带固定表头（TEXT_HEADERS），无逐次变动的内容
 *   dist/rules/<out>.list  内核吃的：只含规则行（# 注释内核会跳过，但我们不给注释）
 */
function renderRuleSet(setDef, merged, raw, provenance, dropped = 0, injected = 0) {
  const dateNote = provenance.length > 1
    ? `# 合并自 ${provenance.length} 份 ACL4SSR 清单：${provenance.map((p) => p.source).join(' / ')}`
    : `# 来自 ACL4SSR 清单：${provenance[0]?.source || '—'}`;
  const dropNote = dropped
    ? `；丢弃内核不认的 URL-REGEX ${dropped} 条（该类型 mihomo 从不支持，内核本来也会逐条跳过）`
    : '';
  const injectNote = injected
    ? `；另按 manifest.extra 注入 ${injected} 条本地补丁规则（上游不提供）`
    : '';
  const txt = [
    ...(TEXT_HEADERS[setDef.out] || [`# Polaris 分流规则 —— ${setDef.out}`]),
    dateNote,
    `# 规则数：${merged.length} 条（上游合计 ${raw} 条，去重 ${raw - merged.length} 条${dropNote}${injectNote}）`,
    '',
  ].join('\n') + merged.join('\n') + '\n';

  // 内核形态：不给任何注释，保证 format:text 逐行都是规则
  const list = merged.join('\n') + '\n';
  return { txt, list };
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function readText(abs) { return existsSync(abs) ? readFileSync(abs, 'utf8') : null; }

/** 目标文件当前内容是否与之逐字节相同 */
function sameBytes(absPath, buf) {
  return existsSync(absPath) && readFileSync(absPath).equals(buf);
}

/** 直接落盘（调用方已确认内容不同） */
function put(absPath, buf) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, buf);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function getAclHead() {
  const url = `https://api.github.com/repos/${UPSTREAM.acl.repo}/commits?per_page=1&sha=${UPSTREAM.acl.ref}`;
  const arr = await http(url, { json: true });
  const c = arr[0];
  return { sha: c.sha, date: c.commit.committer.date, message: (c.commit.message || '').split('\n')[0] };
}

function readJson(abs) {
  const t = readText(abs);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function renderProvenance(latest) {
  const L = [];
  L.push('# 产出谱系（自动生成，勿手工编辑）', '');
  L.push(`生成时间：${latest.generatedAt}`);
  L.push(`版本：VERSION ${latest.version}`);
  L.push('');
  L.push('## 上游坐标', '');
  L.push(`- 分流清单：\`${latest.upstream.acl.repo}\` @ \`${latest.upstream.acl.sha}\`（${latest.upstream.acl.date}）`);
  L.push(`- geo 数据库：\`${latest.upstream.meta.repo}\` release \`${latest.upstream.meta.tag}\`（${latest.upstream.meta.publishedAt}）`);
  L.push('');
  L.push('## 两种形态');
  L.push('');
  L.push(`- \`rules/*.txt\`：人可读形态（带表头），用来 review 与 diff。`);
  L.push(`- \`${DIST_DIR}/rules/*.list\`：机可读形态（只有规则行），**App 只跟这一份打交道**；mihomo rule-provider \`format: text\` 直接吃。`);
  L.push(`- \`${DIST_DIR}/geo/*\`：geo 数据库，与根目录 \`geo/\` 同字节。`);
  L.push('');
  L.push('## 文件来源');
  L.push('');
  L.push('| 产出文件 | 条数 | 上游来源 |');
  L.push('|---|---|---|');
  for (const e of latest.files) {
    if (e.path.startsWith(`${DIST_DIR}/geo/`)) continue;   // 与根目录 geo 同源，只列一次
    const mark = e.format === 'text' ? ' *(内核形态)*' : '';
    const src = e.sources ? e.sources.join(', ') : `release 资产 \`${e.upstreamAsset}\``;
    L.push(`| \`${e.path}\`${mark} | ${e.rules ?? '—'} | ${src} |`);
  }
  L.push('');
  L.push('## 校验');
  L.push('');
  L.push('每个文件的 SHA-256 见根目录与 `' + DIST_DIR + '/` 下的 `SHA256SUMS.txt`，以及 `latest.json`。');
  L.push('App 侧必须**从同一个 commit** 取文件与校验值，否则会出现「新 sum 配旧字节」');
  L.push('（jsdelivr 各边缘缓存寿命不同，二进制与 sum 分开缓存就会这样）。');
  L.push('');
  L.push('> 自洽性由 `node tools/verify.mjs` 保证：它重算 SHA256 并对 `dist/` 与根目录逐文件比对。');
  L.push('');
  return L.join('\n');
}

async function main() {
  await initProxy();

  const aclHead = await getAclHead();
  const rel = await http(UPSTREAM.meta.apiBase, { json: true });
  const current = {
    acl: { sha: aclHead.sha, date: aclHead.date },
    meta: { tag: rel.tag_name, publishedAt: rel.published_at },
  };
  const prevUpstream = readJson(join(ROOT, 'last-upstream.json'));

  if (CHECK_ONLY) {
    const same = prevUpstream
      && prevUpstream.acl?.sha === current.acl.sha
      && prevUpstream.meta?.publishedAt === current.meta.publishedAt;
    log(`上游坐标：ACL4SSR ${current.acl.sha.slice(0, 8)} (${current.acl.date}) · meta-rules-dat ${current.meta.publishedAt}`);
    if (same) { log('判定：上游无变化，跳过'); process.exit(2); }
    log('判定：上游有变化，需要全量同步');
    process.exit(0);
  }

  log('开始全量同步');
  log(`  ACL4SSR        @ ${current.acl.sha.slice(0, 8)} (${current.acl.date})`);
  log(`  meta-rules-dat   release ${current.meta.tag} @ ${current.meta.publishedAt}`);
  log('');

  const changed = [];

  // ---- 1. 规则清单 ----
  const staged = [];
  for (const setDef of RULE_SETS) {
    const specs = setDef.files.map((n) => ({ name: n, dir: setDef.dir }));
    for (const n of setDef.alsoRuleset || []) specs.push({ name: n, dir: 'Clash/Ruleset' });
    for (const n of setDef.alsoClash || []) specs.push({ name: n, dir: 'Clash' });

    const fetched = [];
    for (const spec of specs) {
      fetched.push({ name: spec.name, text: await http(`${UPSTREAM.acl.rawBase}/${current.acl.sha}/${spec.dir}/${spec.name}.list`) });
    }

    const { merged, count, raw, provenance, dropped, injected } = mergeLists(setDef, fetched);
    const { txt, list } = renderRuleSet(setDef, merged, raw, provenance, dropped, injected);
    const sources = provenance.map((p) => `${p.source}.list`);
    staged.push({ path: `rules/${setDef.out}.txt`, buf: Buffer.from(txt), rules: count, raw, sources });
    staged.push({ path: `${DIST_DIR}/rules/${setDef.out}.list`, buf: Buffer.from(list), rules: count, sources, kernel: true });
    log(`  ${setDef.out.padEnd(14)} rules/…txt + dist/rules/…list  ${String(count).padStart(5)} 条  (${provenance.map((p) => `${p.source}:${p.count}`).join(' ')})`);
  }

  // ---- 2. geo 资产（每个都对着 release 自带的 .sha256sum 校验）----
  const byName = new Map(rel.assets.map((a) => [a.name, a]));
  const base = `${UPSTREAM.meta.downloadBase}/${UPSTREAM.meta.releaseTag}`;
  for (const g of GEO_ASSETS) {
    if (!byName.has(g.asset)) throw new Error(`release 里没有资产 ${g.asset}`);
    if (!byName.has(g.sha)) throw new Error(`release 里没有校验资产 ${g.sha} —— 校验基准缺失，拒绝同步`);

    const buf = await http(`${base}/${g.asset}`, { binary: true });
    const sumText = await http(`${base}/${g.sha}`);
    const expected = (sumText.trim().split(/\s+/)[0] || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`${g.sha} 不是合法 sha256：${sumText.slice(0, 80)}`);
    const actual = sha256(buf);
    if (actual !== expected) throw new Error(`${g.asset} 校验不过：期望 ${expected}，实得 ${actual}`);
    log(`  ${g.dest.padEnd(24)} ${String(buf.length).padStart(9)} 字节  sha256 ${actual.slice(0, 16)}…`);
    staged.push({ path: g.dest, buf, upstreamAsset: g.asset });
    staged.push({ path: `${DIST_DIR}/${g.dest}`, buf, upstreamAsset: g.asset });
  }

  // ---- 3. 先判定「真的变了吗」----
  for (const s of staged) {
    if (!sameBytes(join(ROOT, s.path), s.buf)) changed.push(s.path);
  }

  const upstreamSame = prevUpstream
    && prevUpstream.acl?.sha === current.acl.sha
    && prevUpstream.meta?.publishedAt === current.meta.publishedAt;

  if (!changed.length && upstreamSame) {
    log('\n无实质变化（逐字节相同）—— 不写任何文件，不产生提交');
    process.exit(0);
  }

  // ---- 4. 清掉 dist 里已不再产出的文件（防陈旧文件被 App 拉到）----
  const distRules = join(ROOT, DIST_DIR, 'rules');
  const expectedLists = new Set(RULE_SETS.map((s) => `${s.out}.list`));
  if (existsSync(distRules)) {
    for (const f of readdirSync(distRules)) {
      if (!expectedLists.has(f)) {
        rmSync(join(distRules, f));
        changed.push(`${DIST_DIR}/rules/${f}（已废弃，删除）`);
      }
    }
  }

  // ---- 5. 落盘 ----
  for (const s of staged) {
    const abs = join(ROOT, s.path);
    if (!sameBytes(abs, s.buf)) put(abs, s.buf);
  }

  const verPath = join(ROOT, 'VERSION');
  const prevVer = (Number((readText(verPath) || '0').trim()) || 0);
  const nextVer = prevVer + 1;
  put(verPath, Buffer.from(`${nextVer}\n`));

  const byPath = new Map(staged.map((s) => [s.path, s]));
  const fileEntries = [...byPath.values()].map((s) => ({
    path: s.path,
    bytes: s.buf.length,
    sha256: sha256(s.buf),
    ...(s.sources ? { rules: s.rules, sources: s.sources } : { upstreamAsset: s.upstreamAsset }),
    ...(s.kernel ? { format: 'text', behavior: 'classical' } : {}),
  })).sort((a, b) => a.path.localeCompare(b.path));

  const sums = fileEntries.map((e) => `${e.sha256}  ${e.path}`).join('\n') + '\n';
  put(join(ROOT, 'SHA256SUMS.txt'), Buffer.from(sums));
  put(join(ROOT, DIST_DIR, 'SHA256SUMS.txt'), Buffer.from(sums));

  const now = new Date().toISOString();
  const latest = {
    schema: 1,
    version: nextVer,
    generatedAt: now,
    upstream: {
      acl: { repo: UPSTREAM.acl.repo, sha: current.acl.sha, date: current.acl.date },
      meta: { repo: UPSTREAM.meta.repo, tag: current.meta.tag, publishedAt: current.meta.publishedAt },
    },
    files: fileEntries,
  };
  put(join(ROOT, 'latest.json'), Buffer.from(JSON.stringify(latest, null, 2) + '\n'));
  put(join(ROOT, 'last-upstream.json'), Buffer.from(JSON.stringify(current, null, 2) + '\n'));
  put(join(ROOT, 'PROVENANCE.md'), Buffer.from(renderProvenance(latest)));

  log(`\nVERSION ${prevVer} -> ${nextVer}`);
  log(`内容有变化：${changed.length ? changed.join(', ') : '（无；仅上游坐标变动）'}`);
  log(`产出 ${fileEntries.length} 个文件，合计 ${(fileEntries.reduce((a, b) => a + b.bytes, 0) / 1048576).toFixed(1)} MiB`);
}

main().catch((err) => {
  process.stderr.write(`同步失败：${err?.stack || err}\n`);
  process.exit(1);
});
