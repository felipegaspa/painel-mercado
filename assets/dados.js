/* Lógica de dados do painel: pura, roda no navegador e no Node (para teste). */
(function (root) {
  'use strict';
  const DIA = 86400000;
  const ms = (iso) => Date.parse(iso + 'T00:00:00Z');
  const iso = (t) => new Date(t).toISOString().slice(0, 10);

  // ---- Configuração ----------------------------------------------------
  const LIMITE_BURACO_DIAS = 10; // linha interrompida acima disso (dias corridos)
  const TOLERANCIA_DIAS = 7; // 12 meses e botões de período
  const FAIXA_DADOS_VELHOS_DIAS = 4; // cotação do dólar do Yahoo mais velha que isso

  // Ordem pedida: dólar, Ibovespa, Nasdaq, petróleo, Chicago, Mato Grosso.
  const ORDEM = ['cambio', 'bolsas', 'energia', 'chicago', 'agro'];
  const SECOES = {
    cambio: { titulo: 'Câmbio', fonte: 'Yahoo Finance · PTAX: Banco Central' },
    bolsas: { titulo: 'Bolsas', fonte: 'Yahoo Finance' },
    energia: { titulo: 'Energia', fonte: 'Yahoo Finance' },
    chicago: { titulo: 'Chicago', fonte: 'Yahoo Finance' },
    agro: { titulo: 'Agro MT', fonte: 'Imea' },
  };

  // semDia: contratos futuros (o Yahoo troca de contrato no vencimento e a variação do dia sairia errada).
  const IND = [
    { id: 'dolar', secao: 'cambio', nome: 'Dólar', arq: 'yahoo/dolar', bc: 'sgs/dolar', casas: 2, pre: 'R$ ', unid: 'R$' },
    { id: 'ibovespa', secao: 'bolsas', nome: 'Ibovespa', arq: 'yahoo/ibovespa', casas: 0, pre: '', unid: 'pontos' },
    { id: 'nasdaq', secao: 'bolsas', nome: 'Nasdaq', arq: 'yahoo/nasdaq', casas: 0, pre: '', unid: 'pontos' },
    { id: 'brent', secao: 'energia', nome: 'Petróleo Brent', arq: 'yahoo/brent', casas: 2, pre: 'US$ ', unid: 'US$/barril', semDia: true },
    { id: 'soja_cbot', secao: 'chicago', nome: 'Soja', local: 'Chicago', arq: 'yahoo/soja_cbot', escala: 0.01, casas: 2, pre: 'US$ ', unid: 'US$/bushel', semDia: true },
    { id: 'milho_cbot', secao: 'chicago', nome: 'Milho', local: 'Chicago', arq: 'yahoo/milho_cbot', escala: 0.01, casas: 2, pre: 'US$ ', unid: 'US$/bushel', semDia: true },
    { id: 'soja_mt', secao: 'agro', nome: 'Soja', local: 'Primavera do Leste', arq: 'imea/soja_primavera', media: 'imea/soja_mt', casas: 2, pre: 'R$ ', unid: 'R$/sc' },
    { id: 'milho_mt', secao: 'agro', nome: 'Milho', local: 'Primavera do Leste', arq: 'imea/milho_primavera', media: 'imea/milho_mt', casas: 2, pre: 'R$ ', unid: 'R$/sc' },
    { id: 'boi_mt', secao: 'agro', nome: 'Boi gordo à vista', local: 'Cuiabá', obs: 'Boi comum, sem premiação China', arq: 'imea/boi_cuiaba', media: 'imea/boi_mt', casas: 2, pre: 'R$ ', unid: 'R$/@' },
  ];

  // ---- Formatação pt-BR ------------------------------------------------
  const nf = {};
  function fmtNum(v, casas) {
    const f = nf[casas] || (nf[casas] = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }));
    return f.format(v);
  }
  const fmtPct = (r) => (r >= 0 ? '+' : '−') + fmtNum(Math.abs(r) * 100, 2) + '%';
  const fmtDM = (i) => i.slice(8, 10) + '/' + i.slice(5, 7);
  const fmtDMA = (i) => i.slice(8, 10) + '/' + i.slice(5, 7) + '/' + i.slice(0, 4);
  const fmtMA = (i) => i.slice(5, 7) + '/' + i.slice(0, 4);

  // ---- Séries ----------------------------------------------------------
  function pontos(raw, escala) {
    if (Array.isArray(raw.serie[0])) return raw.serie.map(([d, v]) => [ms(d), v * (escala || 1)]);
    return raw.serie.map((r) => [ms(r.data), r.valor]);
  }

  function addMeses(t, n) {
    const d = new Date(t);
    const dia = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const ult = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(dia, ult));
    return d.getTime();
  }

  // Ponto mais próximo até 7 dias ANTES da data-alvo; senão null.
  function var12m(s, fimT, valor) {
    const alvo = addMeses(fimT, -12);
    let melhor = null;
    for (const p of s) if (p[0] <= alvo && p[0] >= alvo - TOLERANCIA_DIAS * DIA) melhor = p;
    return melhor ? { r: valor / melhor[1] - 1, ref: iso(melhor[0]) } : null;
  }

  function ultimosDias(s, dias) {
    const corte = s[s.length - 1][0] - dias * DIA;
    return s.filter((p) => p[0] >= corte);
  }

  // Divide em trechos onde nenhum salto passa de `max` dias corridos.
  function trechos(s, max) {
    const out = [];
    let at = [];
    for (let i = 0; i < s.length; i++) {
      if (i && s[i][0] - s[i - 1][0] > (max || LIMITE_BURACO_DIAS) * DIA) { out.push(at); at = []; }
      at.push(s[i]);
    }
    if (at.length) out.push(at);
    return out;
  }
  const buracos = (s, max) => {
    const o = [];
    for (let i = 1; i < s.length; i++) {
      const d = (s[i][0] - s[i - 1][0]) / DIA;
      if (d > (max || LIMITE_BURACO_DIAS)) o.push({ de: iso(s[i - 1][0]), ate: iso(s[i][0]), dias: d });
    }
    return o;
  };
  // Para gráficos que ligam tudo: insere y=null no meio do buraco.
  function comNulos(s, max) {
    const o = [];
    for (let i = 0; i < s.length; i++) {
      if (i && s[i][0] - s[i - 1][0] > (max || LIMITE_BURACO_DIAS) * DIA) o.push([(s[i][0] + s[i - 1][0]) / 2, null]);
      o.push(s[i]);
    }
    return o;
  }

  const RANGES = { '1M': 1, '3M': 3, '6M': 6, '1A': 12, '5A': 60 };
  function periodo(s, chave) {
    const fim = s[s.length - 1][0];
    const ini = addMeses(fim, -RANGES[chave]);
    const desde = iso(s[0][0]);
    return { ini, fim, desde, ok: s[0][0] <= ini + TOLERANCIA_DIAS * DIA, fatia: s.filter((p) => p[0] >= ini) };
  }

  // ---- Resumo de um indicador -----------------------------------------
  const hojeBRT = (agora) => iso(agora - 3 * 3600000);
  // Fuso do navegador (sem timeZone fixo): quem abre em Cuiabá vê a hora de Cuiabá.
  const horaLocal = (t) => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(t);
  const diaLocal = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  function resumirSerie(raw, escala, ehYahoo, agora) {
    const s = pontos(raw, escala);
    const n = s.length;
    const ult = s[n - 1];
    let valor = ult[1], dataRef = iso(ult[0]), prev = s[n - 2] || null, rotulo, hora = null;
    if (ehYahoo && raw.atual && raw.atual.valor != null) {
      valor = raw.atual.valor * (escala || 1);
      const dAt = raw.atual.horario.slice(0, 10);
      // Hora mostrada no fuso do navegador de quem abre; a lógica de datas segue em Brasília.
      const tAt = Date.parse(raw.atual.horario);
      hora = horaLocal(tAt);
      dataRef = dAt;
      // O último ponto do histórico é a barra do dia, ainda parcial: a base é o ponto anterior.
      prev = iso(ult[0]) >= dAt ? s[n - 2] : ult;
      rotulo = diaLocal(tAt) === diaLocal(agora) ? 'cotação das ' + hora : 'cotação de ' + fmtDM(diaLocal(tAt)) + ' às ' + hora;
    } else {
      rotulo = (ehYahoo ? 'fechamento de ' : 'dado de ') + fmtDM(dataRef);
    }
    const fimT = ms(dataRef);
    return {
      s, valor, dataRef, hora, rotulo,
      prev: prev ? { data: iso(prev[0]), valor: prev[1] } : null,
      varDia: prev ? valor / prev[1] - 1 : null,
      var12: var12m(s, fimT, valor),
      desde: iso(s[0][0]),
    };
  }

  const AVISO_DIAS = { yahoo: 4, bc: 4, imea: 10 }; // só na página; o coletor não muda
  function atrasado(dataIso, agora, limite) { return (ms(hojeBRT(agora)) - ms(dataIso)) / DIA > limite ? 'sem novo dado desde ' + fmtDM(dataIso) : null; }

  function montar(def, raws, status, agora) {
    const st = (k) => (status.indicadores && status.indicadores[k]) || { ok: true };
    const r = resumirSerie(raws[def.arq], def.escala, def.arq.startsWith('yahoo/'), agora);
    const out = Object.assign({}, def, r, { status: st(def.arq), pontosSpark: ultimosDias(r.s, 90) });
    out.aviso = atrasado(r.dataRef, agora, def.arq.startsWith('imea/') ? AVISO_DIAS.imea : AVISO_DIAS.yahoo);
    if (def.media) {
      out.mediaRes = resumirSerie(raws[def.media], 1, false, agora);
      out.mediaRes.aviso = atrasado(out.mediaRes.dataRef, agora, AVISO_DIAS.imea);
      out.mediaStatus = st(def.media);
    }
    if (def.bc) {
      // PTAX do BC: série própria, usada no sparkline e no gráfico grande; nunca emendada ao Yahoo.
      const b = pontos(raws[def.bc], 1);
      const u = b[b.length - 1];
      out.bcRes = { valor: u[1], data: iso(u[0]), s: b, aviso: atrasado(iso(u[0]), agora, AVISO_DIAS.bc) };
      out.bcStatus = st(def.bc);
      out.sGrande = b;
      out.pontosSpark = ultimosDias(b, 90);
      // Variação do dia do câmbio: só PTAX, último ponto contra o anterior.
      out.varDia = b.length > 1 ? u[1] / b[b.length - 2][1] - 1 : null;
      out.varDiaRotulo = 'PTAX BC vs dia anterior (' + fmtDM(iso(u[0])) + ')';
    }
    return out;
  }

  // Faixa global: dólar do Yahoo com cotação mais velha que 4 dias corridos.
  function dadosVelhos(raws, agora, status) {
    const st = status && status.indicadores && status.indicadores['yahoo/dolar'];
    if (st && st.ok === false) return null; // dólar já aparece cinza; a faixa não repete
    const t = Date.parse(raws['yahoo/dolar'].atual.horario);
    const dias = (agora - t) / DIA;
    return dias > FAIXA_DADOS_VELHOS_DIAS ? { desde: raws['yahoo/dolar'].atual.horario.slice(0, 10), dias } : null;
  }

  const api = {
    DIA, ms, iso, ORDEM, SECOES, IND, RANGES, LIMITE_BURACO_DIAS, TOLERANCIA_DIAS,
    fmtNum, fmtPct, fmtDM, fmtDMA, fmtMA,
    pontos, var12m, ultimosDias, trechos, buracos, comNulos, periodo, addMeses,
    resumirSerie, montar, dadosVelhos,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Dados = api;
})(typeof self !== 'undefined' ? self : this);
