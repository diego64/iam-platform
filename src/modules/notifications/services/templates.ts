/**
 * Responsabilidade: o conteúdo de cada mensagem — assunto, texto e HTML.
 * Consumido por: o serviço de notificação e os dois canais.
 * Regras:
 *  - **Assunto é literal fixo.** Nunca interpolado com dado de requisição: assunto montado
 *    é a porta clássica de injeção de cabeçalho, e o teste compara com a constante.
 *  - **O que vem de fora é escapado e truncado.** O `user-agent` é texto controlado por quem
 *    chama; ele entra no corpo, então entra escapado no ramo HTML e sem quebra de linha nos
 *    dois ramos.
 *  - Funções puras, sem motor de template e sem arquivo externo: o conteúdo é curto, estável
 *    e precisa ser verificável byte a byte no teste.
 *  - Todo aviso ao dono da conta termina com a mesma instrução. Aviso sem o que fazer não
 *    serve para nada — quem recebe precisa saber qual é o próximo passo.
 */
import type { Regra, Severidade } from '../../security-events/constants/regras.js';
import type { CorpoDeMensagem, OrigemDoAcesso } from '../types/mensagem.js';

/** Acima disso, o user-agent é ruído — e um campo sem teto é um corpo de e-mail sem teto. */
const MAX_USER_AGENT = 200;

const ACAO = 'Se não foi você, troque sua senha imediatamente e revise suas sessões ativas.';

const ASSUNTOS = {
  login_novo: 'Novo acesso à sua conta',
  recuperacao_usada: 'Um código de recuperação foi usado na sua conta',
  senha_alterada: 'Sua senha foi alterada',
  mfa_alterado: 'A verificação em duas etapas da sua conta mudou',
  conta_bloqueada: 'Seu acesso foi suspenso',
  reset_de_senha: 'Redefinição de senha',
  teste: '[IAM] Teste de entrega',
} as const;

/**
 * Neutraliza o que quebraria cabeçalho ou estrutura.
 *
 * CR e LF viram espaço **antes** de qualquer outra coisa: mesmo no corpo, uma sequência
 * dessas atravessando para um cabeçalho é o bug que se paga caro, e nenhum user-agent
 * legítimo tem quebra de linha.
 */
function limpar(valor: string): string {
  return valor.replace(/[\r\n]+/g, ' ').slice(0, MAX_USER_AGENT);
}

/** Escapa o que o navegador interpretaria como marcação. */
function escapar(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Instante em UTC, legível por quem lê o e-mail e não por quem depura. */
function formatarInstante(quando: Date): string {
  return `${quando.toISOString().replace('T', ' ').slice(0, 19)} (UTC)`;
}

/** Monta o ramo HTML a partir das mesmas linhas do ramo texto, já escapadas. */
function comoHtml(linhas: readonly string[]): string {
  return linhas
    .filter((linha) => linha.length > 0)
    .map((linha) => `<p>${escapar(linha)}</p>`)
    .join('\n');
}

/**
 * Cada template devolve as linhas do corpo; o HTML sai delas. Ter uma origem só para os dois
 * ramos é o que impede a versão HTML de ganhar um dado que a versão texto não tem.
 */
function montar(assunto: string, linhas: readonly string[]): CorpoDeMensagem {
  return { assunto, texto: linhas.join('\n'), html: comoHtml(linhas) };
}

export function loginNovo(origem: OrigemDoAcesso): CorpoDeMensagem {
  return montar(ASSUNTOS.login_novo, [
    'Detectamos um acesso à sua conta a partir de um dispositivo que ainda não tínhamos visto.',
    '',
    `Quando: ${formatarInstante(origem.quando)}`,
    `Origem: ${origem.ip === null ? 'não identificada' : limpar(origem.ip)}`,
    `Dispositivo: ${origem.userAgent === null ? 'não identificado' : limpar(origem.userAgent)}`,
    '',
    'Se foi você, não precisa fazer nada.',
    ACAO,
  ]);
}

/**
 * Sem IP e sem dispositivo de propósito: a mensagem cobre tanto a troca autenticada quanto a
 * conclusão de um reset, e o segundo caminho tem origem menos confiável de contexto.
 */
export function senhaAlterada(quando: Date): CorpoDeMensagem {
  return montar(ASSUNTOS.senha_alterada, [
    `A senha da sua conta foi alterada em ${formatarInstante(quando)}.`,
    '',
    ACAO,
  ]);
}

/**
 * Código de recuperação usado.
 *
 * Mensagem própria, e não um `login_novo`, por dois motivos. O sinal é diferente: quem usa
 * código de recuperação está contornando o segundo fator, que é o caminho clássico da tomada
 * de conta depois de um vazamento de senha. E ela **não** passa pela checagem de dispositivo:
 * um código de recuperação usado de um aparelho conhecido continua merecendo aviso, porque o
 * que chama atenção é o contorno, não a origem.
 */
export function recuperacaoUsada(origem: OrigemDoAcesso): CorpoDeMensagem {
  return montar(ASSUNTOS.recuperacao_usada, [
    'Um código de recuperação foi usado para entrar na sua conta, no lugar da verificação em duas etapas.',
    '',
    `Quando: ${formatarInstante(origem.quando)}`,
    `Origem: ${origem.ip === null ? 'não identificada' : limpar(origem.ip)}`,
    `Dispositivo: ${origem.userAgent === null ? 'não identificado' : limpar(origem.userAgent)}`,
    '',
    'Cada código só funciona uma vez. Se foi você, considere gerar novos códigos.',
    ACAO,
  ]);
}

export function mfaAlterado(quando: Date): CorpoDeMensagem {
  return montar(ASSUNTOS.mfa_alterado, [
    `A verificação em duas etapas da sua conta foi alterada em ${formatarInstante(quando)}.`,
    '',
    ACAO,
  ]);
}

export function contaBloqueada(quando: Date): CorpoDeMensagem {
  return montar(ASSUNTOS.conta_bloqueada, [
    `O acesso à sua conta foi suspenso em ${formatarInstante(quando)}.`,
    '',
    'Se você não esperava por isso, procure o responsável pela sua organização.',
  ]);
}

/**
 * O token aparece **uma vez só**, dentro do link. Não há versão "copie este código": o valor
 * em duplicata dobra a chance de ele acabar num print de tela ou colado num ticket.
 */
export function resetDeSenha(urlBase: string, token: string, validadeMin: number): CorpoDeMensagem {
  const url = new URL(urlBase);
  url.searchParams.set('token', token);

  return montar(ASSUNTOS.reset_de_senha, [
    'Recebemos um pedido para redefinir a senha da sua conta.',
    '',
    'Para continuar, acesse:',
    url.toString(),
    '',
    `O link vale por ${String(validadeMin)} minutos e só pode ser usado uma vez.`,
    'Se não foi você quem pediu, ignore esta mensagem — sua senha continua a mesma.',
  ]);
}

export interface DadosDeAlerta {
  /**
   * Uniões fechadas, não `string`: a regra é o único trecho interpolado num assunto em todo
   * o catálogo, e assunto montado com texto livre é injeção de cabeçalho esperando um
   * chamador distraído. O tipo fecha a porta; o `limpar` abaixo é o cinto de segurança.
   */
  readonly regra: Regra;
  readonly severidade: Severidade;
  readonly ocorrencias: number;
  readonly janelaMs: number;
  readonly detectadoEm: Date;
  readonly eventoId: string;
  readonly traceId: string | null;
}

/**
 * Alerta ao operador. **Sem a pista do sujeito**, pela mesma razão que o canal de log da
 * SPEC 014 não a registra: ela é o que liga o alarme a uma pessoa, e caixa de e-mail de
 * equipe é o lugar menos controlado onde esse vínculo poderia parar.
 */
export function alertaDeSeguranca(dados: DadosDeAlerta): CorpoDeMensagem {
  const janelaMin = Math.round(dados.janelaMs / 60_000);

  return montar(`[IAM] Alerta de segurança: ${limpar(dados.regra)}`, [
    `Regra:       ${dados.regra}`,
    `Severidade:  ${dados.severidade}`,
    `Ocorrências: ${String(dados.ocorrencias)} em ${String(janelaMin)} min`,
    `Detectado:   ${dados.detectadoEm.toISOString()}`,
    `Evento:      ${dados.eventoId}`,
    `Trace:       ${dados.traceId ?? 'ausente'}`,
    '',
    `Investigue em GET /security/events/${dados.eventoId}.`,
  ]);
}

export function teste(quando: Date): CorpoDeMensagem {
  return montar(ASSUNTOS.teste, [
    `Mensagem de verificação do transporte de notificações, gerada em ${formatarInstante(quando)}.`,
    '',
    'Se você está lendo isto, o canal de alerta funciona.',
  ]);
}

/** Exposto para o teste comparar o assunto com a constante, em vez de com outra string. */
export const ASSUNTOS_ESPERADOS = ASSUNTOS;
