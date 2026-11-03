/* Painel de mercado: monta a página a partir de data/ (atualizado pelo robô) e abre o gráfico grande numa janela. */
(function () {
  'use strict';
  const D = window.Dados, G = window.Grafico;
  const app = document.getElementById('app');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let inds = [], ultima = 0, velha = null, atualizadoEm = null;

  // ---------- Dados ----------
  async function carregar() {
    const agora = Date.now();
    const arqs = [...new Set(D.IND.flatMap((d) => [d.arq, d.media, d.bc].filter(Boolean)))];
    const raws = {};
    await Promise.all(arqs.map(async (a) => { raws[a] = await (await fetch('data/' + a + '.json', { cache: 'no-store' })).json(); }));
    const status = await (await fetch('data/status.json', { cache: 'no-store' })).json();
    inds = D.IND.map((def) => D.montar(def, raws, status, agora));
    ultima = Math.max(...arqs.filter((k) => k.startsWith('yahoo/')).map((k) => Date.parse(raws[k].atual.horario)));
    velha = D.dadosVelhos(raws, agora, status);
  }

  // ---------- Peças ----------
  const fmtV = (i, v) => i.pre + D.fmtNum(v, i.casas);
  const unid = (i) => (i.unid === i.pre.trim() ? '' : `<small>${esc(i.unid)}</small>`);
  const desde = (st) => D.fmtDM((st.falhando_desde || '').slice(0, 10)) || '—';
  const nomeCompleto = (i) => (i.local ? `${i.nome} · ${i.local}` : i.nome);
  const fonteTxt = (i) => (i.secao === 'agro' ? 'Imea' : 'Yahoo Finance');

  function varDia(i) {
    if (i.semDia) return '';
    if (i.varDia == null) return `<span class="v nd">—</span><span class="u">${esc(i.varDiaRotulo || 'dia')}</span>`;
    const cl = Math.abs(i.varDia) < 0.00005 ? 'nd' : i.varDia > 0 ? 'up' : 'down';
    const seta = cl === 'nd' ? '' : i.varDia > 0 ? '▲ ' : '▼ ';
    return `<span class="v ${cl}"><span aria-hidden="true">${seta}</span>${D.fmtPct(i.varDia)}</span><span class="u">${esc(i.varDiaRotulo || 'dia')}</span>`;
  }
  function var12(i) {
    if (!i.var12) return '<span class="v12">—</span><span class="u">12 meses</span>';
    return `<span class="v12"><b class="${i.var12.r >= 0 ? 'up' : 'down'}">${D.fmtPct(i.var12.r)}</b></span><span class="u">12 meses</span>`;
  }
  function spark(pts) {
    if (pts.length < 2) return '<span class="spark"><span class="sem-spark">ainda sem histórico</span></span>';
    const W = 120, H = 36, pad = 4;
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
    const x = (t) => ((t - t0) / (t1 - t0 || 1)) * W;
    const y = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
    const f = (n) => n.toFixed(1);
    let svg = '';
    for (const seg of D.trechos(pts)) {
      if (seg.length < 2) continue;
      const d = seg.map((p, k) => (k ? 'L' : 'M') + f(x(p[0])) + ' ' + f(y(p[1]))).join('');
      svg += `<path class="a" d="${d}L${f(x(seg[seg.length - 1][0]))} ${H}L${f(x(seg[0][0]))} ${H}Z"/><path class="l" d="${d}"/>`;
    }
    const u = pts[pts.length - 1];
    return `<span class="spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${svg}</svg><i style="left:${(x(u[0]) / W) * 100}%;top:${(y(u[1]) / H) * 100}%"></i></span>`;
  }
  const blocoAviso = (i) => (i.aviso ? `<span class="aviso">${esc(i.aviso)}</span>` : '');
  function blocoBC(i) {
    if (!i.bcRes) return '';
    if (i.bcStatus.ok === false) return `<span class="bc">PTAX BC: indisponível desde ${desde(i.bcStatus)}</span>`;
    return `<span class="bc">PTAX BC (${D.fmtDM(i.bcRes.data)}): R$ ${D.fmtNum(i.bcRes.valor, 2)}</span>${i.bcRes.aviso ? `<span class="aviso">${esc(i.bcRes.aviso)}</span>` : ''}`;
  }
  function blocoMedia(i) {
    if (!i.mediaRes) return '';
    if (i.mediaStatus.ok === false) return `<span class="media">Média MT: indisponível desde ${desde(i.mediaStatus)}</span>`;
    return `<span class="media">Média MT <b>${D.fmtNum(i.mediaRes.valor, i.casas)}</b></span>`;
  }

  function linha(i) {
    if (i.status.ok === false) {
      return `<div class="ind cinza" data-id="${i.id}"><div class="linha"><span class="c-nome"><span class="nome">${esc(i.nome)}</span><span class="sub">${esc(i.local || '')}</span></span>
        <span class="c-valor"><span class="indisp">indisponível desde ${desde(i.status)}</span></span><span></span><span></span><span></span><span class="c-data">${fonteTxt(i)}</span><span></span></div></div>`;
    }
    return `<div class="ind" data-id="${i.id}">
      <button type="button" class="linha" aria-haspopup="dialog">
        <span class="c-nome"><span class="nome">${esc(i.nome)}</span>${i.local ? `<span class="sub">${esc(i.local)}${i.obs ? ' · ' + esc(i.obs) : ''}</span>` : ''}</span>
        <span class="c-valor"><span class="valor">${fmtV(i, i.valor)}${unid(i)}</span>${blocoMedia(i)}</span>
        <span class="c-dia">${varDia(i)}</span>
        <span class="c-12">${var12(i)}</span>
        <span class="c-spark">${spark(i.pontosSpark)}</span>
        <span class="c-data">${esc(i.rotulo)}${blocoBC(i)}${blocoAviso(i)}</span>
        <span class="seta" aria-hidden="true"></span>
      </button>
    </div>`;
  }

  // ---------- Gráfico grande ----------
  function montarGrande(host, i) {
    const main = i.sGrande || i.s;
    const ptax = !!i.sGrande;
    const css = G.cssTema();
    const temMedia = i.mediaRes && i.mediaStatus.ok !== false && i.mediaRes.s.length > 1;
    const series = [{ nome: ptax ? 'PTAX (Banco Central)' : i.local || i.nome, pts: main, cor: css.c1 }];
    if (temMedia) series.push({ nome: 'Média MT', pts: i.mediaRes.s, cor: css.c2, tracejado: true });
    const chaves = Object.keys(D.RANGES);
    const per = Object.fromEntries(chaves.map((k) => [k, main.length > 1 ? D.periodo(main, k) : { ok: false, desde: D.iso(main[0][0]) }]));
    const indis = chaves.filter((k) => !per[k].ok);
    host.innerHTML = `<div class="g-barra"><div class="g-per" role="group" aria-label="Período">${chaves.map((k) =>
      `<button type="button" data-p="${k}" aria-pressed="false" ${per[k].ok ? '' : `disabled title="histórico desde ${D.fmtMA(per[k].desde)}"`}>${k}</button>`).join('')}</div>
      <div class="g-leg">${series.length > 1 ? series.map((s) => `<span style="--cor:${s.cor}" class="${s.tracejado ? 'tr' : ''}">${esc(s.nome)}</span>`).join('') : `<span style="--cor:${series[0].cor}">${esc(ptax ? series[0].nome : nomeCompleto(i))} · ${esc(i.unid)}</span>`}</div></div>
      ${ptax ? '<p class="g-aviso">PTAX é a média das consultas do Banco Central no dia e pode diferir do fechamento do mercado.</p>' : ''}
      <p class="g-aviso">${indis.length ? indis.map((k) => `${k}: histórico desde ${D.fmtMA(per[k].desde)}`).join(' · ') : ''}</p>
      <div class="g-area"></div><p class="g-hover"></p>`;
    const area = host.querySelector('.g-area'), hov = host.querySelector('.g-hover');
    if (main.length < 2) {
      area.outerHTML = `<p class="g-vazio">Ainda sem histórico: só há ${main.length} leitura (${D.fmtDM(D.iso(main[0][0]))}). O gráfico aparece quando houver mais dias.</p>`;
      return () => {};
    }
    let vivo = true, graf = null;
    G.criar(area, { series, casas: i.casas, css, estilo: 'area', onHover: (t) => { hov.textContent = t; } }).then((g) => {
      if (!vivo) return g.destruir();
      graf = g;
      aplicar(per['1A'].ok ? '1A' : chaves.filter((k) => per[k].ok).pop());
    });
    function aplicar(k) {
      host.querySelectorAll('[data-p]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === k)));
      graf.setDados(series, per[k].ini, per[k].fim);
    }
    host.querySelector('.g-per').addEventListener('click', (e) => { const b = e.target.closest('button[data-p]'); if (b && !b.disabled && graf) aplicar(b.dataset.p); });
    return () => { vivo = false; if (graf) graf.destruir(); host.innerHTML = ''; };
  }

  // janela por cima da página: nada é empurrado e a página não rola; fecha com o botão, Esc ou clique fora
  function abrir(i) {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.setAttribute('aria-labelledby', 'mt');
    dlg.innerHTML = `<div class="modal-cab"><div><h3 id="mt">${esc(nomeCompleto(i))}</h3><span class="sub">${esc(i.unid)}${i.obs ? ' · ' + esc(i.obs) : ''} · ${esc(i.rotulo)}</span></div><button class="btn" type="button" data-x>Fechar</button></div><div class="mg"></div>`;
    document.body.appendChild(dlg);
    const destruir = montarGrande(dlg.querySelector('.mg'), i);
    dlg.addEventListener('close', () => { destruir(); dlg.remove(); });
    dlg.querySelector('[data-x]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.showModal();
  }

  // ---------- Página ----------
  const fmtHora = (t) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(t).replace(',', '');
  function render() {
    const secoes = D.ORDEM.map((sid) => {
      const lista = inds.filter((i) => i.secao === sid);
      return `<section class="secao" style="--n:${lista.length}" aria-labelledby="h-${sid}"><div class="secao-cab"><h2 id="h-${sid}">${D.SECOES[sid].titulo}</h2><span class="fonte">Fonte: ${D.SECOES[sid].fonte}</span></div><div class="lista">${lista.map(linha).join('')}</div></section>`;
    }).join('');
    app.innerHTML = `<div class="wrap">
      <header class="topo"><h1>Olá, Gustavo</h1><div class="meta"><span>Última cotação: ${fmtHora(ultima)}</span><button class="btn" type="button" id="atualizar">Atualizar</button><span id="quando">${atualizadoEm ? 'atualizado às ' + atualizadoEm : ''}</span></div></header>
      ${velha ? `<div class="faixa-velha" role="status">Dados desatualizados desde ${D.fmtDM(velha.desde)}</div>` : ''}
      <main class="secoes">${secoes}</main>
      <footer class="rodape-pg">Fontes: Yahoo Finance · Banco Central do Brasil (PTAX) · Imea</footer>
    </div>`;
    const porId = Object.fromEntries(inds.map((i) => [i.id, i]));
    app.querySelectorAll('.ind:not(.cinza) .linha').forEach((b) => b.addEventListener('click', () => abrir(porId[b.closest('.ind').dataset.id])));
    document.getElementById('atualizar').addEventListener('click', async () => {
      await carregar();
      atualizadoEm = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      render();
    });
  }

  carregar().then(render).catch((e) => { app.innerHTML = `<div class="wrap"><p>Não consegui carregar os dados (${esc(e.message)}). Tente o botão de recarregar do navegador em alguns minutos.</p></div>`; });
})();
