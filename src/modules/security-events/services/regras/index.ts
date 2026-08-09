/**
 * Responsabilidade: as cinco regras de correlação.
 * Consumido por: o detector.
 * Regras:
 *  - Cada regra é uma função de `(evento, contexto) → Deteccao | null`. Nenhuma delas
 *    persiste, alerta ou mede: elas decidem, e o detector age.
 *  - Uma regra que não se interessa pelo evento devolve `null` **antes** de tocar o banco.
 *    O caminho mais comum é justamente esse — a maioria dos eventos auditados não interessa
 *    a nenhuma regra —, e ele precisa custar nada.
 *  - Contador indisponível (`null`) também devolve `null`: sem contagem não há juízo, e
 *    inventar um seria alarme falso na hora errada.
 *  - Nenhuma regra bloqueia nada. Elas produzem juízo; contenção é de quem já contém.
 */
import { SEVERIDADE_POR_REGRA } from '../../constants/regras.js';
import type { EventoDeAuditoria } from '../../../audit/types/audit-event.js';
import type { Deteccao } from '../../types/security-event.js';
import type { ContadorDeRateLimit } from '../../../../shared/rate-limit/types.js';
import type { RepositorioDeConjuntoDistinto } from '../../repositories/distinct-set.repository.js';
import type { ExtratorDeSujeito } from '../sujeito.js';

export interface LimiaresDeDeteccao {
  readonly bruteForceMax: number;
  readonly bruteForceJanelaMs: number;
  readonly stuffingContasMax: number;
  readonly stuffingJanelaMs: number;
  readonly varreduraDeClienteMax: number;
  readonly varreduraDeClienteJanelaMs: number;
  readonly mfaFalhasMax: number;
  readonly mfaJanelaMs: number;
}

export interface ContextoDeRegra {
  readonly contador: ContadorDeRateLimit;
  readonly conjuntos: RepositorioDeConjuntoDistinto;
  readonly extrator: ExtratorDeSujeito;
  readonly limiares: LimiaresDeDeteccao;
}

export type RegraDeDeteccao = (
  evento: EventoDeAuditoria,
  contexto: ContextoDeRegra,
) => Promise<Deteccao | null>;

/** Conta a ocorrência na janela e devolve o total, ou `null` se o contador falhou. */
async function contar(
  contexto: ContextoDeRegra,
  chave: string,
  janelaMs: number,
): Promise<number | null> {
  const estado = await contexto.contador.incrementar(chave, janelaMs);
  return estado === null ? null : estado.contagem;
}

export const bruteForceConta: RegraDeDeteccao = async (evento, contexto) => {
  if (evento.type !== 'iam.auth.login_failed') return null;
  const sujeito = contexto.extrator.daConta(evento);
  if (sujeito === null) return null;

  const { bruteForceMax: max, bruteForceJanelaMs: janelaMs } = contexto.limiares;
  const total = await contar(contexto, `sec:brute_force_conta:${sujeito.pista}`, janelaMs);
  if (total === null || total < max) return null;

  return {
    regra: 'brute_force_conta',
    severidade: SEVERIDADE_POR_REGRA.brute_force_conta,
    sujeito,
    ocorrencias: total,
    janelaMs,
    metadata: { tipo_de_evento: evento.type },
  };
};

export const credentialStuffing: RegraDeDeteccao = async (evento, contexto) => {
  if (evento.type !== 'iam.auth.login_failed') return null;
  const origem = contexto.extrator.doIp(evento);
  const conta = contexto.extrator.daConta(evento);
  // Precisa dos dois: a pergunta é quantas **contas distintas** partiram deste endereço.
  if (origem === null || conta === null) return null;

  const { stuffingContasMax: max, stuffingJanelaMs: janelaMs } = contexto.limiares;
  const distintas = await contexto.conjuntos.registrar(
    `stuffing:${origem.pista}`,
    conta.pista,
    janelaMs,
  );
  if (distintas === null || distintas < max) return null;

  return {
    regra: 'credential_stuffing',
    severidade: SEVERIDADE_POR_REGRA.credential_stuffing,
    sujeito: origem,
    ocorrencias: distintas,
    janelaMs,
    metadata: { tipo_de_evento: evento.type, contas_distintas: String(distintas) },
  };
};

export const varreduraDeCliente: RegraDeDeteccao = async (evento, contexto) => {
  if (evento.type !== 'iam.oauth.token_denied') return null;
  // Só a recusa de credencial interessa: escopo inválido e grant não autorizado são erro de
  // integração, e contá-los junto encheria o alarme de ruído de quem está só configurando.
  if (evento.metadata?.erro !== 'invalid_client') return null;
  const sujeito = contexto.extrator.doAtor(evento);
  if (sujeito === null) return null;

  const { varreduraDeClienteMax: max, varreduraDeClienteJanelaMs: janelaMs } = contexto.limiares;
  const total = await contar(contexto, `sec:varredura_de_cliente:${sujeito.pista}`, janelaMs);
  if (total === null || total < max) return null;

  return {
    regra: 'varredura_de_cliente',
    severidade: SEVERIDADE_POR_REGRA.varredura_de_cliente,
    sujeito,
    ocorrencias: total,
    janelaMs,
    metadata: { tipo_de_evento: evento.type },
  };
};

/**
 * Reuso de refresh: limiar 1, sem contador.
 *
 * A família já caiu quando este evento existe — a SPEC 005 só o emite depois de descartar a
 * corrida legítima. Uma única ocorrência já é indício de roubo; exigir estatística aqui seria
 * esperar o segundo roubo para avisar do primeiro.
 */
export const reusoDeRefresh: RegraDeDeteccao = (evento, contexto) => {
  if (evento.type !== 'iam.token.reuse_detected') return Promise.resolve(null);
  const sujeito = contexto.extrator.doAtor(evento);
  if (sujeito === null) return Promise.resolve(null);

  return Promise.resolve({
    regra: 'reuso_de_refresh',
    severidade: SEVERIDADE_POR_REGRA.reuso_de_refresh,
    sujeito,
    ocorrencias: 1,
    janelaMs: 0,
    metadata: { tipo_de_evento: evento.type },
  });
};

export const mfaSobAtaque: RegraDeDeteccao = async (evento, contexto) => {
  if (evento.type !== 'iam.mfa.failed') return null;
  const sujeito = contexto.extrator.doAtor(evento);
  if (sujeito === null) return null;

  const { mfaFalhasMax: max, mfaJanelaMs: janelaMs } = contexto.limiares;
  const total = await contar(contexto, `sec:mfa_sob_ataque:${sujeito.pista}`, janelaMs);
  if (total === null || total < max) return null;

  return {
    regra: 'mfa_sob_ataque',
    severidade: SEVERIDADE_POR_REGRA.mfa_sob_ataque,
    sujeito,
    ocorrencias: total,
    janelaMs,
    metadata: { tipo_de_evento: evento.type },
  };
};

export const REGRAS_PADRAO: readonly RegraDeDeteccao[] = [
  bruteForceConta,
  credentialStuffing,
  varreduraDeCliente,
  reusoDeRefresh,
  mfaSobAtaque,
];
