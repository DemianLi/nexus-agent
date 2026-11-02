#!/usr/bin/env python3
"""驗證：AgentBench 的 OA 權重有多大的槓桿，vicuna-13b 的 OA 有多少來自 LTP。

主張（章節 07-agent-evaluation.md〈陷阱二〉AgentBench 那一條）：
  OA 的權重是各環境平均分的倒數。LTP 的 Weight⁻¹ 是 3.5、WS 是 30.7，所以 LTP 每 1 分值
  1÷3.5÷8 ≈ 0.036 OA，WS 每 1 分只值 1÷30.7÷8 ≈ 0.004 OA，相差 30.7÷3.5 ≈ 8.8 倍。
  依 Table 3 重算：vicuna-13b 的 LTP 貢獻 8.0÷3.5÷8 ≈ 0.29，佔它 OA 的 0.29÷0.93 ≈ 31%；
  codellama-34b 的 LTP 貢獻只有 0.7÷3.5÷8 ≈ 0.025；兩者 OA 只差 0.96 對 0.93，換算成 LTP 分數，
  (0.96−0.93)×8×3.5 ≈ 0.84 分就足以讓名次對調。
出處：[arXiv:2308.03688]。槓桿比是精讀筆記的 limitations_observed；vicuna-13b 的 31% 與名次
  對調門檻是組章時的重算；「LTP 的自動評估比人評寬鬆，對開源模型尤甚」是筆記的
  limitations_stated。

輸入從哪來（全部由程式從 .cache/text/2308.03688.txt 解析並印出行號，不手抄）：
  - Table 2 的 Weight⁻¹ 列（8 個環境：OS、DB、KG、DCG、LTP、HH、WS、WB）。
  - Table 3 的每一列：模型、版本、OA、8 個環境分數。

方法：
  1. 解析兩張表；斷言 Table 3 有 29 列（正文說評了 29 個模型）。
  2. 自檢：用 OA = (1/8) Σ 分數_i ÷ Weight⁻¹_i 重算每列 OA，和表上的 OA 比；表上只印到小數點後
     兩位，差在 0.01 以內算對得上。這一步確認權重的讀法正確，後面的份額才有意義。
  3. 算槓桿比、vicuna-13b 與 codellama-34b 的 LTP 貢獻與份額、名次對調門檻。
  4. 延伸：把 LTP 從 OA 拿掉（其餘 7 項的平均）後，29 個模型的名次有幾對會對調；列出 LTP 份額
     最高的幾個模型。

沒有用到隨機數。只用標準函式庫。執行：python3 07-agentbench-oa-leverage.py
"""

import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
TXT = os.path.join(ROOT, ".cache", "text", "2308.03688.txt")
ENVS = ["OS", "DB", "KG", "DCG", "LTP", "HH", "WS", "WB"]
NUM = re.compile(r"^\|\s*(-?[0-9]+(?:\.[0-9]+)?)$")


def load_lines():
    with open(TXT, encoding="utf-8") as f:
        return f.read().split("\n")


def find_line(lines, pattern, start=0):
    rx = re.compile(pattern)
    for i in range(start, len(lines)):
        if rx.search(lines[i]):
            return i
    raise SystemExit(f"找不到：{pattern}")


def is_num(s):
    return NUM.match(s.strip()) is not None


def val(s):
    return float(NUM.match(s.strip()).group(1))


def parse(lines):
    iw = find_line(lines, r"^\| Weight-1$")
    w = [val(lines[iw + 1 + k]) for k in range(8)]
    t3 = find_line(lines, r"^Table 3: Test set \(standard\) results of AgentBench")
    t4 = find_line(lines, r"^Table 4:", t3)
    rows = []
    for i in range(t3, t4 - 11):
        s = lines[i].strip()
        if not s.startswith("| ") or is_num(s):
            continue
        # 列 = 名稱｜版本｜OA｜8 個環境；版本可能是 0613 這種數字，所以要求恰好 9 個連續數字格
        run = 0
        while is_num(lines[i + 2 + run]):
            run += 1
        if run == 9:
            name = s.lstrip("|").strip()
            ver = lines[i + 1].strip().lstrip("|").strip()
            nums = [val(lines[i + 2 + k]) for k in range(9)]
            rows.append({"name": name, "ver": ver, "oa": nums[0], "s": nums[1:], "line": i + 1})
    return iw + 1, t3 + 1, w, rows


def main():
    lines = load_lines()
    iw, t3, w, rows = parse(lines)
    print(f"Table 2 的 Weight⁻¹（第 {iw} 行）：" + "、".join(f"{e} {x}" for e, x in zip(ENVS, w)))
    assert w[ENVS.index("LTP")] == 3.5 and w[ENVS.index("WS")] == 30.7
    print(f"Table 3（第 {t3} 行起）：解析到 {len(rows)} 列")
    assert len(rows) == 29, [r["name"] for r in rows]

    # 自檢：重算 OA
    bad = []
    for r in rows:
        r["oa_re"] = sum(x / wi for x, wi in zip(r["s"], w)) / 8
        if abs(r["oa_re"] - r["oa"]) > 0.01 + 1e-9:
            bad.append(f"{r['name']}：表上 {r['oa']}，重算 {r['oa_re']:.3f}")
    print(f"自檢：以 (1/8) Σ 分數 ÷ Weight⁻¹ 重算 OA，{29 - len(bad)}/29 列在 0.01 以內"
          + ("" if not bad else "；對不上：" + "；".join(bad)))
    assert len(bad) <= 2, bad

    li, wi = ENVS.index("LTP"), ENVS.index("WS")
    per_ltp, per_ws = 1 / w[li] / 8, 1 / w[wi] / 8
    print()
    print(f"槓桿：LTP 每 1 分 = 1÷{w[li]}÷8 = {per_ltp:.4f} OA；WS 每 1 分 = 1÷{w[wi]}÷8 = {per_ws:.4f} OA；"
          f"比值 {w[wi]}÷{w[li]} = {w[wi] / w[li]:.2f}")
    print(f"  8 個環境中 Weight⁻¹ 最小的是 {ENVS[w.index(min(w))]}（{min(w)}），最大的是 {ENVS[w.index(max(w))]}（{max(w)}）")

    v = [r for r in rows if r["name"] == "vicuna-13b"][0]
    c = [r for r in rows if r["name"] == "codellama-34b"][0]
    for r in (v, c):
        contrib = r["s"][li] / w[li] / 8
        r["ltp_c"] = contrib
        print(f"  {r['name']}（第 {r['line']} 行）：LTP {r['s'][li]} → 貢獻 {r['s'][li]}÷{w[li]}÷8 = {contrib:.3f}；"
              f"表上 OA {r['oa']}，份額 {contrib:.3f}÷{r['oa']} = {contrib / r['oa']:.1%}（以重算 OA {r['oa_re']:.3f} 計 {contrib / r['oa_re']:.1%}）")
    gap = c["oa"] - v["oa"]
    print(f"  名次對調門檻：({c['oa']}−{v['oa']})×8×{w[li]} = {gap * 8 * w[li]:.2f} 個 LTP 分數")
    gap_re = c["oa_re"] - v["oa_re"]
    print(f"  以重算 OA 計：({c['oa_re']:.3f}−{v['oa_re']:.3f})×8×{w[li]} = {gap_re * 8 * w[li]:.2f} 個 LTP 分數")

    # 延伸：LTP 份額排行與拿掉 LTP 後的名次變化
    for r in rows:
        r["share"] = (r["s"][li] / w[li] / 8) / r["oa_re"] if r["oa_re"] > 0 else 0.0
        r["oa_wo"] = sum(x / wj for k, (x, wj) in enumerate(zip(r["s"], w)) if k != li) / 7
    top = sorted(rows, key=lambda r: -r["share"])[:5]
    print()
    print("LTP 份額最高的 5 個模型：" + "；".join(f"{r['name']} {r['share']:.0%}" for r in top))
    flips = []
    for a in range(len(rows)):
        for b in range(a + 1, len(rows)):
            ra, rb = rows[a], rows[b]
            if (ra["oa_re"] - rb["oa_re"]) * (ra["oa_wo"] - rb["oa_wo"]) < 0:
                flips.append((ra["name"], rb["name"]))
    vc = any({"vicuna-13b", "codellama-34b"} == {x, y} for x, y in flips)
    print(f"拿掉 LTP（其餘 7 項平均）後，29 個模型兩兩之間名次對調的有 {len(flips)} 對（共 {29 * 28 // 2} 對）；"
          f"vicuna-13b 對 codellama-34b {'在其中' if vc else '不在其中'}")
    print(f"  vicuna-13b：OA {v['oa_re']:.3f} → 拿掉 LTP {v['oa_wo']:.3f}；codellama-34b：{c['oa_re']:.3f} → {c['oa_wo']:.3f}")

    print()
    print(f"結論：證實。權重讀法經 {29 - len(bad)}/29 列 OA 重算確認；LTP 與 WS 的槓桿比是 {w[wi] / w[li]:.1f} 倍；"
          f"vicuna-13b 的 OA 有 {v['ltp_c'] / v['oa']:.0%} 來自 LTP（codellama-34b 只有 {c['ltp_c'] / c['oa']:.0%}），"
          f"兩者 OA 差距換算成 {gap * 8 * w[li]:.2f} 個 LTP 分數；拿掉 LTP 後兩者差距從 "
          f"{c['oa_re'] - v['oa_re']:.3f} 變成 {c['oa_wo'] - v['oa_wo']:.3f}。")


if __name__ == "__main__":
    main()
