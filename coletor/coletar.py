"""Coletor do painel: Yahoo (via curl), Banco Central SGS (reserva do câmbio) e Imea (navegador headless).

Regras:
- Cada indicador falha de forma independente; um arquivo só é gravado quando a coleta deu certo,
  então uma falha nunca sobrescreve o último dado bom.
- HTTP 403/429 ou página de desafio = fonte bloqueada: paramos aquela fonte e reportamos, sem contornar.
- O estado de cada indicador (último sucesso, falhando desde, erro) fica em data/status.json.
- Modo "auto" (o das execuções agendadas): a rodada decide o que fazer pelo estado, não pelo horário do cron,
  porque o GitHub atrasa e descarta disparos agendados. Yahoo e Banco Central em toda rodada (refazem o
  histórico inteiro); Imea no máximo 2 leituras por dia (ver imea_devida), registradas em data/imea/leituras.json.
"""
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date, datetime, timedelta
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo

UA = "painel-mercado/1.0 (+https://github.com/felipegaspa/painel-mercado)"
TZ = ZoneInfo("America/Sao_Paulo")
RAIZ = Path(__file__).resolve().parent.parent
DADOS = RAIZ / "data"
MARCAS_DESAFIO = re.compile(r"just a moment|cf-chl|captcha|access denied|too many requests|403 forbidden", re.I)

# id, nome, ticker, unidade
YAHOO = [
    ("dolar", "Dólar", "USDBRL=X", "R$"),
    ("ibovespa", "Ibovespa", "^BVSP", "pontos"),
    ("nasdaq", "Nasdaq", "^IXIC", "pontos"),
    ("brent", "Petróleo Brent", "BZ=F", "US$/barril"),
    ("soja_cbot", "Soja (Chicago)", "ZS=F", "US¢/bushel"),
    ("milho_cbot", "Milho (Chicago)", "ZC=F", "US¢/bushel"),
]

# id, nome, código SGS
SGS = [
    ("dolar", "Dólar (venda) — Banco Central", 1),
]

# id, nome, página, título da tabela, local, unidade, observação obrigatória no rodapé
IMEA = [
    ("soja_primavera", "Soja disponível", "indicador-soja", "DISPONÍVEL", "Primavera do Leste", "R$/sc", None),
    ("milho_primavera", "Milho disponível", "indicador-milho", "DISPONÍVEL", "Primavera do Leste", "R$/sc", None),
    ("boi_cuiaba", "Boi gordo à vista", "indicador-boi", "BOI GORDO À VISTA", "Cuiabá", "R$/@", "Boi comum, sem premiação China"),
    # Médias de MT: séries separadas, nunca emendadas nas de cidade (linha "Mato Grosso" da mesma tabela)
    ("soja_mt", "Soja disponível", "indicador-soja", "DISPONÍVEL", "Mato Grosso", "R$/sc", None),
    ("milho_mt", "Milho disponível", "indicador-milho", "DISPONÍVEL", "Mato Grosso", "R$/sc", None),
    ("boi_mt", "Boi gordo à vista", "indicador-boi", "BOI GORDO À VISTA", "Mato Grosso", "R$/@", "Boi comum, sem premiação China"),
]


class FonteBloqueada(Exception):
    pass


class FalhaColeta(Exception):
    pass


def relogio():
    """Hora de Brasília. COLETA_AGORA (ISO, ex. 2026-11-03T07:00-03:00) simula o relógio — só para teste."""
    simulado = os.environ.get("COLETA_AGORA")
    return datetime.fromisoformat(simulado).astimezone(TZ) if simulado else datetime.now(TZ)


def agora():
    return relogio().isoformat(timespec="seconds")


def ler_json(caminho, padrao):
    try:
        return json.loads(caminho.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return padrao


def gravar_json(caminho, obj, compacto=True):
    caminho.parent.mkdir(parents=True, exist_ok=True)
    tmp = caminho.with_suffix(".tmp")
    texto = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) if compacto else json.dumps(obj, ensure_ascii=False, indent=2)
    tmp.write_text(texto + "\n", encoding="utf-8")
    os.replace(tmp, caminho)


def curl(url):
    """Retorna (código HTTP, corpo). Levanta FonteBloqueada em 403/429."""
    r = subprocess.run(
        ["curl", "-sS", "-L", "-m", "40", "-A", UA, "-w", "\n%{http_code}", url],
        capture_output=True, timeout=60,
    )
    if r.returncode != 0:
        raise FalhaColeta(f"curl saiu com {r.returncode}: {r.stderr.decode(errors='replace').strip()}")
    corpo, _, codigo = r.stdout.rpartition(b"\n")
    codigo = int(codigo or 0)
    texto = corpo.decode("utf-8", errors="replace")
    if codigo in (403, 429):
        raise FonteBloqueada(f"HTTP {codigo}: {texto[:200]!r}")
    if codigo != 200:
        raise FalhaColeta(f"HTTP {codigo}: {texto[:200]!r}")
    return texto


def validar_serie(serie, max_atraso_dias=10, minimo=200):
    if len(serie) < minimo:
        raise FalhaColeta(f"série curta demais ({len(serie)} pontos)")
    ultima = date.fromisoformat(serie[-1][0])
    if ultima < date.today() - timedelta(days=max_atraso_dias):
        raise FalhaColeta(f"último dado é de {ultima}, velho demais")
    if any(v <= 0 for _, v in serie):
        raise FalhaColeta("valor não positivo na série")


# ---------- Yahoo ----------

def coletar_yahoo(ident, nome, ticker, unidade):
    from urllib.parse import quote
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(ticker, safe='')}?range=5y&interval=1d"
    texto = curl(url)
    try:
        dados = json.loads(texto)
    except json.JSONDecodeError:
        if MARCAS_DESAFIO.search(texto):
            raise FonteBloqueada(f"página de desafio no lugar do JSON: {texto[:200]!r}")
        raise FalhaColeta(f"resposta não é JSON: {texto[:200]!r}")
    resultado = (dados.get("chart") or {}).get("result")
    if not resultado:
        raise FalhaColeta(f"sem resultado: {(dados.get('chart') or {}).get('error')}")
    r = resultado[0]
    meta = r["meta"]
    fuso = ZoneInfo(meta["exchangeTimezoneName"])
    fechamentos = r["indicators"]["quote"][0]["close"]
    por_dia = {}
    for ts, c in zip(r["timestamp"], fechamentos):
        if c is None:  # linhas-fantasma (ex.: fins de semana do algodão)
            continue
        por_dia[datetime.fromtimestamp(ts, fuso).date().isoformat()] = round(c, 4)
    serie = sorted(por_dia.items())
    validar_serie(serie)
    return {
        "id": ident, "nome": nome, "ticker": ticker, "unidade": unidade,
        "moeda": meta.get("currency"),
        "fonte": "Yahoo Finance (não oficial)",
        "atual": {
            "valor": meta.get("regularMarketPrice"),
            "horario": datetime.fromtimestamp(meta["regularMarketTime"], TZ).isoformat(timespec="seconds"),
        },
        "coletado_em": agora(),
        "serie": [list(p) for p in serie],
    }


# ---------- Banco Central SGS ----------

def coletar_sgs(ident, nome, codigo):
    hoje = date.today()
    inicio = hoje.replace(year=hoje.year - 5)
    url = (f"https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo}/dados?formato=json"
           f"&dataInicial={inicio:%d/%m/%Y}&dataFinal={hoje:%d/%m/%Y}")
    texto = curl(url)
    try:
        linhas = json.loads(texto)
    except json.JSONDecodeError:
        raise FalhaColeta(f"resposta não é JSON: {texto[:200]!r}")
    serie = [
        (datetime.strptime(l["data"], "%d/%m/%Y").date().isoformat(), float(l["valor"]))
        for l in linhas
    ]
    validar_serie(serie)
    return {
        "id": ident, "nome": nome, "codigo_sgs": codigo, "unidade": "R$",
        "fonte": "Banco Central do Brasil (SGS)",
        "rotulo": "Reserva — fechamento diário oficial; série separada do Yahoo",
        "coletado_em": agora(),
        "serie": [list(p) for p in serie],
    }


# ---------- Imea ----------

class _Texto(HTMLParser):
    def __init__(self):
        super().__init__()
        self.linhas, self._pular = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._pular += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._pular:
            self._pular -= 1

    def handle_data(self, data):
        t = " ".join(data.split())
        if t and not self._pular:
            self.linhas.append(t)


def chrome():
    if os.environ.get("CHROME_BIN"):
        return os.environ["CHROME_BIN"]
    for nome in ("google-chrome", "chromium", "chromium-browser"):
        if shutil.which(nome):
            return nome
    raise FalhaColeta("navegador headless não encontrado")


@lru_cache(maxsize=None)  # cada página é aberta uma vez por execução, mesmo servindo várias séries
def ler_pagina_imea(pagina):
    r = subprocess.run(
        [chrome(), "--headless=new", "--disable-gpu", "--no-sandbox", f"--user-agent={UA}",
         "--virtual-time-budget=15000", "--dump-dom", f"https://www.imea.com.br/imea-site/{pagina}"],
        capture_output=True, timeout=120,
    )
    html = r.stdout.decode("utf-8", errors="replace")
    titulo = re.search(r"<title>([^<]*)", html, re.I)
    titulo = titulo.group(1).strip() if titulo else ""
    if MARCAS_DESAFIO.search(titulo) or MARCAS_DESAFIO.search(html[:5000]):
        raise FonteBloqueada(f"página de bloqueio/desafio (título: {titulo!r})")
    if len(html) < 5000:
        raise FalhaColeta(f"página vazia ou incompleta ({len(html)} bytes, título {titulo!r})")
    p = _Texto()
    p.feed(html)
    return tuple(p.linhas)


def numero_br(s):
    return float(s.replace(".", "").replace(",", "."))


def extrair_imea(linhas, titulo, local, observacao):
    try:
        ini = next(i for i, l in enumerate(linhas) if l.upper() == titulo)
    except StopIteration:
        raise FalhaColeta(f"tabela {titulo!r} não encontrada (página mudou?)")
    try:
        fim = next(j for j in range(ini + 1, len(linhas)) if re.search(r"\bData:", linhas[j]))
    except StopIteration:
        raise FalhaColeta(f"rodapé com data da tabela {titulo!r} não encontrado")
    try:
        c = next(k for k in range(ini + 1, fim) if linhas[k] == local)
    except StopIteration:
        raise FalhaColeta(f"{local!r} não está na tabela {titulo!r}")
    try:
        valor, variacao = numero_br(linhas[c + 1]), numero_br(linhas[c + 2])
    except (ValueError, IndexError):
        raise FalhaColeta(f"valor ilegível para {local!r}: {linhas[c + 1:c + 3]}")
    if valor <= 0:
        raise FalhaColeta(f"valor não positivo para {local!r}: {valor}")
    rodape = " ".join(linhas[fim:fim + 2])
    m = re.search(r"Data:\s*(\d{2}/\d{2}/\d{4})", rodape)
    if not m:
        raise FalhaColeta(f"data ilegível no rodapé: {rodape!r}")
    if observacao and observacao.lower() not in linhas[fim].lower():
        raise FalhaColeta(f"rótulo esperado {observacao!r} não está no rodapé: {linhas[fim]!r}")
    return valor, variacao, datetime.strptime(m.group(1), "%d/%m/%Y").date().isoformat()


def coletar_imea(ident, nome, pagina, titulo, local, unidade, observacao):
    valor, variacao, dia = extrair_imea(ler_pagina_imea(pagina), titulo, local, observacao)
    caminho = DADOS / "imea" / f"{ident}.json"
    atual = ler_json(caminho, {})
    serie = {r["data"]: r for r in atual.get("serie", [])}
    existente = serie.get(dia)
    if not (existente and existente["valor"] == valor and existente.get("variacao_pct") == variacao):
        serie[dia] = {"data": dia, "valor": valor, "variacao_pct": variacao, "coletado_em": agora(), "origem": "site Imea"}
    return {
        "id": ident, "nome": nome, "local": local,
        "tipo": "media_estadual" if local == "Mato Grosso" else "cidade",
        "unidade": unidade,
        "observacao": observacao,
        "fonte": "Imea — Instituto Mato-grossense de Economia Agropecuária",
        "coletado_em": agora(),
        "serie": [serie[d] for d in sorted(serie)],
    }


# ---------- orquestração ----------

def sem_horario_de_coleta(obj):
    """Compara dados ignorando só o horário da coleta, para não gerar commit sem dado novo."""
    return {k: v for k, v in obj.items() if k != "coletado_em"}


def rodar_fonte(nome_fonte, itens, coletar, status):
    bloqueio = None
    for item in itens:
        ident = item[0]
        chave = f"{nome_fonte}/{ident}"
        st = status.setdefault(chave, {})
        if bloqueio:
            erro = f"não tentado: fonte bloqueada nesta execução ({bloqueio})"
        else:
            try:
                novo = coletar(*item)
                caminho = DADOS / nome_fonte / f"{ident}.json"
                mudou = sem_horario_de_coleta(novo) != sem_horario_de_coleta(ler_json(caminho, {}))
                if mudou:
                    gravar_json(caminho, novo)
                st.update(ok=True, erro=None, falhando_desde=None)
                print(f"OK     {chave} ({'atualizado' if mudou else 'sem mudança'})")
                continue
            except FonteBloqueada as e:
                bloqueio = erro = f"BLOQUEADO: {e}"
            except Exception as e:  # noqa: BLE001 - cada indicador falha sozinho
                erro = f"{type(e).__name__}: {e}"
        st.update(ok=False, erro=erro)
        st["falhando_desde"] = st.get("falhando_desde") or agora()
        print(f"FALHA  {chave}: {erro}")


def resumo(status):
    linhas = ["| indicador | ok | erro |", "|---|---|---|"]
    for chave, st in status.items():
        linhas.append(f"| {chave} | {'✅' if st.get('ok') else '❌'} | {st.get('erro') or ''} |")
    texto = "\n".join(linhas)
    destino = os.environ.get("GITHUB_STEP_SUMMARY")
    if destino:
        with open(destino, "a", encoding="utf-8") as f:
            f.write("## Coleta\n\n" + texto + "\n")


# ---------- decisão por estado (modo auto) ----------

LEITURAS_IMEA = DADOS / "imea" / "leituras.json"
TARDE = 17  # a partir das 17h a 2ª leitura do dia pega a publicação da tarde do Imea


def imea_devida(momento, leituras):
    """No máximo 2 leituras por dia: a 1ª na primeira rodada que chegar; a 2ª só a partir das 17h,
    e só se a 1ª foi antes das 17h (se a 1ª já foi à tarde, ela já pegou a publicação da tarde)."""
    hoje = [datetime.fromisoformat(t) for t in leituras if t[:10] == momento.date().isoformat()]
    if not hoje:
        return True
    return len(hoje) == 1 and momento.hour >= TARDE and hoje[0].hour < TARDE


def registrar_leitura_imea(momento):
    """Guarda só as leituras de hoje e de ontem (o suficiente para decidir)."""
    ontem = (momento.date() - timedelta(days=1)).isoformat()
    antigas = ler_json(LEITURAS_IMEA, {}).get("leituras", [])
    leituras = [t for t in antigas if t[:10] >= ontem] + [momento.isoformat(timespec="seconds")]
    gravar_json(LEITURAS_IMEA, {"leituras": leituras}, compacto=False)


def decidir(momento):
    fontes = ["yahoo", "sgs"]
    if imea_devida(momento, ler_json(LEITURAS_IMEA, {}).get("leituras", [])):
        fontes.append("imea")
    return fontes


FONTES = {
    "yahoo": (YAHOO, coletar_yahoo),
    "sgs": (SGS, coletar_sgs),
    "imea": (IMEA, coletar_imea),
}


def main():
    """Uso: coletar.py auto  |  coletar.py [yahoo] [sgs] [imea]  (sem argumentos = auto)."""
    momento = relogio()
    pedidas = sys.argv[1:] or ["auto"]
    escolhidas = decidir(momento) if pedidas == ["auto"] else pedidas
    print(f"Rodada de {momento:%d/%m/%Y %H:%M} ({'auto' if pedidas == ['auto'] else 'manual'}): {' '.join(escolhidas)}")
    desconhecidas = [f for f in escolhidas if f not in FONTES]
    if desconhecidas:
        sys.exit(f"fonte desconhecida: {', '.join(desconhecidas)}")
    caminho_status = DADOS / "status.json"
    antigo = ler_json(caminho_status, {})
    # O status guarda só o que muda quando a situação muda (nada de horário de tentativa).
    # Só ficam no status os indicadores que ainda são coletados (os descartados saem sozinhos).
    conhecidas = {f"{nome}/{item[0]}" for nome, (itens, _) in FONTES.items() for item in itens}
    status = {
        chave: {c: st.get(c) for c in ("ok", "erro", "falhando_desde")}
        for chave, st in antigo.get("indicadores", {}).items() if chave in conhecidas
    }
    for nome in escolhidas:
        itens, coletar = FONTES[nome]
        if nome == "imea":
            registrar_leitura_imea(momento)  # conta a tentativa, mesmo se falhar: o limite é de carga no site
        rodar_fonte(nome, itens, coletar, status)
    novo = {"indicadores": status}
    if novo != antigo:
        gravar_json(caminho_status, novo, compacto=False)
    resumo(status)
    # Só as fontes desta execução decidem se ela falhou; uma falha antiga de outra fonte não conta.
    if not all(st["ok"] for chave, st in status.items() if chave.split("/")[0] in escolhidas):
        sys.exit(1)


if __name__ == "__main__":
    main()
