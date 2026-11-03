"""Testes da regra do vigia com rodadas inventadas (rodar: python coletor/teste_vigia.py)."""
from datetime import datetime
from vigia import avaliar, TZ


def r(i, inicio_brt, concl="success", branch="main", script=False):
    t = datetime.fromisoformat(inicio_brt + "-03:00").astimezone(TZ).isoformat()
    return {"id": i, "created_at": t, "run_started_at": t, "conclusion": concl, "head_branch": branch,
            "display_title": "Coletar dados · Apps Script" if script else "Coletar dados"}


def a(agora_brt):
    return datetime.fromisoformat(agora_brt + "-03:00").astimezone(TZ)


casos = [
    # (nome, agora, rodadas, ok esperado)
    ("antes das 08:30 não confere", "2026-11-04T08:00", [], True),
    ("sábado não confere", "2026-11-07T10:00", [], True),
    ("rodada às 06:04 cobre", "2026-11-04T09:00", [r(1, "2026-11-04T06:04")], True),
    ("rodada da véspera às 19:37 cobre", "2026-11-04T09:00", [r(1, "2026-11-03T19:37")], True),
    ("rodada que falhou também conta (já avisou por e-mail)", "2026-11-04T09:00", [r(1, "2026-11-04T07:19", "failure")], True),
    ("só rodada da véspera às 13:58: ALERTA", "2026-11-04T09:00", [r(1, "2026-11-03T13:58")], False),
    ("nada desde ontem: ALERTA", "2026-11-04T13:58", [], False),
    ("rodada às 08:35 foi a 1ª depois do prazo e já avisou; esta não repete", "2026-11-04T09:00", [r(1, "2026-11-04T08:35")], True),
    ("rodada cancelada não conta: ALERTA", "2026-11-04T09:00", [r(1, "2026-11-04T07:00", "cancelled")], False),
    ("rodada em outro branch não conta: ALERTA", "2026-11-04T09:00", [r(1, "2026-11-04T07:00", branch="teste")], False),
    ("2ª rodada depois das 08:30 não repete o aviso", "2026-11-04T10:07", [r(1, "2026-11-04T09:37", "failure")], True),
    ("segunda-feira olha a sexta às 17h", "2026-11-09T09:00", [r(1, "2026-11-06T18:07")], True),
    ("segunda-feira sem nada desde sexta 13h: ALERTA", "2026-11-09T09:00", [r(1, "2026-11-06T13:07")], False),
    ("script ativo e rodou às 06:12: ok", "2026-11-04T09:00", [r(1, "2026-11-03T15:12", script=True), r(2, "2026-11-04T06:12", script=True)], True),
    ("script ativo mas só a reserva rodou: ALERTA do script", "2026-11-04T09:00", [r(1, "2026-11-03T15:12", script=True), r(2, "2026-11-04T06:19")], False),
    ("script nunca usado: não exige", "2026-11-04T09:00", [r(2, "2026-11-04T06:19")], True),
    ("a própria rodada não conta", "2026-11-04T09:00", [r(99, "2026-11-04T08:00")], False),
]
erros = 0
for nome, agora, rodadas, esperado in casos:
    ok, msg = avaliar(a(agora), rodadas, esta=99 if nome == "a própria rodada não conta" else 0)
    passou = ok == esperado
    erros += not passou
    print(f"{'PASSOU' if passou else 'FALHOU'}  {nome}: {msg}")
print(f"\n{len(casos) - erros}/{len(casos)} casos passaram")
raise SystemExit(1 if erros else 0)
