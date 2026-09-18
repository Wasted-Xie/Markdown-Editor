#!/usr/bin/env python3
"""回归校验：字体栈改动必须是"纯追加"，不得打乱 Windows 原有字体优先级。

背景：项目同时支持 Windows 与 Linux。给 Linux 补字体时，如果把新字体
插到原有字体之间，Windows 上的字体选择就会改变（例如装了 DejaVu Sans Mono
的机器会从 Consolas 切过去）。因此约定：新增字体一律追加到原有栈末尾。

用法：
    python tools/check-font-append.py [base-ref]

    base-ref 默认 main，表示"以 main 为基准检查当前工作区的改动"。

退出码：0 = 全部纯追加；1 = 存在破坏性改动。
"""

import re
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = sys.argv[1] if len(sys.argv) > 1 else "main"
FILES = ["src/styles.css", "src/renderer.ts"]


def split_names(segment: str) -> list[str]:
    """把一段字体声明切成字体名列表。

    兼容两种写法：
      CSS  `"Segoe UI", "Microsoft YaHei", system-ui, sans-serif`
      TS   '"Segoe UI", "Microsoft YaHei", ' + 'system-ui, sans-serif'
    """
    cleaned = segment.replace("'", '"').replace("+", " ")
    names: list[str] = []
    for token in cleaned.split(","):
        # 去掉引号与空白：字体名本身不含引号，直接剔除最稳
        token = token.replace('"', "").strip()
        if token and token not in {"system", "ui"}:
            names.append(token)
    return names


def extract_stacks(text: str) -> list[list[str]]:
    """提取 CSS font-family 与 JS fontFamily 声明中的字体名列表。"""
    stacks: list[list[str]] = []

    # CSS: font-family: ... ;
    for match in re.finditer(r"font-family:\s*([^;]+);", text):
        names = split_names(match.group(1))
        if names:
            stacks.append(names)

    # TS: fontFamily: 后面可能跨多行并用 + 拼接，取到下一个属性名为止
    for match in re.finditer(
        r"fontFamily:\s*((?:[^;}\n]|\n(?!\s*[a-zA-Z]+\s*:))*?)"
        r"(?=,\s*\n\s*[a-zA-Z]+\s*:|\n\s*[a-zA-Z]+\s*:|\n\s*\})",
        text,
        re.S,
    ):
        names = split_names(match.group(1))
        if names:
            stacks.append(names)

    return stacks


def show_diff(ref_text: str, cur_text: str, path: str) -> bool:
    old, new = extract_stacks(ref_text), extract_stacks(cur_text)
    print(f"\n=== {path} ===")

    if len(old) != len(new):
        print(f"  ✗ 声明数量不一致：{BASE} {len(old)} 处，当前 {len(new)} 处")
        return False

    ok = True
    for i, (o, n) in enumerate(zip(old, new), 1):
        positions = [n.index(f) if f in n else -1 for f in o]
        missing = [f for f, p in zip(o, positions) if p < 0]
        ordered = all(positions[j] < positions[j + 1] for j in range(len(positions) - 1))
        appended = [f for f in n if f not in o]

        if missing or not ordered:
            ok = False
            print(f"  ✗ 第 {i} 处")
            print(f"      原: {', '.join(o)}")
            print(f"      新: {', '.join(n)}")
            if missing:
                print(f"      丢失原有字体: {missing}")
            if not ordered:
                print("      原有字体顺序被打乱 —— 会改变 Windows 字体选择")
        else:
            extra = f"  新增: {', '.join(appended)}" if appended else "  无改动"
            print(f"  ✓ 第 {i} 处{extra}")

    return ok


def main() -> int:
    all_ok = True
    for path in FILES:
        ref = subprocess.run(
            ["git", "show", f"{BASE}:{path}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if ref.returncode != 0:
            print(f"跳过 {path}：无法读取 {BASE} 版本（{ref.stderr.strip()}）")
            continue
        try:
            cur = open(path, encoding="utf-8").read()
        except OSError as exc:
            print(f"跳过 {path}：{exc}")
            continue
        if not show_diff(ref.stdout, cur, path):
            all_ok = False

    print("\n" + "=" * 56)
    if all_ok:
        print(f"结论：相对 {BASE} 全部为纯追加，Windows 字体优先级未改变")
        return 0
    print(f"结论：相对 {BASE} 存在破坏性改动，请把新增字体移到栈末尾")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
