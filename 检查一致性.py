#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CC Sessions Hub 一致性检查器 —— 本仓文件改动后由 hook 优先调用。

用法：python3 检查一致性.py [项目根] [--focus 文件] [--edit-pair old new]
     本器做全仓检查；--focus / --edit-pair 仅作兼容接收（hook 会带它们调用，
     不认参数会触发 hook 回退到通用检查器）。

检查三类：
  1. 客户端 ↔ 宿主路由契约（🔴）—— client.js 里拼出的每个 /_ccpanel/* 路径，
     宿主必须有一处字面量处理它。拼错端点是最容易静默失效的一类改动。
  2. package.json files 清单（🔴）—— 列出的每个通配/文件实际存在；根上、
     host/、scripts/、locale/ 下该发布的文件都被清单覆盖。
  3. README 结构段落（🟡）—— host/ 下每个模块都在「结构：」代码块里有一行。

不查什么（有意为之）：
  · 旧说法残留 / 数字一致性 —— 通用检查.py 的这两条是给「文档」用的：它把
    所有文件默认判为文档，扫 JS 时会把 `一次最多 6 个会话`（建队上限）和
    `200 条 id`（批量上限）当成同一名词下的数字冲突，属结构性误报。
    代码仓的"说法一致性"由本器第 1 条（路由契约）承担。
  · 语体（破折号、口语词）—— 由 style-check.sh 管，且只该管正式材料。

设计原则：机械可检的事不靠记性。只报能证明的，不猜。
"""

import json
import os
import re
import sys

ROOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else os.getcwd()
PATH_RE = re.compile(r'/_ccpanel(?:/[a-z0-9-]+)*')
CONST_RE = re.compile(r"const\s+([A-Z_]+)\s*=\s*'(/_ccpanel[^']*)'")


def read(path):
    try:
        return open(path, encoding='utf-8', errors='ignore').read()
    except OSError:
        return ''


def client_paths():
    """Resolve every /_ccpanel path client.js can build with known constants."""
    text = read(os.path.join(ROOT, 'client.js'))
    consts = dict(CONST_RE.findall(text))
    # `${ENDPOINT.replace('/sessions', '')}` is a prefix trim, not a new route.
    for name, value in consts.items():
        text = text.replace("${%s.replace('/sessions', '')}" % name, value.rsplit('/', 1)[0])
        text = text.replace('${%s}' % name, value)
    return {match.rstrip('/') for match in PATH_RE.findall(text)}


def host_paths():
    """Every /_ccpanel literal the host dispatches on."""
    paths = set()
    sources = [os.path.join(ROOT, 'index.js')]
    host_dir = os.path.join(ROOT, 'host')
    if os.path.isdir(host_dir):
        sources += [os.path.join(host_dir, name) for name in sorted(os.listdir(host_dir)) if name.endswith('.js')]
    for path in sources:
        paths |= set(PATH_RE.findall(read(path)))
    return {path.rstrip('/') for path in paths}


def check_routes(errors, checked):
    client = client_paths()
    host = host_paths()
    checked.append(f'客户端端点 {len(client)} 个 / 宿主端点 {len(host)} 个')
    # Host literals are the source of truth; a prefix registration covers its
    # exact path only — handlers below it spell their own full path.
    for path in sorted(client):
        if path not in host:
            errors.append(f'【路由】client.js 调用 {path}，宿主没有对应处理分支')


def check_files(errors, notes):
    pkg_path = os.path.join(ROOT, 'package.json')
    try:
        pkg = json.loads(read(pkg_path))
    except Exception as cause:
        errors.append(f'【打包】package.json 解析失败：{cause}')
        return
    listed = pkg.get('files') or []
    if not listed:
        errors.append('【打包】package.json 缺少 files 清单')
        return

    def matches(entry):
        if '*' in entry:
            prefix, _, suffix = entry.partition('*')
            directory = os.path.join(ROOT, prefix.rstrip('/')) if prefix not in ('', '/') else ROOT
            if not os.path.isdir(directory):
                return []
            return [name for name in os.listdir(directory) if name.endswith(suffix.lstrip('*'))]
        return [entry] if os.path.exists(os.path.join(ROOT, entry)) else []

    for entry in listed:
        if not matches(entry):
            errors.append(f'【打包】files 里的 {entry} 没有匹配到任何文件')

    def covered(rel):
        for entry in listed:
            if '*' not in entry and entry == rel:
                return True
            if '*' in entry:
                prefix, _, suffix = entry.partition('*')
                if rel.startswith(prefix) and rel.endswith(suffix.lstrip('*')) and '/' not in rel[len(prefix):].lstrip('/').rstrip('/'):
                    return True
                # host/*.js: prefix 'host/', suffix '.js'
                if rel.startswith(prefix) and rel.endswith(suffix.lstrip('*')) and prefix in rel:
                    return True
        return False

    shipped = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md']
    for directory, suffix in (('host', '.js'), ('scripts', '.mjs'), ('locale', '.json')):
        full = os.path.join(ROOT, directory)
        if os.path.isdir(full):
            shipped += [f'{directory}/{name}' for name in sorted(os.listdir(full)) if name.endswith(suffix)]
    for rel in shipped:
        if not covered(rel):
            errors.append(f'【打包】{rel} 没有被 package.json files 覆盖（发布时会漏）')
    notes.append(f'打包清单 {len(listed)} 条，覆盖 {len(shipped)} 个应发布文件')


def check_readme(errors, notes):
    readme = read(os.path.join(ROOT, 'README.md'))
    host_dir = os.path.join(ROOT, 'host')
    if not readme or not os.path.isdir(host_dir):
        return
    block = re.search(r'结构：\s*```(.*?)```', readme, re.S)
    if not block:
        errors.append('【README】找不到「结构：」代码块，模块清单无法核对')
        return
    missing = [name for name in sorted(os.listdir(host_dir))
               if name.endswith('.js') and name not in block.group(1)]
    if missing:
        errors.append('【README】host/ 模块未在「结构：」里登记：' + '、'.join(missing))
    notes.append(f'README 模块清单覆盖 host/ {len(os.listdir(host_dir))} 个文件')


def main():
    if not os.path.exists(os.path.join(ROOT, 'package.json')):
        sys.exit(f'找不到项目根（package.json）：{ROOT}')
    errors, notes, checked = [], [], []
    check_routes(errors, checked)
    check_files(errors, notes)
    check_readme(errors, notes)

    print(f'CC Sessions Hub 一致性检查：{ROOT}')
    for line in checked + notes:
        print(f'  · {line}')
    print()

    if errors:
        print(f'🔴 必须修（{len(errors)} 项）')
        for error in errors:
            print('  ' + error)
        print()
        print('（🔴 必须改完再继续——路由要能对上、发布文件不能漏）')
        return 1
    print('✅ 全部通过（客户端端点全部有宿主分支、打包清单完整、README 模块已登记）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
