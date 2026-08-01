/**
 * Responsabilidade: guards de autorização (`preHandler` Fastify) que rodam depois do
 * `verificarAccessToken` — este autentica; o guard só decide se o já-autenticado pode.
 * Consumido por: as rotas do RBAC e, futuramente, do painel admin (018) e clientes (011).
 * Regras:
 *  - **Fail closed**: sem `request.usuario`, ou com `permissions`/`roles` que não são array,
 *    a resposta é 403 — nunca 500, nunca passa.
 *  - `exigirPermissao(...requeridas)` exige TODAS as permissões (AND). Curinga: `*` (super)
 *    e `recurso:*` satisfazem qualquer verificação daquele recurso.
 *  - `exigirPapel(...papeis)` passa se o usuário tem QUALQUER um dos papéis (OR) — é como a
 *    restrição "só superadmin" (RF-09) é imposta: `exigirPapel('superadmin')`.
 *  - 403 no formato problem+json; a permissão exigida vira rótulo da métrica de negação.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { medidorDeRbacNulo, type MedidorDeRbac } from '../metrics/rbac.metrics.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export type GuardDeAutorizacao = (
  requisicao: FastifyRequest,
  resposta: FastifyReply,
) => Promise<void>;

/** Recurso de uma permissão `recurso:acao` (o prefixo antes do primeiro `:`). */
function recursoDe(permissao: string): string {
  const i = permissao.indexOf(':');
  return i === -1 ? permissao : permissao.slice(0, i);
}

/** `true` se `perms` satisfaz `requerida`: exata, curinga de recurso (`recurso:*`) ou `*`. */
export function satisfaz(requerida: string, perms: readonly string[]): boolean {
  if (perms.includes('*')) return true;
  if (perms.includes(requerida)) return true;
  return perms.includes(`${recursoDe(requerida)}:*`);
}

export interface DependenciasDoGuard {
  readonly medidor?: MedidorDeRbac;
}

export interface GuardsDeAutorizacao {
  // Propriedades-função (não métodos): são fábricas puras, destináveis sem `this`.
  readonly exigirPermissao: (...requeridas: string[]) => GuardDeAutorizacao;
  readonly exigirPapel: (...papeis: string[]) => GuardDeAutorizacao;
}

export function criarGuardsDeAutorizacao(deps: DependenciasDoGuard = {}): GuardsDeAutorizacao {
  const medidor = deps.medidor ?? medidorDeRbacNulo();

  async function negar(resposta: FastifyReply, rotulo: string): Promise<void> {
    medidor.contarNegacao(rotulo);
    await resposta
      .status(403)
      .type(TIPO_PROBLEM_JSON)
      .send(montarProblema('authorization-denied', 'Acesso negado', 403));
  }

  return {
    exigirPermissao(...requeridas: string[]): GuardDeAutorizacao {
      return async (requisicao, resposta): Promise<void> => {
        const inicio = process.hrtime.bigint();
        const perms = requisicao.usuario?.permissions;
        if (!Array.isArray(perms)) {
          await negar(resposta, requeridas[0] ?? '');
          return;
        }
        const faltou = requeridas.find((r) => !satisfaz(r, perms));
        medidor.observarVerificacao(Number(process.hrtime.bigint() - inicio) / 1e9);
        if (faltou !== undefined) {
          await negar(resposta, faltou);
        }
      };
    },

    exigirPapel(...papeis: string[]): GuardDeAutorizacao {
      return async (requisicao, resposta): Promise<void> => {
        const roles = requisicao.usuario?.roles;
        if (!Array.isArray(roles) || !papeis.some((p) => roles.includes(p))) {
          await negar(resposta, papeis[0] ?? '');
        }
      };
    },
  };
}
