/* Camada de gráficos (Chart.js). */
(function (root) {
  'use strict';
  const D = root.Dados, DIA = D.DIA;
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const LIBS = { chartjs: 'assets/vendor/chart.umd.min.js' };
  const reduzido = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const carregados = {};
  const carregar = (src) => carregados[src] || (carregados[src] = new Promise((ok, err) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => err(new Error('falha ao carregar ' + src));
    document.head.appendChild(s);
  }));

  // Marcas do eixo x (Chart.js com eixo numérico: sem adaptador de datas).
  function marcos(min, max) {
    const dias = (max - min) / DIA, out = [];
    if (dias <= 70) {
      const passo = dias <= 10 ? 1 : 7;
      for (let t = min; t <= max; t += passo * DIA) out.push(t);
      return { ticks: out, fmt: (t) => D.fmtDM(D.iso(t)) };
    }
    const meses = dias / 30.4;
    const passo = meses <= 8 ? 1 : meses <= 16 ? 2 : meses <= 40 ? 6 : 12;
    const d0 = new Date(min);
    let y = d0.getUTCFullYear(), m = d0.getUTCMonth() + (d0.getUTCDate() > 1 ? 1 : 0);
    for (let t = Date.UTC(y, m, 1); t <= max; t = Date.UTC(y, m += passo, 1)) out.push(t);
    return { ticks: out, fmt: (t) => { const d = new Date(t); return passo >= 12 ? String(d.getUTCFullYear()) : MESES[d.getUTCMonth()] + '/' + String(d.getUTCFullYear()).slice(2); } };
  }

  async function viaChartJS(host, cfg) {
    await carregar(LIBS.chartjs);
    const cv = document.createElement('canvas');
    host.appendChild(cv);
    let fmt = (t) => t;
    const fam = cfg.css.fam;
    const chart = new root.Chart(cv, {
      type: 'line',
      data: { datasets: cfg.series.map((s) => ({ label: s.nome, data: [], borderColor: s.cor, backgroundColor: cfg.estilo === 'area' && !s.tracejado ? s.cor + '26' : s.cor, fill: cfg.estilo === 'area' && !s.tracejado ? 'start' : false, borderWidth: cfg.estilo === 'grossa' ? 3 : cfg.estilo === 'fina' ? 1.5 : 2, borderDash: s.tracejado ? [6, 4] : [], pointRadius: 0, pointHoverRadius: 4, tension: 0, spanGaps: false })) },
      options: {
        responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
        animation: reduzido() ? false : { duration: 200 },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        font: { family: fam },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (it) => D.fmtDMA(D.iso(it[0].parsed.x)),
              label: (c) => c.dataset.label + ': ' + D.fmtNum(c.parsed.y, cfg.casas),
            },
          },
        },
        scales: {
          x: { type: 'linear', grid: { display: false }, border: { display: false }, ticks: { color: cfg.css.mut, maxRotation: 0, callback: (v) => fmt(v) },
            afterBuildTicks: (sc) => { const r = marcos(sc.min, sc.max); fmt = r.fmt; sc.ticks = r.ticks.map((value) => ({ value })); } },
          y: { position: 'right', grid: { color: cfg.css.line }, border: { display: false }, ticks: { color: cfg.css.mut, callback: (v) => D.fmtNum(v, cfg.casas > 2 ? 2 : cfg.casas) } },
        },
      },
    });
    return {
      setDados(series, ini, fim) {
        chart.data.datasets.forEach((ds, i) => {
          ds.data = D.comNulos(series[i].pts.filter((p) => p[0] >= ini)).map(([x, y]) => ({ x, y }));
        });
        chart.options.scales.x.min = ini; chart.options.scales.x.max = fim;
        chart.update('none');
      },
      destruir() { chart.destroy(); cv.remove(); },
    };
  }

  function cssTema() {
    const c = getComputedStyle(document.body);
    const g = (n) => c.getPropertyValue(n).trim();
    return { mut: g('--mut'), line: g('--line'), fam: c.fontFamily, c1: g('--acc-t'), c2: g('--c2') };
  }

  root.Grafico = {
    LIBS, marcos, cssTema, carregar,
    criar: (host, cfg) => viaChartJS(host, cfg),
  };
})(self);
