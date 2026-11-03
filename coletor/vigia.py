"""Vigia: o painel estava atualizado quando o Gustavo abre (07:30 de Cuiabá = 08:30 de Brasília)?

Roda no fim de cada rodada do robô. Em dia útil, a partir das 08:30 de Brasília, confere na API do GitHub
se alguma rodada do robô terminou (com sucesso ou falha) entre 17:00 do dia útil anterior e 08:30 de hoje.
Se nenhuma terminou, sai com erro: a execução fica vermelha e o GitHub manda o e-mail "Run failed".
Avisa uma vez por dia: só a primeira rodada depois das 08:30 confere; as seguintes veem que ela já existe.

Limite conhecido: se o GitHub não entregar NENHUMA rodada, nada roda e nada avisa (ver SPEC, 4.5).
Usa só o GITHUB_TOKEN da própria execução (permissão actions: read), nada fora do GitHub.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Sao_Paulo")
PRAZO = time(8, 30)    # 07:30 em Cuiabá
INICIO = time(17, 0)   # depois da publicação da tarde do Imea e do fechamento do dia anterior


def relogio():
    simulado = os.environ.get("COLETA_AGORA")  # só para teste, o mesmo relógio simulado do coletor
    return datetime.fromisoformat(simulado).astimezone(TZ) if simulado else datetime.now(TZ)


def dia_util_anterior(d):
    d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def quando(texto):
    return datetime.fromisoformat(texto.replace("Z", "+00:00")).astimezone(TZ)


def listar_rodadas(desde):
    repo = os.environ["GITHUB_REPOSITORY"]
    url = (f"https://api.github.com/repos/{repo}/actions/workflows/coletar.yml/runs"
           f"?per_page=100&created=%3E%3D{desde.astimezone(timezone.utc):%Y-%m-%dT%H:%M:%SZ}")
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["workflow_runs"]


def avaliar(agora, rodadas, esta):
    """Retorna (ok, mensagem). Função pura, para dar para testar com rodadas inventadas."""
    if agora.weekday() >= 5 or agora.time() < PRAZO:
        return True, "fora da hora de conferir (só dias úteis, a partir das 08:30 de Brasília)"
    prazo = datetime.combine(agora.date(), PRAZO, TZ)
    inicio = datetime.combine(dia_util_anterior(agora.date()), INICIO, TZ)
    outras = [r for r in rodadas if r["id"] != esta]
    na_janela = [r for r in outras
                 if r.get("conclusion") in ("success", "failure") and r.get("head_branch") == "main"
                 and inicio <= quando(r["run_started_at"]) <= prazo]
    if na_janela:
        r = max(na_janela, key=lambda r: r["run_started_at"])
        return True, f"ok: rodada às {quando(r['run_started_at']):%d/%m %H:%M} (Brasília) atualizou o painel antes das 08:30"
    ja_conferida = [r for r in outras if prazo <= quando(r["created_at"]) < agora]
    if ja_conferida:
        return True, "painel não foi atualizado antes das 08:30, mas uma rodada anterior de hoje já avisou"
    anteriores = [r for r in outras if quando(r["created_at"]) < inicio]
    ultima = (f"a última foi às {quando(max(anteriores, key=lambda r: r['created_at'])['created_at']):%d/%m %H:%M}"
              if anteriores else "nenhuma desde a véspera")
    return False, (f"NENHUMA rodada do robô entre {inicio:%d/%m %H:%M} e {prazo:%d/%m %H:%M} (Brasília); {ultima}. "
                   f"O GitHub não entregou os disparos agendados: às 07:30 de Cuiabá o painel estava com o dado de antes. "
                   f"Esta rodada já atualizou os dados agora.")


def main():
    agora = relogio()
    inicio = datetime.combine(dia_util_anterior(agora.date()), INICIO, TZ)
    rodadas = listar_rodadas(inicio - timedelta(days=4))
    ok, msg = avaliar(agora, rodadas, int(os.environ.get("GITHUB_RUN_ID", 0)))
    print(("OK     " if ok else "ALERTA ") + msg)
    destino = os.environ.get("GITHUB_STEP_SUMMARY")
    if destino:
        with open(destino, "a", encoding="utf-8") as f:
            f.write(f"## Vigia do horário das 07:30 (Cuiabá)\n\n{'✅' if ok else '❌'} {msg}\n")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
