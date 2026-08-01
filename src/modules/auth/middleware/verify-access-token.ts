/**
 * Responsabilidade: preHandler que valida o access token e anexa `request.usuario`.
 * Consumido por: as rotas autenticadas (`/auth/logout`, `/auth/me`) e, como porta de
 * autenticação, o módulo de senha.
 * Regras:
 *  - Verificação fixa em `algorithms: ['EdDSA']`, com `issuer` e `audience` obrigatórios —
 *    sem brecha para `alg: none` ou HS256 forjado.
 *  - Consulta a denylist por `jti` com fail closed: erro na consulta rejeita o token, nunca
 *    deixa passar por indisponibilidade do Mongo.
 *  - Falha responde 401 problem+json com motivo genérico; o detalhe fica no fluxo de quem
 *    chamou, nunca na resposta.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import type { UsuarioAutenticado } from '../types/auth.types.js';
import type { JwksService } from '../../jwks/index.js';
import type { RepositorioDeDenylist } from '../repositories/token-denylist.repository.js';

declare module 'fastify' {
  interface FastifyRequest {
    usuario?: UsuarioAutenticado;
    /** Claims do token corrente necessários ao logout (revogar o `jti` até o `exp`). */
    tokenAtual?: { readonly jti: string; readonly exp: number };
  }
}

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDeVerificacao {
  readonly jwks: Pick<JwksService, 'obterConjuntoDeVerificacao'>;
  readonly denylist: RepositorioDeDenylist;
  readonly emissor: string;
  readonly audiencia: string;
}

/** Extrai o token do cabeçalho `Authorization: Bearer <token>`. */
function extrairBearer(cabecalho: string | undefined): string | null {
  if (cabecalho === undefined) return null;
  const [tipo, valor] = cabecalho.split(' ');
  return tipo === 'Bearer' && valor !== undefined && valor !== '' ? valor : null;
}

async function recusar(
  resposta: FastifyReply,
  slug: 'invalid-token' | 'token-revoked',
): Promise<void> {
  const titulo = slug === 'invalid-token' ? 'Token inválido' : 'Token revogado';
  await resposta
    .status(401)
    .type(TIPO_PROBLEM_JSON)
    .send(montarProblema(slug, titulo, 401));
}

export type VerificadorDeAccessToken = (
  requisicao: FastifyRequest,
  resposta: FastifyReply,
) => Promise<void>;

export function criarVerificadorDeAccessToken(
  deps: DependenciasDeVerificacao,
): VerificadorDeAccessToken {
  return async function verificar(requisicao, resposta): Promise<void> {
    const token = extrairBearer(requisicao.headers.authorization);
    if (token === null) {
      await recusar(resposta, 'invalid-token');
      return;
    }

    let sub: unknown;
    let jti: unknown;
    let exp: unknown;
    let roles: unknown;
    let perm: unknown;
    let scope: unknown;
    try {
      const conjunto = await deps.jwks.obterConjuntoDeVerificacao();
      const { payload } = await jwtVerify(token, conjunto, {
        algorithms: ['EdDSA'],
        issuer: deps.emissor,
        audience: deps.audiencia,
      });
      ({ sub, jti, exp, roles, perm, scope } = payload);
    } catch {
      await recusar(resposta, 'invalid-token');
      return;
    }

    if (typeof jti !== 'string' || typeof sub !== 'string' || typeof exp !== 'number') {
      await recusar(resposta, 'invalid-token');
      return;
    }

    // Fail closed: qualquer erro na denylist rejeita o token.
    try {
      if (await deps.denylist.estaRevogado(jti)) {
        await recusar(resposta, 'token-revoked');
        return;
      }
    } catch {
      await recusar(resposta, 'token-revoked');
      return;
    }

    requisicao.usuario = {
      id: sub,
      roles: Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [],
      permissions: Array.isArray(perm)
        ? perm.filter((p): p is string => typeof p === 'string')
        : [],
      scope: typeof scope === 'string' ? scope : '',
    };
    requisicao.tokenAtual = { jti, exp };
  };
}

/** Id do usuário autenticado, ou `null` — cumpre a porta de autenticação do módulo de senha. */
export function idAutenticado(requisicao: FastifyRequest): string | null {
  return requisicao.usuario?.id ?? null;
}
