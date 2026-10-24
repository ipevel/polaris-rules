#!/usr/bin/env node
/**
 * 自洽性校验器：证明仓库「自己跟自己一致」。
 *
 *   node tools/verify.mjs
 *
 * 检查项：
 *   1. latest.json 是可解析的、schema 版本认识
 *   2. latest.json.files 里每个文件都存在，且 SHA-256 与声明一致
 *   3. SHA256SUMS.txt（根目录与 dist/）与 latest.json 完全一致
 *   4. dist/rules/*.list 与 rules/*.txt 的**规则行集合**一致（人读/机读两份不能漂移）
 *   5. dist/geo/* 与 geo/* 逐字节一致
 *   6. dist/rules 里没有 latest.json 未声明的陈旧文件
 *   7. VERSION 是正整数
 *   8. 生成期断言：manifest 里声明了 forbid 的键，产物中不得出现这些宽口径条目
 *      （当前只有 onedrive；见 manifest.mjs 的注释与 8b 的「生成参数」版断言）
 *
 * 退出码：0 全过；1 有问题（逐条打印）。
 * 这个检查跑在 CI 里：同步产物不自洽就**不提交**。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULE_SETS } from './manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = 'dist';

const problems = [];
const notes = [];
function bad(msg) { problems.push(msg); }
function ok(msg) { notes.push(msg); }

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function abs(p) { return join(ROOT, p); }

/** 取出一份规则文件里的「规则行」（丢掉 # 注释与空行） */
function ruleLines(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** 取规则行的「域名 / 关键词」段（逗号后第一段，去掉参数），小写 */
function ruleDomain(line) {
  const i = String(line).indexOf(',');
  if (i < 0) return '';
  return String(line).slice(i + 1).split(',')[0].trim().toLowerCase();
}

/* ---- 1. latest.json ---- */
const latestPath = abs('latest.json');
if (!existsSync(latestPath)) {
  bad('latest.json 不存在');
} else {
  let latest = null;
  try { latest = JSON.parse(readFileSync(latestPath, 'utf8')); } catch (e) { bad(`latest.json 不是合法 JSON：${e.message}`); }
  if (latest) {
    if (latest.schema !== 1) bad(`latest.json schema=${latest.schema}，本校验器只认识 1`);
    if (!Number.isInteger(latest.version) || latest.version <= 0) bad(`latest.json version 非法：${latest.version}`);
    if (!Array.isArray(latest.files) || !latest.files.length) bad('latest.json files 为空');

    /* ---- 2. 逐文件校验 ---- */
    const declared = new Map();
    for (const e of latest.files || []) {
      declared.set(e.path, e);
      if (!existsSync(abs(e.path))) { bad(`声明了但文件不存在：${e.path}`); continue; }
      const buf = readFileSync(abs(e.path));
      if (buf.length !== e.bytes) bad(`${e.path} 字节数不符：声明 ${e.bytes}，实得 ${buf.length}`);
      const actual = sha256(buf);
      if (actual !== e.sha256) bad(`${e.path} SHA-256 不符：声明 ${e.sha256.slice(0, 16)}…，实得 ${actual.slice(0, 16)}…`);
    }

    /* ---- 6. dist 里没有陈旧的未声明文件 ---- */
    const distRulesDir = abs(`${DIST}/rules`);
    if (existsSync(distRulesDir)) {
      for (const f of readdirSync(distRulesDir)) {
        const rel = `${DIST}/rules/${f}`;
        if (!declared.has(rel)) bad(`dist 里有未声明的陈旧文件：${rel}`);
      }
    } else {
      bad(`${DIST}/rules 目录不存在`);
    }

    /* ---- 3. SHA256SUMS 一致性 ---- */
    const expected = [...declared.values()]
      .map((e) => `${e.sha256}  ${e.path}`)
      .sort((a, b) => a.split('  ')[1].localeCompare(b.split('  ')[1]))
      .join('\n') + '\n';
    for (const p of ['SHA256SUMS.txt', `${DIST}/SHA256SUMS.txt`]) {
      if (!existsSync(abs(p))) { bad(`${p} 不存在`); continue; }
      if (readFileSync(abs(p), 'utf8') !== expected) bad(`${p} 与 latest.json 不一致`);
    }

    /* ---- 4. 人读形态 vs 机读形态 ---- */
    for (const s of RULE_SETS) {
      const txt = abs(`rules/${s.out}.txt`);
      const list = abs(`${DIST}/rules/${s.out}.list`);
      if (!existsSync(txt)) { bad(`rules/${s.out}.txt 不存在`); continue; }
      if (!existsSync(list)) { bad(`${DIST}/rules/${s.out}.list 不存在`); continue; }
      const a = ruleLines(readFileSync(txt, 'utf8'));
      const b = ruleLines(readFileSync(list, 'utf8'));
      if (a.join('\n') !== b.join('\n')) {
        bad(`rules/${s.out}.txt 与 ${DIST}/rules/${s.out}.list 的规则行不一致（人读/机读漂移）`);
      }
      const raw = readFileSync(list, 'utf8');
      if (!/\.list$/.test(list)) bad('后缀校验出错（内部错误）');
      if (!raw.endsWith('\n')) bad(`${DIST}/rules/${s.out}.list 结尾缺换行`);
      const dup = new Set();
      let dupCount = 0;
      for (const line of ruleLines(raw)) { if (dup.has(line)) dupCount++; else dup.add(line); }
      if (dupCount) bad(`${DIST}/rules/${s.out}.list 有 ${dupCount} 条重复规则`);

      /* ---- 8. 生成期断言：manifest 声明的 forbid 条目不得出现 ---- */
      // 判据是「整行」或「域名段」与 forbid 任一条**完全相等**（不做子串匹配），
      // 所以 onedrive.live.com 不会被 live.com 误伤。
      if (Array.isArray(s.forbid) && s.forbid.length) {
        const banned = new Set(s.forbid.map((f) => String(f).trim().toLowerCase()));
        const hits = [];
        for (const line of ruleLines(raw)) {
          const whole = line.trim().toLowerCase();
          if (banned.has(whole) || banned.has(ruleDomain(line))) hits.push(line);
        }
        if (hits.length) {
          bad(
            `${DIST}/rules/${s.out}.list 出现 ${hits.length} 条被 manifest.forbid 禁止的宽口径条目：` +
            `${hits.slice(0, 5).join('、')}${hits.length > 5 ? ' …' : ''}`,
          );
        } else {
          ok(`${DIST}/rules/${s.out}.list 生成期断言通过：未出现 ${s.forbid.length} 条被禁条目`);
        }
      }

      /* ---- 9. 生成期断言：manifest 声明的 extra 条目必须出现 ---- */
      // forbid 的反向断言：上游不提供、由 manifest 注入的补丁规则，必须真的落进产物，
      // 否则「用户要求的域名」会在某次同步后悄悄消失。
      if (Array.isArray(s.extra) && s.extra.length) {
        const present = new Set(ruleLines(raw).map((l) => l.trim().toLowerCase()));
        const missing = s.extra
          .map((e) => String(e).trim())
          .filter((e) => e && !present.has(e.toLowerCase()));
        if (missing.length) {
          bad(
            `${DIST}/rules/${s.out}.list 缺少 ${missing.length} 条 manifest.extra 声明必须存在的规则：` +
            `${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' …' : ''}`,
          );
        } else {
          ok(`${DIST}/rules/${s.out}.list 生成期断言通过：manifest.extra 的 ${s.extra.length} 条注入规则全部在位`);
        }
      }
    }

    /* ---- 8b. onedrive 不得重新并入宽口径 Microsoft.list ---- */
    // 这是上面 forbid 的「源头」版本：产物断言挡的是结果，这条挡的是生成参数。
    const od = RULE_SETS.find((s) => s.out === 'onedrive');
    if (od) {
      const back = [...(od.alsoRuleset || []), ...(od.alsoClash || [])]
        .filter((n) => /^microsoft$/i.test(String(n)));
      if (back.length) {
        bad('manifest 的 onedrive 条目又把 Microsoft 加回了 alsoRuleset/alsoClash（宽口径回灌）');
      } else if (!(od.files || []).includes('OneDrive')) {
        bad('manifest 的 onedrive 条目不再取 Clash/OneDrive.list（白名单本体丢了）');
      } else {
        ok('onedrive 生成参数断言通过：只取 Clash/OneDrive.list，未并入 Microsoft');
      }
    }

    /* ---- 5. geo 两处逐字节一致 ---- */
    for (const g of ['geosite.dat', 'geoip.metadb', 'ASN.mmdb']) {
      const a = abs(`geo/${g}`);
      const b = abs(`${DIST}/geo/${g}`);
      if (!existsSync(a)) { bad(`geo/${g} 不存在`); continue; }
      if (!existsSync(b)) { bad(`${DIST}/geo/${g} 不存在`); continue; }
      if (sha256(readFileSync(a)) !== sha256(readFileSync(b))) bad(`geo/${g} 与 ${DIST}/geo/${g} 不一致`);
    }
    ok(`latest.json v${latest.version}：${latest.files.length} 个文件，全部 SHA-256 相符`);
    ok(`${RULE_SETS.length} 组规则：人读/机读形态一致、无重复、无陈旧文件`);
    ok(`geo 三份：根目录与 ${DIST}/ 逐字节一致`);
  }
}

/* ---- 7. VERSION ---- */
if (!existsSync(abs('VERSION'))) bad('VERSION 不存在');
else {
  const v = readFileSync(abs('VERSION'), 'utf8').trim();
  if (!/^\d+$/.test(v) || Number(v) <= 0) bad(`VERSION 非法：${JSON.stringify(v)}`);
  else ok(`VERSION ${v}`);
}

for (const n of notes) process.stdout.write(`  ok  ${n}\n`);
if (problems.length) {
  process.stdout.write(`\n校验失败，${problems.length} 个问题：\n`);
  for (const p of problems) process.stdout.write(`  FAIL  ${p}\n`);
  process.exit(1);
}
process.stdout.write('\n全部通过\n');
