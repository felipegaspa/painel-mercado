"""Teste de conectividade: busca os 11 tickers do Yahoo e registra código HTTP e erro de cada um."""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TICKERS = [
    "^BVSP", "^GSPC", "^IXIC", "^DJI", "BZ=F", "CL=F",
    "ZS=F", "ZC=F", "CT=F", "USDBRL=X", "EURBRL=X",
]
URL = "https://query1.finance.yahoo.com/v8/finance/chart/{}?range=5y&interval=1d"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"


def probe(ticker):
    url = URL.format(urllib.parse.quote(ticker, safe=""))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    t0 = time.time()
    status, err, pts, nulls, last = None, "", 0, 0, None
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status = resp.status
            body = json.load(resp)
        result = body["chart"]["result"]
        if not result:
            err = f"sem resultado: {body['chart'].get('error')}"
        else:
            closes = result[0]["indicators"]["quote"][0]["close"]
            pts = len(closes)
            nulls = sum(c is None for c in closes)
            last = next((c for c in reversed(closes) if c is not None), None)
    except urllib.error.HTTPError as e:
        status, err = e.code, f"HTTPError {e.code} {e.reason}"
    except Exception as e:  # noqa: BLE001 - queremos registrar qualquer falha
        err = f"{type(e).__name__}: {e}"
    return {
        "ticker": ticker, "http": status, "erro": err or "-",
        "pontos": pts, "nulos": nulls, "ultimo": last,
        "segundos": round(time.time() - t0, 2),
    }


def main():
    rows = []
    for t in TICKERS:
        rows.append(probe(t))
        time.sleep(1)
    header = "| ticker | http | erro | pontos | nulos | último | s |\n|---|---|---|---|---|---|---|"
    lines = [
        f"| {r['ticker']} | {r['http']} | {r['erro']} | {r['pontos']} | {r['nulos']} | {r['ultimo']} | {r['segundos']} |"
        for r in rows
    ]
    table = header + "\n" + "\n".join(lines)
    print(table)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("## Teste Yahoo no GitHub Actions\n\n" + table + "\n")
    failed = [r["ticker"] for r in rows if r["http"] != 200 or r["erro"] != "-"]
    if failed:
        print("FALHARAM:", ", ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
