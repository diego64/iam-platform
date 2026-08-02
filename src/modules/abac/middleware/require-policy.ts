/**
 * Responsabilidade: o PEP — `preHandler` Fastify que carrega o recurso, monta o contexto e
 * deixa o PDP decidir.
 * Consumido por: endpoints que precisam de condição por atributo (posse, janela, faixa de IP).
 * Regras:
 *  - Encadeia **depois** de `verificarAccessToken` (autentica) e, quando houver, de
 *    `exigirPermissao` (autoriza grosso). Sem token a resposta tem de ser 401 do middleware
 *    de autenticação, não 403 daqui — por isso este guard nunca vem primeiro na cadeia.
 *  - `carregarRecurso` devolvendo `null` ⇒ **404**, resolvido **antes** da política: se o
 *    inexistente respondesse 403, o par (403, 404) viraria oráculo de existência.
 *  - **Fail closed**: usuário ausente, decisão `deny` ou qualquer exceção no caminho ⇒ 403
 *    genérico. Nunca 500, porque um 500 num guard é um caminho não decidido.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import type { MotorDePoliticas } from '../services/policy-engine.js';
import type { ContextoDeDecisao, JsonValue } from '../types/abac.types.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

/** Atributos do recurso alvo, ou `null` quando ele não existe. */
export type CarregadorDeRecurso = (
  requisicao: FastifyRequest,
) => Promise<Record<string, JsonValue> | null>;

export type GuardDePolitica = (requisicao: FastifyRequest, resposta: FastifyReply) => Promise<void>;

export interface DependenciasDoPep {
  readonly motor: Pick<MotorDePoliticas, 'avaliar'>;
  /** Registra a decisão para auditoria. Opcional para manter o guard testável sem logger. */
  readonly registrarDecisao?: (registro: {
    sujeito_id: string;
    resource_type: string;
    acao: string;
    effect: string;
    policy_id?: string;
  }) => void;
}

export interface GuardsDePolitica {
  readonly exigirPolitica: (
    tipoRecurso: string,
    acao: string,
    carregarRecurso: CarregadorDeRecurso,
  ) => GuardDePolitica;
}

export function criarGuardsDePolitica(deps: DependenciasDoPep): GuardsDePolitica {
  async function negar(resposta: FastifyReply): Promise<void> {
    await resposta
      .status(403)
      .type(TIPO_PROBLEM_JSON)
      .send(montarProblema('authorization-denied', 'Acesso negado', 403));
  }

  async function naoEncontrado(resposta: FastifyReply): Promise<void> {
    await resposta
      .status(404)
      .type(TIPO_PROBLEM_JSON)
      .send(montarProblema('resource-not-found', 'Recurso não encontrado', 404));
  }

  return {
    exigirPolitica(tipoRecurso, acao, carregarRecurso): GuardDePolitica {
      return async (requisicao, resposta): Promise<void> => {
        const usuario = requisicao.usuario;
        if (usuario === undefined) {
          // Só acontece se o guard foi encadeado antes da autenticação — ordem errada
          // fecha, não abre.
          await negar(resposta);
          return;
        }

        let recurso: Record<string, JsonValue> | null;
        try {
          recurso = await carregarRecurso(requisicao);
        } catch {
          await negar(resposta);
          return;
        }

        if (recurso === null) {
          await naoEncontrado(resposta);
          return;
        }

        const contexto: ContextoDeDecisao = {
          subject: { sub: usuario.id, roles: usuario.roles, perm: usuario.permissions },
          resourceType: tipoRecurso,
          resource: recurso,
          action: acao,
          env: { ip: requisicao.ip, now: new Date() },
        };

        try {
          const decisao = await deps.motor.avaliar(contexto);
          deps.registrarDecisao?.({
            sujeito_id: usuario.id,
            resource_type: tipoRecurso,
            acao,
            effect: decisao.effect,
            ...(decisao.policyId === undefined ? {} : { policy_id: decisao.policyId }),
          });
          if (decisao.effect !== 'permit') await negar(resposta);
        } catch {
          // Falha ao decidir (banco fora, política corrompida) é negação, não 500.
          await negar(resposta);
        }
      };
    },
  };
}
