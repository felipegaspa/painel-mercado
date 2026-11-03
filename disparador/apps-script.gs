/**
 * Disparador do painel-mercado — Google Apps Script.
 *
 * De hora em hora, nos dias úteis, das 05h às 20h de Brasília, chama o workflow "Coletar dados"
 * (workflow_dispatch na main). O robô decide pelo estado o que coletar (Imea no máximo 2 leituras por dia).
 *
 * Avisa por e-mail (para a própria conta Google que roda o script; no máximo 1 aviso de cada tipo por dia):
 *   - disparo recusado pelo GitHub (token vencido, sem permissão, GitHub fora do ar);
 *   - disparo aceito mas a rodada não apareceu ou ficou presa;
 *   - nenhuma rodada do robô entre 17h do dia útil anterior e 08:30 (07:30 de Cuiabá);
 *   - token vencendo em 14 dias ou menos.
 * Se o próprio script der erro, o Google manda o e-mail de falha do gatilho.
 *
 * O TOKEN NÃO FICA NO CÓDIGO: fica em Configurações do projeto > Propriedades do script > GITHUB_TOKEN.
 * O código nunca escreve o token em log nem em e-mail.
 */

const REPO = 'felipegaspa/painel-mercado';
const WORKFLOW = 'coletar.yml';
const API = 'https://api.github.com/repos/' + REPO + '/actions';
const TZ = 'America/Sao_Paulo';   // Brasília (UTC-3, sem horário de verão)
const HORA_INI = 5;               // 05h de Brasília = 04h de Cuiabá
const HORA_FIM = 20;              // último disparo começa entre 20h e 21h de Brasília
const DIAS_AVISO_TOKEN = 14;

// ---------- Gatilho de hora em hora ----------

function aCadaHora() {
  const agora = new Date();
  const diaSemana = Number(Utilities.formatDate(agora, TZ, 'u')); // 1 = segunda ... 7 = domingo
  const hora = Number(Utilities.formatDate(agora, TZ, 'H'));
  if (diaSemana > 5 || hora < HORA_INI || hora > HORA_FIM) return;
  conferirDisparoAnterior_();
  disparar_();
  if (hora >= 9) conferirManha_(agora);
}

// ---------- Disparo ----------

function disparar_() {
  const corpo = { ref: 'main', inputs: { origem: 'apps-script' } };
  let r = gh_('post', '/workflows/' + WORKFLOW + '/dispatches', corpo);
  if (!r.ok && r.codigo !== 401 && r.codigo !== 403 && r.codigo !== 404) {
    Utilities.sleep(30000); // erro passageiro: tenta mais uma vez depois de 30 s
    r = gh_('post', '/workflows/' + WORKFLOW + '/dispatches', corpo);
  }
  if (!r.ok) {
    avisar_('disparo', 'Disparo do robô falhou',
      'O GitHub recusou o disparo do robô (HTTP ' + r.codigo + ').\n\n' + explicar_(r.codigo) +
      '\n\nResposta do GitHub: ' + r.texto.slice(0, 300));
    return null;
  }
  let id = null;
  try { id = JSON.parse(r.texto).workflow_run_id || null; } catch (e) { /* resposta 204 sem corpo */ }
  PropertiesService.getScriptProperties().setProperty('ULTIMO_DISPARO', JSON.stringify({ em: new Date().toISOString(), id: id }));
  console.log('Disparo aceito (HTTP ' + r.codigo + ')' + (id ? ', rodada ' + id : ''));
  return id;
}

// A rodada do disparo anterior apareceu e terminou?
function conferirDisparoAnterior_() {
  const props = PropertiesService.getScriptProperties();
  const ant = JSON.parse(props.getProperty('ULTIMO_DISPARO') || 'null');
  if (!ant) return;
  const minutos = (Date.now() - Date.parse(ant.em)) / 60000;
  if (minutos < 10) return;
  if (ant.id) {
    const r = gh_('get', '/runs/' + ant.id);
    if (!r.ok) return; // a falha de API já aparece no disparo
    const run = JSON.parse(r.texto);
    if (run.status !== 'completed' && minutos > 45) {
      avisar_('presa', 'Rodada do robô presa', 'A rodada disparada às ' + hora_(ant.em) + ' (Brasília) ainda está "' +
        run.status + '" depois de ' + Math.round(minutos) + ' min.\n' + run.html_url);
    }
    // Se terminou com falha, o próprio GitHub já manda o e-mail "Run failed".
  } else {
    // GitHub respondeu sem o número da rodada: procura uma rodada do script criada depois do disparo.
    const desde = new Date(Date.parse(ant.em) - 60000).toISOString().replace(/\.\d+Z$/, 'Z');
    const r = gh_('get', '/workflows/' + WORKFLOW + '/runs?event=workflow_dispatch&per_page=20&created=%3E%3D' + desde);
    if (!r.ok) return;
    const achou = JSON.parse(r.texto).workflow_runs.some(function (x) { return /Apps Script/.test(x.display_title || ''); });
    if (!achou) {
      avisar_('sumiu', 'Disparo aceito mas a rodada não apareceu',
        'O GitHub aceitou o disparo das ' + hora_(ant.em) + ' (Brasília), mas nenhuma rodada "Coletar dados · Apps Script" apareceu.');
    }
  }
  if (minutos > 45 || ant.id === null) props.deleteProperty('ULTIMO_DISPARO');
}

// ---------- Conferência da manhã (uma vez por dia útil, a partir das 09h) ----------

function conferirManha_(agora) {
  const props = PropertiesService.getScriptProperties();
  const hoje = Utilities.formatDate(agora, TZ, 'yyyy-MM-dd');
  if (props.getProperty('CONFERIDO_EM') === hoje) return;
  const prazo = new Date(hoje + 'T08:30:00-03:00');
  const inicio = new Date(diaUtilAnterior_(hoje) + 'T17:00:00-03:00');
  const r = gh_('get', '/workflows/' + WORKFLOW + '/runs?branch=main&per_page=100&created=%3E%3D' +
    new Date(inicio.getTime() - 3600000).toISOString().replace(/\.\d+Z$/, 'Z'));
  if (!r.ok) return; // tenta de novo na próxima hora
  const rodou = JSON.parse(r.texto).workflow_runs.some(function (x) {
    const t = Date.parse(x.run_started_at);
    return (x.conclusion === 'success' || x.conclusion === 'failure') && t >= inicio.getTime() && t <= prazo.getTime();
  });
  if (!rodou) {
    avisar_('manha', 'Painel sem dado novo às 07:30 de Cuiabá',
      'Nenhuma rodada do robô terminou entre ' + Utilities.formatDate(inicio, TZ, 'dd/MM HH:mm') + ' e ' +
      Utilities.formatDate(prazo, TZ, 'dd/MM HH:mm') + ' (Brasília).\nVeja https://github.com/' + REPO + '/actions');
  }
  props.setProperty('CONFERIDO_EM', hoje);
}

function diaUtilAnterior_(ymd) {
  const d = new Date(ymd + 'T12:00:00-03:00');
  do { d.setTime(d.getTime() - 86400000); } while (['Sat', 'Sun'].indexOf(Utilities.formatDate(d, TZ, 'EEE')) >= 0);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

// ---------- GitHub ----------

function gh_(metodo, caminho, corpo) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('Falta a propriedade GITHUB_TOKEN (Configurações do projeto > Propriedades do script).');
  const opcoes = {
    method: metodo,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  };
  if (corpo) { opcoes.contentType = 'application/json'; opcoes.payload = JSON.stringify(corpo); }
  let resp;
  try {
    resp = UrlFetchApp.fetch(API + caminho, opcoes);
  } catch (e) {
    return { ok: false, codigo: 0, texto: 'sem resposta: ' + String(e.message || e).slice(0, 200) };
  }
  const codigo = resp.getResponseCode();
  verificarValidadeToken_(resp.getAllHeaders());
  return { ok: codigo >= 200 && codigo < 300, codigo: codigo, texto: resp.getContentText() || '' };
}

function verificarValidadeToken_(cabecalhos) {
  let validade = null;
  Object.keys(cabecalhos).forEach(function (k) {
    if (k.toLowerCase() === 'github-authentication-token-expiration') validade = String(cabecalhos[k]);
  });
  if (!validade) return;
  const t = Date.parse(validade.replace(' UTC', 'Z').replace(' ', 'T'));
  if (isNaN(t)) return;
  const dias = Math.floor((t - Date.now()) / 86400000);
  PropertiesService.getScriptProperties().setProperty('TOKEN_VENCE_EM', Utilities.formatDate(new Date(t), TZ, 'dd/MM/yyyy'));
  if (dias <= DIAS_AVISO_TOKEN) {
    avisar_('token', 'Token do disparador vence em ' + dias + ' dia(s)',
      'O token do GitHub usado pelo disparador do painel vence em ' + Utilities.formatDate(new Date(t), TZ, 'dd/MM/yyyy') +
      '.\nRenove: GitHub > Settings > Developer settings > Fine-grained tokens > o token "painel-mercado-disparador" > Regenerate token,' +
      ' e cole o novo valor em Propriedades do script > GITHUB_TOKEN (passo a passo no SPEC, seção 4.6).');
  }
}

function explicar_(codigo) {
  if (codigo === 401) return 'Token inválido ou vencido. Gere um novo e cole em Propriedades do script > GITHUB_TOKEN.';
  if (codigo === 403) return 'Token sem permissão (precisa de Actions: Read and write só no painel-mercado) ou limite de uso da API.';
  if (codigo === 404) return 'Repositório ou workflow não encontrado com este token (token sem acesso ao painel-mercado?).';
  if (codigo === 422) return 'O GitHub recusou os dados do disparo (o workflow mudou?).';
  if (codigo === 0) return 'Não houve resposta do GitHub (rede ou GitHub fora do ar).';
  return 'Erro do GitHub; normalmente passa sozinho.';
}

// ---------- E-mail (no máximo 1 de cada tipo por dia) ----------

function avisar_(tipo, assunto, texto) {
  const props = PropertiesService.getScriptProperties();
  const chave = 'AVISO_' + tipo;
  const hoje = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  console.warn(assunto + ' — ' + texto);
  if (props.getProperty(chave) === hoje) return;
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '[Painel] ' + assunto, texto + '\n\n— disparador do painel (Google Apps Script)');
  props.setProperty(chave, hoje);
}

function hora_(iso) { return Utilities.formatDate(new Date(iso), TZ, 'dd/MM HH:mm'); }

// ---------- Para rodar à mão no editor ----------

/** Rode UMA vez: cria o gatilho de hora em hora (apaga gatilhos antigos deste script). */
function instalarGatilho() {
  ScriptApp.getProjectTriggers().forEach(function (g) { ScriptApp.deleteTrigger(g); });
  ScriptApp.newTrigger('aCadaHora').timeBased().everyHours(1).create();
  console.log('Gatilho criado: aCadaHora, de hora em hora.');
}

/** Teste: dispara uma rodada agora, a qualquer hora, e mostra o resultado (sem mandar e-mail se der certo). */
function testarDisparo() {
  const id = disparar_();
  const validade = PropertiesService.getScriptProperties().getProperty('TOKEN_VENCE_EM');
  console.log(id ? 'OK: rodada https://github.com/' + REPO + '/actions/runs/' + id
                 : 'Veja acima: se não houve erro, o disparo foi aceito; confira em https://github.com/' + REPO + '/actions');
  console.log('Token vence em: ' + (validade || 'não informado pelo GitHub'));
}

/** Teste: manda um e-mail de teste para confirmar que os avisos chegam. */
function testarEmail() {
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '[Painel] Teste do aviso', 'Se você recebeu isto, os avisos do disparador chegam.');
  console.log('E-mail de teste enviado para ' + Session.getEffectiveUser().getEmail());
}
