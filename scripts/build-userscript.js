#!/usr/bin/env node
/**
 * 构建油猴脚本：把 docs/core.js 内联进 userscript/src.user.js，
 * 生成可直接安装的 userscript/jingcai.user.js
 * 用法： node scripts/build-userscript.js   （或 npm run build:userscript）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'docs', 'core.js');
const SRC = path.join(ROOT, 'userscript', 'src.user.js');
const OUT = path.join(ROOT, 'userscript', 'jingcai.user.js');
const MARK = '// [[CORE]]';

const core = fs.readFileSync(CORE, 'utf8');
const src = fs.readFileSync(SRC, 'utf8');

if (!src.includes(MARK)) {
  console.error('错误：userscript/src.user.js 中缺少 ' + MARK + ' 标记');
  process.exit(1);
}

const banner = '/* ===== 以下为 docs/core.js 内联内容（构建生成，请勿手改本文件；改 core.js 后重新构建） ===== */\n';
const out = src.replace(MARK, banner + core);

// 语法校验
try {
  new Function(out);
} catch (e) {
  console.error('生成失败：合并结果存在语法错误 — ' + e.message);
  process.exit(1);
}

fs.writeFileSync(OUT, out, 'utf8');
console.log('已生成 ' + path.relative(ROOT, OUT) + '（' + out.length + ' 字符）');
